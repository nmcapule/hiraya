package syncapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

var errTooLarge = errors.New("request exceeds upload limit")

type Server struct {
	store     *Store
	staticDir string
	maxUpload int64
	now       func() time.Time
	handler   http.Handler
}

func New(store *Store, staticDir string, maxUpload int64) *Server {
	s := &Server{store: store, staticDir: staticDir, maxUpload: maxUpload, now: time.Now}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, _ *http.Request) {
		workspace := s.store.snapshot()
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "revision": workspace.Revision, "schemaVersion": workspace.SchemaVersion, "workspaceId": workspace.WorkspaceID})
	})
	mux.HandleFunc("GET /api/workspace", s.getWorkspace)
	mux.HandleFunc("GET /api/activity", s.getActivity)
	mux.HandleFunc("POST /api/bootstrap", s.bootstrap)
	mux.HandleFunc("POST /api/imports", s.importEntries)
	mux.HandleFunc("POST /api/entries", s.upsertEntry)
	mux.HandleFunc("POST /api/entries/batch-move", s.batchMoveEntries)
	mux.HandleFunc("POST /api/entries/batch-delete", s.batchDeleteEntries)
	mux.HandleFunc("PATCH /api/entries/{id}", s.patchEntry)
	mux.HandleFunc("DELETE /api/entries/{id}", s.deleteEntry)
	mux.HandleFunc("GET /api/files/{id}/content", s.getContent)
	mux.HandleFunc("PUT /api/files/{id}/content", s.putContent)
	mux.HandleFunc("PUT /api/layout", s.putLayout)
	mux.HandleFunc("PUT /api/desktop-positions", s.putDesktopPositions)
	mux.HandleFunc("PUT /api/editor-settings", s.putSettings)
	mux.HandleFunc("PUT /api/theme-selection", s.putThemeSelection)
	mux.HandleFunc("PUT /api/themes/{id}", s.putTheme)
	mux.HandleFunc("DELETE /api/themes/{id}", s.deleteTheme)
	mux.HandleFunc("GET /api/events", s.events)
	mux.HandleFunc("/api/", func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, http.StatusNotFound, "API endpoint not found")
	})
	mux.HandleFunc("/", s.static)
	s.handler = s.idempotency(mux)
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.handler.ServeHTTP(w, r)
}

func (s *Server) getWorkspace(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.store.snapshot())
}

func (s *Server) bootstrap(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, s.maxUpload+1<<20)
	reader, err := r.MultipartReader()
	if err != nil {
		writeError(w, http.StatusBadRequest, "expected multipart request")
		return
	}
	var input bootstrapWorkspace
	var gotWorkspace bool
	type upload struct {
		id   string
		path string
		size int64
	}
	uploads := make(map[string]upload)
	tmpDir, err := os.MkdirTemp(s.store.dir, ".bootstrap-*")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not stage bootstrap")
		return
	}
	defer os.RemoveAll(tmpDir)
	var total int64
	for {
		part, nextErr := reader.NextPart()
		if errors.Is(nextErr, io.EOF) {
			break
		}
		if nextErr != nil {
			writeError(w, statusForReadError(nextErr), "invalid multipart request")
			return
		}
		name := part.FormName()
		partReader := hashMultipartPart(r, name, part.FileName(), part)
		if name == "workspace" {
			if gotWorkspace || part.FileName() != "" || decodeJSONReader(partReader, &input, 4<<20) != nil {
				part.Close()
				writeError(w, http.StatusBadRequest, "invalid workspace part")
				return
			}
			gotWorkspace = true
		} else if strings.HasPrefix(name, "file-") {
			id := strings.TrimPrefix(name, "file-")
			if !validID(id) || uploads[id].id != "" {
				part.Close()
				writeError(w, http.StatusBadRequest, "invalid or duplicate file part")
				return
			}
			path := filepath.Join(tmpDir, strconv.Itoa(len(uploads)))
			file, createErr := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
			if createErr != nil {
				part.Close()
				writeError(w, http.StatusInternalServerError, "could not stage file")
				return
			}
			n, copyErr := io.Copy(file, io.LimitReader(partReader, s.maxUpload-total+1))
			closeErr := file.Close()
			if copyErr != nil || closeErr != nil || total+n > s.maxUpload {
				part.Close()
				writeError(w, http.StatusRequestEntityTooLarge, "upload exceeds configured limit")
				return
			}
			total += n
			uploads[id] = upload{id: id, path: path, size: n}
		} else {
			part.Close()
			writeError(w, http.StatusBadRequest, "unexpected multipart part")
			return
		}
		part.Close()
	}
	if !gotWorkspace {
		writeError(w, http.StatusBadRequest, "workspace part is required")
		return
	}
	if err := validateLayout(input.Layout); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := validateSettings(input.EditorSettings); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	appearance := defaultAppearance()
	if input.Appearance.SelectedThemeID != "" {
		appearance.SelectedThemeID = input.Appearance.SelectedThemeID
	}
	appearance.CustomThemes = make([]CustomTheme, len(input.Appearance.CustomThemes))
	for i, theme := range input.Appearance.CustomThemes {
		appearance.CustomThemes[i] = CustomTheme{ID: theme.ID, Name: theme.Name, Definition: theme.Definition, Revision: 1}
	}
	appearance.SelectionRevision = 1
	if err := validateWorkspace(input.Entries, input.Layout, appearance); err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	for i := range input.Entries {
		e := &input.Entries[i]
		if e.Kind == "file" {
			u, ok := uploads[e.ID]
			if !ok || u.size != e.Size {
				writeError(w, http.StatusConflict, "file parts must match file entries and sizes")
				return
			}
		} else if _, ok := uploads[e.ID]; ok {
			writeError(w, http.StatusConflict, "folder cannot have file content")
			return
		}
	}
	if len(uploads) != countFiles(input.Entries) {
		writeError(w, http.StatusConflict, "file parts must match file entries")
		return
	}

	s.store.mu.Lock()
	w, unlock := unlockBeforeResponse(w, s.store.mu.Unlock)
	defer unlock()
	if s.replayMutationLocked(w, r) {
		return
	}
	if s.store.workspace.Initialized {
		writeError(w, http.StatusConflict, "workspace is already initialized")
		return
	}
	promoted := make([]string, 0, len(uploads))
	committed := false
	defer func() {
		if !committed {
			for _, id := range promoted {
				_ = os.Remove(filepath.Join(s.store.filesDir, id))
			}
		}
	}()
	for i := range input.Entries {
		e := &input.Entries[i]
		e.Revision = 1
		e.ContentRevision = 0
		e.ModifiedAt = s.now().UnixMilli()
		if e.Kind == "file" {
			e.ContentRevision = 1
			u := uploads[e.ID]
			target := filepath.Join(s.store.filesDir, e.ID)
			if ensureNoSymlink(s.store.dir, target) != nil {
				writeError(w, http.StatusConflict, "invalid bootstrap blob path")
				return
			}
			if _, err := os.Lstat(target); !errors.Is(err, os.ErrNotExist) {
				for _, id := range promoted {
					_ = os.Remove(filepath.Join(s.store.filesDir, id))
				}
				writeError(w, http.StatusConflict, "bootstrap blob already exists")
				return
			}
			f, openErr := os.Open(u.path)
			if openErr != nil {
				writeError(w, http.StatusInternalServerError, "could not read staged file")
				return
			}
			promoted = append(promoted, e.ID)
			_, copyErr := atomicCopy(target, f, s.maxUpload)
			f.Close()
			if copyErr != nil {
				for _, id := range promoted {
					_ = os.Remove(filepath.Join(s.store.filesDir, id))
				}
				writeError(w, http.StatusInternalServerError, "could not stage file")
				return
			}
		}
	}
	next := Workspace{SchemaVersion: workspaceSchemaVersion, WorkspaceID: s.store.workspace.WorkspaceID, Initialized: true, Revision: 1, Entries: input.Entries, Layout: input.Layout, LayoutRevision: 1, EditorSettings: input.EditorSettings, SettingsRevision: 1, Appearance: appearance}
	responseBody, err := s.persistMutationLocked(next, r, http.StatusCreated, cloneWorkspace(next))
	if err != nil {
		for _, id := range promoted {
			_ = os.Remove(filepath.Join(s.store.filesDir, id))
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	committed = true
	s.store.publishLocked(1)
	writeJSONBody(w, http.StatusCreated, responseBody)
}

func countFiles(entries []Entry) int {
	n := 0
	for _, entry := range entries {
		if entry.Kind == "file" {
			n++
		}
	}
	return n
}

func (s *Server) importEntries(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, s.maxUpload+4<<20)
	reader, err := r.MultipartReader()
	if err != nil {
		writeError(w, http.StatusBadRequest, "expected multipart request")
		return
	}
	type upload struct {
		path string
		size int64
	}
	var entries []Entry
	var gotEntries bool
	uploads := make(map[string]upload)
	tmpDir, err := os.MkdirTemp(s.store.dir, ".import-*")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not stage import")
		return
	}
	defer os.RemoveAll(tmpDir)
	var total int64
	for {
		part, nextErr := reader.NextPart()
		if errors.Is(nextErr, io.EOF) {
			break
		}
		if nextErr != nil {
			writeError(w, statusForReadError(nextErr), "invalid multipart request")
			return
		}
		name := part.FormName()
		partReader := hashMultipartPart(r, name, part.FileName(), part)
		if name == "entries" {
			if gotEntries || part.FileName() != "" || decodeJSONReader(partReader, &entries, 4<<20) != nil {
				part.Close()
				writeError(w, http.StatusBadRequest, "invalid entries part")
				return
			}
			gotEntries = true
		} else if strings.HasPrefix(name, "file-") {
			id := strings.TrimPrefix(name, "file-")
			if !validID(id) {
				part.Close()
				writeError(w, http.StatusBadRequest, "invalid file part ID")
				return
			}
			if _, exists := uploads[id]; exists {
				part.Close()
				writeError(w, http.StatusBadRequest, "duplicate file part")
				return
			}
			path := filepath.Join(tmpDir, strconv.Itoa(len(uploads)))
			file, createErr := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
			if createErr != nil {
				part.Close()
				writeError(w, http.StatusInternalServerError, "could not stage file")
				return
			}
			n, copyErr := io.Copy(file, io.LimitReader(partReader, s.maxUpload-total+1))
			closeErr := file.Close()
			if copyErr != nil || closeErr != nil || total+n > s.maxUpload {
				part.Close()
				writeError(w, http.StatusRequestEntityTooLarge, "upload exceeds configured limit")
				return
			}
			total += n
			uploads[id] = upload{path: path, size: n}
		} else {
			part.Close()
			writeError(w, http.StatusBadRequest, "unexpected multipart part")
			return
		}
		part.Close()
	}
	if !gotEntries {
		writeError(w, http.StatusBadRequest, "entries part is required")
		return
	}
	if len(entries) == 0 {
		writeError(w, http.StatusBadRequest, "at least one entry is required")
		return
	}
	entryIDs := make(map[string]bool, len(entries))
	for _, entry := range entries {
		if entryIDs[entry.ID] {
			writeError(w, http.StatusConflict, "import contains duplicate entry IDs")
			return
		}
		entryIDs[entry.ID] = true
		if entry.Kind == "file" {
			upload, ok := uploads[entry.ID]
			if !ok || upload.size != entry.Size {
				writeError(w, http.StatusConflict, "file parts must match entries and declared sizes")
				return
			}
		} else if _, ok := uploads[entry.ID]; ok {
			writeError(w, http.StatusConflict, "folder cannot have file content")
			return
		}
	}
	if len(uploads) != countFiles(entries) {
		writeError(w, http.StatusConflict, "file parts must match entries")
		return
	}

	s.store.mu.Lock()
	w, unlock := unlockBeforeResponse(w, s.store.mu.Unlock)
	defer unlock()
	if s.replayMutationLocked(w, r) {
		return
	}
	if !s.requireInitializedLocked(w) {
		return
	}
	next := cloneWorkspace(s.store.workspace)
	revision := next.Revision + 1
	modifiedAt := s.now().UnixMilli()
	for i := range entries {
		if entryIndex(next.Entries, entries[i].ID) >= 0 {
			writeError(w, http.StatusConflict, "import entry ID already exists")
			return
		}
		entries[i].Revision = revision
		entries[i].ContentRevision = 0
		if entries[i].Kind == "file" {
			entries[i].ContentRevision = revision
		}
		entries[i].ModifiedAt = modifiedAt
	}
	next.Entries = append(next.Entries, entries...)
	if err := validateWorkspace(next.Entries, next.Layout, next.Appearance); err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	targets := make(map[string]string, len(entries))
	for _, entry := range entries {
		target := filepath.Join(s.store.filesDir, entry.ID)
		targets[entry.ID] = target
		if entry.Kind == "file" {
			if ensureNoSymlink(s.store.dir, target) != nil {
				writeError(w, http.StatusConflict, "invalid import blob path")
				return
			}
			if _, err := os.Lstat(target); !errors.Is(err, os.ErrNotExist) {
				writeError(w, http.StatusConflict, "import blob already exists")
				return
			}
		}
	}
	promoted := make([]string, 0, len(uploads))
	committed := false
	defer func() {
		if !committed {
			for _, id := range promoted {
				_ = os.Remove(targets[id])
			}
		}
	}()
	for _, entry := range entries {
		if entry.Kind != "file" {
			continue
		}
		file, openErr := os.Open(uploads[entry.ID].path)
		if openErr != nil {
			writeError(w, http.StatusInternalServerError, "could not read staged file")
			return
		}
		promoted = append(promoted, entry.ID)
		_, copyErr := atomicCopy(targets[entry.ID], file, s.maxUpload)
		file.Close()
		if copyErr != nil {
			for _, id := range promoted {
				_ = os.Remove(targets[id])
			}
			writeError(w, http.StatusInternalServerError, "could not persist imported file")
			return
		}
	}
	next.Revision = revision
	result := importResponse{Revision: revision, Entries: entries}
	responseBody, err := s.persistMutationLocked(next, r, http.StatusOK, result)
	if err != nil {
		for _, id := range promoted {
			_ = os.Remove(targets[id])
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	committed = true
	s.store.publishLocked(revision)
	writeJSONBody(w, http.StatusOK, responseBody)
}

func (s *Server) upsertEntry(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, s.maxUpload+1<<20)
	reader, err := r.MultipartReader()
	if err != nil {
		writeError(w, http.StatusBadRequest, "expected multipart request")
		return
	}
	var entry Entry
	var gotEntry, gotContent bool
	var contentPath string
	var contentSize int64
	tmpDir, err := os.MkdirTemp(s.store.dir, ".entry-*")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not stage entry")
		return
	}
	defer os.RemoveAll(tmpDir)
	for {
		part, nextErr := reader.NextPart()
		if errors.Is(nextErr, io.EOF) {
			break
		}
		if nextErr != nil {
			writeError(w, statusForReadError(nextErr), "invalid multipart request")
			return
		}
		name := part.FormName()
		partReader := hashMultipartPart(r, name, part.FileName(), part)
		switch name {
		case "entry":
			if gotEntry || decodeJSONReader(partReader, &entry, 1<<20) != nil {
				part.Close()
				writeError(w, http.StatusBadRequest, "invalid entry part")
				return
			}
			gotEntry = true
		case "content":
			if gotContent {
				part.Close()
				writeError(w, http.StatusBadRequest, "duplicate content part")
				return
			}
			contentPath = filepath.Join(tmpDir, "content")
			f, createErr := os.OpenFile(contentPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
			if createErr != nil {
				part.Close()
				writeError(w, http.StatusInternalServerError, "could not stage content")
				return
			}
			n, copyErr := io.Copy(f, io.LimitReader(partReader, s.maxUpload+1))
			closeErr := f.Close()
			if copyErr != nil || closeErr != nil || n > s.maxUpload {
				part.Close()
				writeError(w, http.StatusRequestEntityTooLarge, "upload exceeds configured limit")
				return
			}
			contentSize = n
			gotContent = true
		default:
			part.Close()
			writeError(w, http.StatusBadRequest, "unexpected multipart part")
			return
		}
		part.Close()
	}
	if !gotEntry {
		writeError(w, http.StatusBadRequest, "entry part is required")
		return
	}
	if gotContent {
		entry.Size = contentSize
	}
	s.store.mu.Lock()
	w, unlock := unlockBeforeResponse(w, s.store.mu.Unlock)
	defer unlock()
	if s.replayMutationLocked(w, r) {
		return
	}
	if !s.requireInitializedLocked(w) {
		return
	}
	next := cloneWorkspace(s.store.workspace)
	idx := entryIndex(next.Entries, entry.ID)
	var old Entry
	if idx >= 0 {
		old = next.Entries[idx]
		if old.Kind != entry.Kind {
			writeError(w, http.StatusConflict, "entry kind cannot be changed")
			return
		}
		if entry.Kind == "file" && !gotContent {
			entry.Size = old.Size
			entry.ContentRevision = old.ContentRevision
		}
	} else if entry.Kind == "file" && !gotContent && entry.Size != 0 {
		writeError(w, http.StatusConflict, "new non-empty file requires content")
		return
	}
	if entry.Kind == "folder" && gotContent {
		writeError(w, http.StatusConflict, "folder cannot have content")
		return
	}
	entry.Revision = next.Revision + 1
	entry.ContentRevision = 0
	entry.ModifiedAt = s.now().UnixMilli()
	if entry.Kind == "file" {
		if idx >= 0 && !gotContent {
			entry.ContentRevision = old.ContentRevision
		} else {
			entry.ContentRevision = next.Revision + 1
		}
	}
	if idx < 0 {
		next.Entries = append(next.Entries, entry)
	} else {
		next.Entries[idx] = entry
	}
	if err := validateWorkspace(next.Entries, next.Layout, next.Appearance); err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	target, pathErr := s.store.entryPathLocked(next.Entries, entry.ID)
	if pathErr != nil || ensureNoSymlink(s.store.dir, target) != nil {
		writeError(w, http.StatusConflict, "invalid entry path")
		return
	}
	var replacement *contentReplacement
	if entry.Kind == "file" && (gotContent || idx < 0) {
		if idx < 0 {
			if _, err := os.Lstat(target); !errors.Is(err, os.ErrNotExist) {
				writeError(w, http.StatusConflict, "entry path already exists")
				return
			}
		}
		source := contentPath
		if !gotContent {
			source = os.DevNull
		}
		replacement, err = replaceFileContent(target, source, s.store.dir, s.maxUpload)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "could not persist content")
			return
		}
	}
	next.Revision++
	result := entryResponse{Revision: next.Revision, Entry: entry}
	responseBody, err := s.persistMutationLocked(next, r, http.StatusOK, result)
	if err != nil {
		if replacement != nil {
			if rollbackErr := replacement.rollback(); rollbackErr != nil {
				slog.Error("could not roll back failed content replacement", "path", target, "error", rollbackErr)
			}
		}
		if idx < 0 {
			_ = os.Remove(target)
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if replacement != nil {
		if err := replacement.commit(); err != nil {
			slog.Warn("could not remove replaced content backup", "path", replacement.backup, "error", err)
		}
	}
	s.store.publishLocked(next.Revision)
	writeJSONBody(w, http.StatusOK, responseBody)
}

func (s *Server) patchEntry(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !validID(id) {
		writeError(w, http.StatusBadRequest, "invalid entry ID")
		return
	}
	var entry Entry
	if err := decodeJSON(w, r, &entry, 1<<20); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if entry.ID != id {
		writeError(w, http.StatusBadRequest, "entry ID does not match URL")
		return
	}
	s.store.mu.Lock()
	w, unlock := unlockBeforeResponse(w, s.store.mu.Unlock)
	defer unlock()
	if s.replayMutationLocked(w, r) {
		return
	}
	if !s.requireInitializedLocked(w) {
		return
	}
	next := cloneWorkspace(s.store.workspace)
	idx := entryIndex(next.Entries, id)
	if idx < 0 {
		writeError(w, http.StatusNotFound, "entry not found")
		return
	}
	old := next.Entries[idx]
	if entry.Kind != old.Kind {
		writeError(w, http.StatusConflict, "entry kind cannot be changed")
		return
	}
	if entry.Kind == "file" {
		// Size and content revision describe the retained server blob, not stale client metadata.
		entry.Size = old.Size
		entry.ContentRevision = old.ContentRevision
	} else {
		entry.ContentRevision = 0
	}
	entry.ModifiedAt = s.now().UnixMilli()
	entry.Revision = next.Revision + 1
	next.Entries[idx] = entry
	if err := validateWorkspace(next.Entries, next.Layout, next.Appearance); err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	next.Revision++
	result := entryResponse{Revision: next.Revision, Entry: entry}
	responseBody, err := s.persistMutationLocked(next, r, http.StatusOK, result)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.store.publishLocked(next.Revision)
	writeJSONBody(w, http.StatusOK, responseBody)
}

func (s *Server) batchMoveEntries(w http.ResponseWriter, r *http.Request) {
	var input batchMoveRequest
	if err := decodeJSON(w, r, &input, 1<<20); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(input.EntryIDs) == 0 || input.ParentID != nil && !validID(*input.ParentID) {
		writeError(w, http.StatusBadRequest, "invalid batch move")
		return
	}
	selected := make(map[string]bool, len(input.EntryIDs))
	for _, id := range input.EntryIDs {
		if !validID(id) || selected[id] {
			writeError(w, http.StatusBadRequest, "entry IDs must be valid and unique")
			return
		}
		selected[id] = true
	}

	s.store.mu.Lock()
	w, unlock := unlockBeforeResponse(w, s.store.mu.Unlock)
	defer unlock()
	if s.replayMutationLocked(w, r) {
		return
	}
	if !s.requireInitializedLocked(w) {
		return
	}
	next := cloneWorkspace(s.store.workspace)
	if input.ParentID != nil {
		idx := entryIndex(next.Entries, *input.ParentID)
		if idx < 0 {
			writeError(w, http.StatusNotFound, "destination folder not found")
			return
		}
		if next.Entries[idx].Kind != "folder" {
			writeError(w, http.StatusConflict, "destination must be a folder")
			return
		}
	}
	for _, id := range input.EntryIDs {
		idx := entryIndex(next.Entries, id)
		if idx < 0 {
			writeError(w, http.StatusNotFound, "entry not found")
			return
		}
		for parentID := next.Entries[idx].ParentID; parentID != nil; {
			if selected[*parentID] {
				writeError(w, http.StatusBadRequest, "batch move cannot include both an entry and its descendant")
				return
			}
			parent := entryIndex(next.Entries, *parentID)
			if parent < 0 {
				break
			}
			parentID = next.Entries[parent].ParentID
		}
	}

	revision := next.Revision + 1
	modifiedAt := s.now().UnixMilli()
	movedEntries := make([]Entry, 0, len(input.EntryIDs))
	for _, id := range input.EntryIDs {
		idx := entryIndex(next.Entries, id)
		next.Entries[idx].ParentID = input.ParentID
		next.Entries[idx].Revision = revision
		next.Entries[idx].ModifiedAt = modifiedAt
		movedEntries = append(movedEntries, next.Entries[idx])
	}
	if err := validateWorkspace(next.Entries, next.Layout, next.Appearance); err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	next.Revision = revision
	result := batchMoveResponse{Revision: revision, Entries: movedEntries}
	responseBody, err := s.persistMutationLocked(next, r, http.StatusOK, result)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.store.publishLocked(revision)
	writeJSONBody(w, http.StatusOK, responseBody)
}

func (s *Server) batchDeleteEntries(w http.ResponseWriter, r *http.Request) {
	var input batchDeleteRequest
	if err := decodeJSON(w, r, &input, 1<<20); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(input.EntryIDs) == 0 {
		writeError(w, http.StatusBadRequest, "at least one entry ID is required")
		return
	}
	requested := make(map[string]bool, len(input.EntryIDs))
	for _, id := range input.EntryIDs {
		if !validID(id) || requested[id] {
			writeError(w, http.StatusBadRequest, "entry IDs must be valid and unique")
			return
		}
		requested[id] = true
	}

	s.store.mu.Lock()
	w, unlock := unlockBeforeResponse(w, s.store.mu.Unlock)
	defer unlock()
	if s.replayMutationLocked(w, r) {
		return
	}
	if !s.requireInitializedLocked(w) {
		return
	}
	for _, id := range input.EntryIDs {
		if entryIndex(s.store.workspace.Entries, id) < 0 {
			writeError(w, http.StatusNotFound, "entry not found")
			return
		}
	}
	deleted := make(map[string]bool, len(requested))
	for id := range requested {
		deleted[id] = true
	}
	for changed := true; changed; {
		changed = false
		for _, entry := range s.store.workspace.Entries {
			if entry.ParentID != nil && deleted[*entry.ParentID] && !deleted[entry.ID] {
				deleted[entry.ID] = true
				changed = true
			}
		}
	}
	deletePaths := make([]string, 0, len(deleted))
	next := cloneWorkspace(s.store.workspace)
	kept := make([]Entry, 0, len(next.Entries)-len(deleted))
	deletedIDs := make([]string, 0, len(deleted))
	for _, entry := range next.Entries {
		if deleted[entry.ID] {
			deletedIDs = append(deletedIDs, entry.ID)
			if entry.Kind == "file" {
				deletePaths = append(deletePaths, filepath.Join(s.store.filesDir, entry.ID))
			}
		} else {
			kept = append(kept, entry)
		}
	}
	next.Entries = kept
	next.Revision++
	result := deleteResponse{Revision: next.Revision, DeletedIDs: deletedIDs}
	responseBody, err := s.persistMutationLocked(next, r, http.StatusOK, result)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.store.publishLocked(next.Revision)
	for _, path := range deletePaths {
		if err := ensureNoSymlink(s.store.dir, path); err != nil {
			slog.Warn("could not safely clean up deleted blob", "path", path, "error", err)
			continue
		}
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			slog.Warn("could not clean up deleted blob", "path", path, "error", err)
		}
	}
	writeJSONBody(w, http.StatusOK, responseBody)
}

func (s *Server) putContent(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !validID(id) {
		writeError(w, http.StatusBadRequest, "invalid entry ID")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, s.maxUpload)
	tmp, err := os.CreateTemp(s.store.dir, ".content-*")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not stage content")
		return
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	n, copyErr := io.Copy(tmp, r.Body)
	closeErr := tmp.Close()
	if copyErr != nil || closeErr != nil {
		writeError(w, statusForReadError(copyErr), "could not read content")
		return
	}
	contentType := r.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	s.store.mu.Lock()
	w, unlock := unlockBeforeResponse(w, s.store.mu.Unlock)
	defer unlock()
	if s.replayMutationLocked(w, r) {
		return
	}
	if !s.requireInitializedLocked(w) {
		return
	}
	next := cloneWorkspace(s.store.workspace)
	idx := entryIndex(next.Entries, id)
	if idx < 0 {
		writeError(w, http.StatusNotFound, "entry not found")
		return
	}
	entry := next.Entries[idx]
	if entry.Kind != "file" {
		writeError(w, http.StatusConflict, "folder does not have content")
		return
	}
	entry.MimeType = contentType
	entry.Size = n
	entry.ModifiedAt = s.now().UnixMilli()
	entry.Revision = next.Revision + 1
	entry.ContentRevision = next.Revision + 1
	next.Entries[idx] = entry
	if err := validateWorkspace(next.Entries, next.Layout, next.Appearance); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	path, pathErr := s.store.entryPathLocked(next.Entries, id)
	if pathErr != nil || ensureNoSymlink(s.store.dir, path) != nil {
		writeError(w, http.StatusConflict, "invalid file path")
		return
	}
	replacement, err := replaceFileContent(path, tmpPath, s.store.dir, s.maxUpload)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not persist content")
		return
	}
	next.Revision++
	result := entryResponse{Revision: next.Revision, Entry: entry}
	responseBody, err := s.persistMutationLocked(next, r, http.StatusOK, result)
	if err != nil {
		if rollbackErr := replacement.rollback(); rollbackErr != nil {
			slog.Error("could not roll back failed content update", "path", path, "error", rollbackErr)
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := replacement.commit(); err != nil {
		slog.Warn("could not remove replaced content backup", "path", replacement.backup, "error", err)
	}
	s.store.publishLocked(next.Revision)
	writeJSONBody(w, http.StatusOK, responseBody)
}

func (s *Server) getContent(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !validID(id) {
		writeError(w, http.StatusBadRequest, "invalid entry ID")
		return
	}
	s.store.mu.RLock()
	idx := entryIndex(s.store.workspace.Entries, id)
	if idx < 0 || s.store.workspace.Entries[idx].Kind != "file" {
		s.store.mu.RUnlock()
		writeError(w, http.StatusNotFound, "file not found")
		return
	}
	entry := s.store.workspace.Entries[idx]
	path, pathErr := s.store.entryPathLocked(s.store.workspace.Entries, id)
	if pathErr != nil || ensureNoSymlink(s.store.dir, path) != nil || regularFile(path, &entry.Size) != nil {
		s.store.mu.RUnlock()
		writeError(w, http.StatusNotFound, "file content not found")
		return
	}
	f, err := openRegularFile(path, &entry.Size)
	if errors.Is(err, os.ErrNotExist) {
		s.store.mu.RUnlock()
		writeError(w, http.StatusNotFound, "file content not found")
		return
	}
	if err != nil {
		s.store.mu.RUnlock()
		writeError(w, http.StatusInternalServerError, "could not read file content")
		return
	}
	s.store.mu.RUnlock()
	defer f.Close()
	w.Header().Set("Content-Type", entry.MimeType)
	w.Header().Set("Content-Length", strconv.FormatInt(entry.Size, 10))
	w.Header().Set("X-Hiraya-Revision", strconv.FormatInt(entry.ContentRevision, 10))
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, f)
}

func (s *Server) deleteEntry(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !validID(id) {
		writeError(w, http.StatusBadRequest, "invalid entry ID")
		return
	}
	s.store.mu.Lock()
	w, unlock := unlockBeforeResponse(w, s.store.mu.Unlock)
	defer unlock()
	if s.replayMutationLocked(w, r) {
		return
	}
	if !s.requireInitializedLocked(w) {
		return
	}
	deletedIndex := entryIndex(s.store.workspace.Entries, id)
	if deletedIndex < 0 {
		writeError(w, http.StatusNotFound, "entry not found")
		return
	}
	deleted := map[string]bool{id: true}
	for changed := true; changed; {
		changed = false
		for _, entry := range s.store.workspace.Entries {
			if entry.ParentID != nil && deleted[*entry.ParentID] && !deleted[entry.ID] {
				deleted[entry.ID] = true
				changed = true
			}
		}
	}
	next := cloneWorkspace(s.store.workspace)
	kept := make([]Entry, 0, len(next.Entries)-len(deleted))
	deletedIDs := make([]string, 0, len(deleted))
	deletePaths := make([]string, 0, len(deleted))
	for _, entry := range next.Entries {
		if deleted[entry.ID] {
			deletedIDs = append(deletedIDs, entry.ID)
			if entry.Kind == "file" {
				deletePaths = append(deletePaths, filepath.Join(s.store.filesDir, entry.ID))
			}
		} else {
			kept = append(kept, entry)
		}
	}
	next.Entries = kept
	next.Revision++
	result := deleteResponse{Revision: next.Revision, DeletedIDs: deletedIDs}
	responseBody, err := s.persistMutationLocked(next, r, http.StatusOK, result)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.store.publishLocked(next.Revision)
	for _, path := range deletePaths {
		if err := ensureNoSymlink(s.store.dir, path); err != nil {
			slog.Warn("could not safely clean up deleted blob", "path", path, "error", err)
			continue
		}
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			slog.Warn("could not clean up deleted blob", "path", path, "error", err)
		}
	}
	writeJSONBody(w, http.StatusOK, responseBody)
}

func (s *Server) putLayout(w http.ResponseWriter, r *http.Request) {
	var layout Layout
	if err := decodeJSON(w, r, &layout, 1<<20); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := validateLayout(layout); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	s.store.mu.Lock()
	w, unlock := unlockBeforeResponse(w, s.store.mu.Unlock)
	defer unlock()
	if s.replayMutationLocked(w, r) {
		return
	}
	if !s.requireInitializedLocked(w) {
		return
	}
	next := cloneWorkspace(s.store.workspace)
	if err := validateWorkspace(next.Entries, layout, next.Appearance); err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	next.Revision++
	next.Layout = layout
	next.LayoutRevision = next.Revision
	result := layoutResponse{Revision: next.Revision, Layout: layout, LayoutRevision: next.LayoutRevision}
	responseBody, err := s.persistMutationLocked(next, r, http.StatusOK, result)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.store.publishLocked(next.Revision)
	writeJSONBody(w, http.StatusOK, responseBody)
}

func (s *Server) putDesktopPositions(w http.ResponseWriter, r *http.Request) {
	var input []desktopPosition
	if err := decodeJSON(w, r, &input, 1<<20); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(input) == 0 {
		writeError(w, http.StatusBadRequest, "at least one desktop position is required")
		return
	}
	seen := make(map[string]bool, len(input))
	for _, position := range input {
		if !validID(position.EntryID) || seen[position.EntryID] {
			writeError(w, http.StatusBadRequest, "invalid or duplicate entry ID")
			return
		}
		if err := validatePosition(position.Position); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		seen[position.EntryID] = true
	}

	s.store.mu.Lock()
	w, unlock := unlockBeforeResponse(w, s.store.mu.Unlock)
	defer unlock()
	if s.replayMutationLocked(w, r) {
		return
	}
	if !s.requireInitializedLocked(w) {
		return
	}
	next := cloneWorkspace(s.store.workspace)
	indexes := make([]int, len(input))
	for i, position := range input {
		indexes[i] = entryIndex(next.Entries, position.EntryID)
		if indexes[i] < 0 {
			writeError(w, http.StatusNotFound, "entry not found")
			return
		}
		if next.Entries[indexes[i]].ParentID != nil {
			writeError(w, http.StatusConflict, "desktop positions require root entries")
			return
		}
	}
	revision := next.Revision + 1
	next.Revision = revision
	entries := make([]Entry, len(input))
	for i, position := range input {
		next.Entries[indexes[i]].Position = position.Position
		next.Entries[indexes[i]].Revision = revision
		entries[i] = next.Entries[indexes[i]]
	}
	if err := validateWorkspace(next.Entries, next.Layout, next.Appearance); err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	result := desktopPositionsResponse{Revision: revision, Entries: entries}
	responseBody, err := s.persistMutationLocked(next, r, http.StatusOK, result)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.store.publishLocked(revision)
	writeJSONBody(w, http.StatusOK, responseBody)
}

func (s *Server) putSettings(w http.ResponseWriter, r *http.Request) {
	var settings EditorSettings
	if err := decodeJSON(w, r, &settings, 1<<20); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := validateSettings(settings); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	s.store.mu.Lock()
	w, unlock := unlockBeforeResponse(w, s.store.mu.Unlock)
	defer unlock()
	if s.replayMutationLocked(w, r) {
		return
	}
	if !s.requireInitializedLocked(w) {
		return
	}
	next := cloneWorkspace(s.store.workspace)
	next.Revision++
	next.EditorSettings = settings
	next.SettingsRevision = next.Revision
	result := settingsResponse{Revision: next.Revision, EditorSettings: settings, SettingsRevision: next.SettingsRevision}
	responseBody, err := s.persistMutationLocked(next, r, http.StatusOK, result)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.store.publishLocked(next.Revision)
	writeJSONBody(w, http.StatusOK, responseBody)
}

func (s *Server) putThemeSelection(w http.ResponseWriter, r *http.Request) {
	var input struct {
		ThemeID string `json:"themeId"`
	}
	if err := decodeJSON(w, r, &input, 1<<20); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if !validID(input.ThemeID) {
		writeError(w, http.StatusBadRequest, "invalid theme ID")
		return
	}
	s.store.mu.Lock()
	w, unlock := unlockBeforeResponse(w, s.store.mu.Unlock)
	defer unlock()
	if s.replayMutationLocked(w, r) {
		return
	}
	if !s.requireInitializedLocked(w) {
		return
	}
	next := cloneWorkspace(s.store.workspace)
	if !builtInThemeIDs[input.ThemeID] && themeIndex(next.Appearance.CustomThemes, input.ThemeID) < 0 {
		writeError(w, http.StatusNotFound, "theme not found")
		return
	}
	next.Revision++
	next.Appearance.SelectedThemeID = input.ThemeID
	next.Appearance.SelectionRevision = next.Revision
	result := map[string]any{"revision": next.Revision, "appearance": next.Appearance}
	responseBody, err := s.persistMutationLocked(next, r, http.StatusOK, result)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.store.publishLocked(next.Revision)
	writeJSONBody(w, http.StatusOK, responseBody)
}

func (s *Server) putTheme(w http.ResponseWriter, r *http.Request) {
	var input BootstrapCustomTheme
	if err := decodeJSON(w, r, &input, 1<<20); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if input.ID != r.PathValue("id") {
		writeError(w, http.StatusBadRequest, "path and body theme IDs must match")
		return
	}
	if err := validateTheme(CustomTheme{ID: input.ID, Name: input.Name, Definition: input.Definition}); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	s.store.mu.Lock()
	w, unlock := unlockBeforeResponse(w, s.store.mu.Unlock)
	defer unlock()
	if s.replayMutationLocked(w, r) {
		return
	}
	if !s.requireInitializedLocked(w) {
		return
	}
	next := cloneWorkspace(s.store.workspace)
	index := themeIndex(next.Appearance.CustomThemes, input.ID)
	if index < 0 && len(next.Appearance.CustomThemes) >= 24 {
		writeError(w, http.StatusConflict, "custom theme limit reached")
		return
	}
	next.Revision++
	theme := CustomTheme{ID: input.ID, Name: input.Name, Definition: input.Definition, Revision: next.Revision}
	if index < 0 {
		next.Appearance.CustomThemes = append(next.Appearance.CustomThemes, theme)
	} else {
		next.Appearance.CustomThemes[index] = theme
	}
	if err := validateAppearance(next.Appearance); err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	result := map[string]any{"revision": next.Revision, "theme": theme}
	responseBody, err := s.persistMutationLocked(next, r, http.StatusOK, result)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.store.publishLocked(next.Revision)
	writeJSONBody(w, http.StatusOK, responseBody)
}

func (s *Server) deleteTheme(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !validID(id) {
		writeError(w, http.StatusBadRequest, "invalid theme ID")
		return
	}
	if builtInThemeIDs[id] {
		writeError(w, http.StatusBadRequest, "built-in themes cannot be deleted")
		return
	}
	s.store.mu.Lock()
	w, unlock := unlockBeforeResponse(w, s.store.mu.Unlock)
	defer unlock()
	if s.replayMutationLocked(w, r) {
		return
	}
	if !s.requireInitializedLocked(w) {
		return
	}
	next := cloneWorkspace(s.store.workspace)
	index := themeIndex(next.Appearance.CustomThemes, id)
	if index < 0 {
		result := map[string]any{"revision": next.Revision, "deletedId": id, "appearance": next.Appearance}
		responseBody, err := s.persistMutationLocked(next, r, http.StatusOK, result)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSONBody(w, http.StatusOK, responseBody)
		return
	}
	next.Revision++
	next.Appearance.CustomThemes = append(next.Appearance.CustomThemes[:index], next.Appearance.CustomThemes[index+1:]...)
	if next.Appearance.SelectedThemeID == id {
		next.Appearance.SelectedThemeID = defaultThemeID
		next.Appearance.SelectionRevision = next.Revision
	}
	result := map[string]any{"revision": next.Revision, "deletedId": id, "appearance": next.Appearance}
	responseBody, err := s.persistMutationLocked(next, r, http.StatusOK, result)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.store.publishLocked(next.Revision)
	writeJSONBody(w, http.StatusOK, responseBody)
}

func themeIndex(themes []CustomTheme, id string) int {
	for i := range themes {
		if themes[i].ID == id {
			return i
		}
	}
	return -1
}

func entryActivityDetails(entries []Entry) []string {
	details := make([]string, 0, len(entries))
	for _, entry := range entries {
		details = append(details, entryDetail(entry))
	}
	return details
}

func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "streaming is unsupported")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	ch, unsubscribe := s.store.subscribe()
	defer unsubscribe()
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case revision := <-ch:
			workspace := s.store.snapshot()
			fmt.Fprintf(w, "id: %d\nevent: workspace\ndata: {\"revision\":%d,\"schemaVersion\":%d,\"workspaceId\":%q}\n\n", revision, revision, workspace.SchemaVersion, workspace.WorkspaceID)
			flusher.Flush()
		case <-heartbeat.C:
			fmt.Fprint(w, ": heartbeat\n\n")
			flusher.Flush()
		case <-r.Context().Done():
			return
		}
	}
}

func (s *Server) static(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	clean := filepath.Clean("/" + r.URL.Path)
	rel := strings.TrimPrefix(clean, "/")
	path := filepath.Join(s.staticDir, filepath.FromSlash(rel))
	if info, err := os.Stat(path); err == nil && !info.IsDir() {
		setStaticCachePolicy(w, clean)
		http.ServeFile(w, r, path)
		return
	}
	index := filepath.Join(s.staticDir, "index.html")
	if _, err := os.Stat(index); err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeFile(w, r, index)
}

func setStaticCachePolicy(w http.ResponseWriter, path string) {
	if strings.HasPrefix(path, "/assets/") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		return
	}
	switch path {
	case "/", "/index.html", "/sw.js", "/registerSW.js", "/manifest.webmanifest":
		w.Header().Set("Cache-Control", "no-cache")
	}
}

func (s *Server) requireInitializedLocked(w http.ResponseWriter) bool {
	if !s.store.workspace.Initialized {
		writeError(w, http.StatusConflict, "workspace is not initialized")
		return false
	}
	return true
}

func entryIndex(entries []Entry, id string) int {
	for i := range entries {
		if entries[i].ID == id {
			return i
		}
	}
	return -1
}

func decodeJSON(w http.ResponseWriter, r *http.Request, dst any, max int64) error {
	r.Body = http.MaxBytesReader(w, r.Body, max)
	return decodeJSONReader(r.Body, dst, max)
}

func decodeJSONReader(r io.Reader, dst any, max int64) error {
	dec := json.NewDecoder(io.LimitReader(r, max+1))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return fmt.Errorf("invalid JSON: %w", err)
	}
	var extra any
	if err := dec.Decode(&extra); !errors.Is(err, io.EOF) {
		return fmt.Errorf("JSON must contain one value")
	}
	return nil
}

func statusForReadError(err error) int {
	if err != nil && strings.Contains(err.Error(), "request body too large") {
		return http.StatusRequestEntityTooLarge
	}
	return http.StatusBadRequest
}

type entryResponse struct {
	Revision int64 `json:"revision"`
	Entry    Entry `json:"entry"`
}

type importResponse struct {
	Revision int64   `json:"revision"`
	Entries  []Entry `json:"entries"`
}

type batchMoveRequest struct {
	EntryIDs []string `json:"entryIds"`
	ParentID *string  `json:"parentId"`
}

type batchMoveResponse struct {
	Revision int64   `json:"revision"`
	Entries  []Entry `json:"entries"`
}

type batchDeleteRequest struct {
	EntryIDs []string `json:"entryIds"`
}

type deleteResponse struct {
	Revision   int64    `json:"revision"`
	DeletedIDs []string `json:"deletedIds"`
}

type layoutResponse struct {
	Revision       int64  `json:"revision"`
	Layout         Layout `json:"layout"`
	LayoutRevision int64  `json:"layoutRevision"`
}

type desktopPosition struct {
	EntryID  string   `json:"entryId"`
	Position Position `json:"position"`
}

type desktopPositionsResponse struct {
	Revision int64   `json:"revision"`
	Entries  []Entry `json:"entries"`
}

type settingsResponse struct {
	Revision         int64          `json:"revision"`
	EditorSettings   EditorSettings `json:"editorSettings"`
	SettingsRevision int64          `json:"settingsRevision"`
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

type unlockResponseWriter struct {
	http.ResponseWriter
	once   sync.Once
	unlock func()
}

func unlockBeforeResponse(w http.ResponseWriter, unlock func()) (http.ResponseWriter, func()) {
	wrapped := &unlockResponseWriter{ResponseWriter: w, unlock: unlock}
	release := func() { wrapped.once.Do(wrapped.unlock) }
	return wrapped, release
}

func (w *unlockResponseWriter) WriteHeader(status int) {
	w.once.Do(w.unlock)
	w.ResponseWriter.WriteHeader(status)
}

func (w *unlockResponseWriter) Write(p []byte) (int, error) {
	w.once.Do(w.unlock)
	return w.ResponseWriter.Write(p)
}
