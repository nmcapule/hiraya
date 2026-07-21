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
	"sort"
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
	mux.HandleFunc("POST /api/bootstrap", s.bootstrap)
	mux.HandleFunc("POST /api/imports", s.importEntries)
	mux.HandleFunc("POST /api/entries", s.upsertEntry)
	mux.HandleFunc("PATCH /api/entries/{id}", s.patchEntry)
	mux.HandleFunc("DELETE /api/entries/{id}", s.deleteEntry)
	mux.HandleFunc("GET /api/files/{id}/content", s.getContent)
	mux.HandleFunc("PUT /api/files/{id}/content", s.putContent)
	mux.HandleFunc("PUT /api/layout", s.putLayout)
	mux.HandleFunc("PUT /api/desktop-positions", s.putDesktopPositions)
	mux.HandleFunc("PUT /api/editor-settings", s.putSettings)
	mux.HandleFunc("GET /api/events", s.events)
	mux.HandleFunc("/api/", func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, http.StatusNotFound, "API endpoint not found")
	})
	mux.HandleFunc("/", s.static)
	s.handler = mux
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
		if name == "workspace" {
			if gotWorkspace || part.FileName() != "" || decodeJSONReader(part, &input, 4<<20) != nil {
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
			n, copyErr := io.Copy(file, io.LimitReader(part, s.maxUpload-total+1))
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
	if err := validateWorkspace(input.Entries, input.Layout); err != nil {
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
	s.store.beginMutationLocked()
	w, unlock := unlockBeforeResponse(w, s.store.mu.Unlock)
	defer unlock()
	if s.store.workspace.Initialized {
		writeError(w, http.StatusConflict, "workspace is already initialized")
		return
	}
	paths, err := entryPaths(input.Entries)
	if err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	ordered := append([]Entry(nil), input.Entries...)
	sort.Slice(ordered, func(i, j int) bool {
		return strings.Count(paths[ordered[i].ID], string(filepath.Separator)) < strings.Count(paths[ordered[j].ID], string(filepath.Separator))
	})
	for _, e := range input.Entries {
		if e.ParentID != nil {
			continue
		}
		target := filepath.Join(s.store.filesDir, paths[e.ID])
		if _, err := os.Lstat(target); !errors.Is(err, os.ErrNotExist) {
			writeError(w, http.StatusConflict, "bootstrap path already exists")
			return
		}
	}
	treeStage, err := os.MkdirTemp(s.store.dir, ".bootstrap-tree-*")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not stage bootstrap tree")
		return
	}
	defer os.RemoveAll(treeStage)
	for _, e := range ordered {
		if e.Kind == "folder" {
			if err := os.MkdirAll(filepath.Join(treeStage, paths[e.ID]), 0o700); err != nil {
				writeError(w, http.StatusInternalServerError, "could not stage folder")
				return
			}
		}
	}
	for i := range input.Entries {
		e := &input.Entries[i]
		e.Revision = 1
		e.ContentRevision = 0
		e.ModifiedAt = s.now().UnixMilli()
		if e.Kind == "file" {
			e.ContentRevision = 1
			u := uploads[e.ID]
			f, openErr := os.Open(u.path)
			if openErr != nil {
				writeError(w, http.StatusInternalServerError, "could not read staged file")
				return
			}
			target := filepath.Join(treeStage, paths[e.ID])
			if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
				f.Close()
				writeError(w, http.StatusInternalServerError, "could not stage file directory")
				return
			}
			_, copyErr := atomicCopy(target, f, s.maxUpload)
			f.Close()
			if copyErr != nil {
				writeError(w, http.StatusInternalServerError, "could not stage file")
				return
			}
		}
	}
	promoted := make([]string, 0)
	for _, entry := range input.Entries {
		if entry.ParentID != nil {
			continue
		}
		rel := paths[entry.ID]
		if err := os.Rename(filepath.Join(treeStage, rel), filepath.Join(s.store.filesDir, rel)); err != nil {
			for i := len(promoted) - 1; i >= 0; i-- {
				_ = os.Rename(filepath.Join(s.store.filesDir, promoted[i]), filepath.Join(treeStage, promoted[i]))
			}
			writeError(w, http.StatusInternalServerError, "could not persist bootstrap tree")
			return
		}
		promoted = append(promoted, rel)
	}
	next := Workspace{SchemaVersion: workspaceSchemaVersion, WorkspaceID: s.store.workspace.WorkspaceID, Initialized: true, Revision: 1, Entries: input.Entries, Layout: input.Layout, LayoutRevision: 1, EditorSettings: input.EditorSettings, SettingsRevision: 1}
	if err := s.store.persistLocked(next); err != nil {
		for i := len(promoted) - 1; i >= 0; i-- {
			_ = os.Rename(filepath.Join(s.store.filesDir, promoted[i]), filepath.Join(treeStage, promoted[i]))
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	for _, entry := range input.Entries {
		target := filepath.Join(s.store.filesDir, paths[entry.ID])
		var indexErr error
		if entry.Kind == "file" {
			indexErr = s.store.trackExpectedFileLocked(target, uploads[entry.ID].path)
		} else {
			indexErr = s.store.trackPathLocked(target, "folder")
		}
		if indexErr != nil {
			slog.Warn("could not index bootstrapped entry", "id", entry.ID, "error", indexErr)
		}
	}
	if err := s.store.persistDiskIndexLocked(); err != nil {
		slog.Warn("could not persist filesystem index", "error", err)
	}
	s.store.publishLocked(1)
	writeJSON(w, http.StatusCreated, cloneWorkspace(next))
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
		if name == "entries" {
			if gotEntries || part.FileName() != "" || decodeJSONReader(part, &entries, 4<<20) != nil {
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
			n, copyErr := io.Copy(file, io.LimitReader(part, s.maxUpload-total+1))
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
		if entry.Kind != "file" {
			writeError(w, http.StatusConflict, "imports can contain only files")
			return
		}
		if entryIDs[entry.ID] {
			writeError(w, http.StatusConflict, "import contains duplicate entry IDs")
			return
		}
		entryIDs[entry.ID] = true
		upload, ok := uploads[entry.ID]
		if !ok || upload.size != entry.Size {
			writeError(w, http.StatusConflict, "file parts must match entries and declared sizes")
			return
		}
	}
	if len(uploads) != len(entries) {
		writeError(w, http.StatusConflict, "file parts must match entries")
		return
	}

	s.store.mu.Lock()
	s.store.beginMutationLocked()
	w, unlock := unlockBeforeResponse(w, s.store.mu.Unlock)
	defer unlock()
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
		entries[i].ContentRevision = revision
		entries[i].ModifiedAt = modifiedAt
	}
	next.Entries = append(next.Entries, entries...)
	if err := validateWorkspace(next.Entries, next.Layout); err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	targets := make(map[string]string, len(entries))
	for _, entry := range entries {
		target, pathErr := s.store.entryPathLocked(next.Entries, entry.ID)
		if pathErr != nil || ensureNoSymlink(s.store.filesDir, filepath.Dir(target)) != nil {
			writeError(w, http.StatusConflict, "invalid file path")
			return
		}
		if _, err := os.Lstat(target); !errors.Is(err, os.ErrNotExist) {
			writeError(w, http.StatusConflict, "import path already exists")
			return
		}
		targets[entry.ID] = target
	}
	written := make([]string, 0, len(entries))
	for _, entry := range entries {
		target := targets[entry.ID]
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			for _, path := range written {
				_ = os.Remove(path)
			}
			writeError(w, http.StatusInternalServerError, "could not persist imported file directory")
			return
		}
		file, openErr := os.Open(uploads[entry.ID].path)
		if openErr != nil {
			for _, path := range written {
				_ = os.Remove(path)
			}
			writeError(w, http.StatusInternalServerError, "could not read staged file")
			return
		}
		_, copyErr := atomicCopy(target, file, s.maxUpload)
		file.Close()
		if copyErr != nil {
			for _, path := range written {
				_ = os.Remove(path)
			}
			writeError(w, http.StatusInternalServerError, "could not persist imported file")
			return
		}
		written = append(written, target)
	}
	next.Revision = revision
	if err := s.store.persistLocked(next); err != nil {
		for _, path := range written {
			_ = os.Remove(path)
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	for _, entry := range entries {
		if err := s.store.trackExpectedFileLocked(targets[entry.ID], uploads[entry.ID].path); err != nil {
			slog.Warn("could not index imported file", "id", entry.ID, "error", err)
		}
	}
	if err := s.store.persistDiskIndexLocked(); err != nil {
		slog.Warn("could not persist filesystem index", "error", err)
	}
	s.store.publishLocked(revision)
	writeJSON(w, http.StatusOK, importResponse{Revision: revision, Entries: entries})
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
		switch part.FormName() {
		case "entry":
			if gotEntry || decodeJSONReader(part, &entry, 1<<20) != nil {
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
			n, copyErr := io.Copy(f, io.LimitReader(part, s.maxUpload+1))
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
	s.store.beginMutationLocked()
	w, unlock := unlockBeforeResponse(w, s.store.mu.Unlock)
	defer unlock()
	if !s.requireInitializedLocked(w) {
		return
	}
	next := cloneWorkspace(s.store.workspace)
	idx := entryIndex(next.Entries, entry.ID)
	var old Entry
	var oldPath string
	if idx >= 0 {
		old = next.Entries[idx]
		oldPath, _ = s.store.entryPathLocked(next.Entries, old.ID)
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
	if err := validateWorkspace(next.Entries, next.Layout); err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	target, pathErr := s.store.entryPathLocked(next.Entries, entry.ID)
	if pathErr != nil || ensureNoSymlink(s.store.filesDir, filepath.Dir(target)) != nil {
		writeError(w, http.StatusConflict, "invalid entry path")
		return
	}
	moved := idx >= 0 && oldPath != target
	if moved {
		if _, err := os.Lstat(target); !errors.Is(err, os.ErrNotExist) {
			writeError(w, http.StatusConflict, "entry path already exists")
			return
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil || os.Rename(oldPath, target) != nil {
			writeError(w, http.StatusInternalServerError, "could not move entry")
			return
		}
	}
	rollbackMove := func() {
		if moved {
			if rollbackErr := os.Rename(target, oldPath); rollbackErr != nil {
				slog.Error("could not roll back failed entry move", "from", target, "to", oldPath, "error", rollbackErr)
			}
		}
	}
	if entry.Kind == "folder" && idx < 0 {
		if err := os.Mkdir(target, 0o700); err != nil {
			writeError(w, http.StatusConflict, "could not create folder path")
			return
		}
	}
	var replacement *contentReplacement
	if entry.Kind == "file" && (gotContent || idx < 0) {
		if idx < 0 {
			if _, err := os.Lstat(target); !errors.Is(err, os.ErrNotExist) {
				writeError(w, http.StatusConflict, "entry path already exists")
				return
			}
		}
		if mkdirErr := os.MkdirAll(filepath.Dir(target), 0o700); mkdirErr != nil {
			err = mkdirErr
		} else {
			source := contentPath
			if !gotContent {
				source = os.DevNull
			}
			replacement, err = replaceFileContent(target, source, s.store.dir, s.maxUpload)
		}
		if err != nil {
			rollbackMove()
			writeError(w, http.StatusInternalServerError, "could not persist content")
			return
		}
	}
	next.Revision++
	if err := s.store.persistLocked(next); err != nil {
		if replacement != nil {
			if rollbackErr := replacement.rollback(); rollbackErr != nil {
				slog.Error("could not roll back failed content replacement", "path", target, "error", rollbackErr)
			}
		}
		if moved {
			rollbackMove()
		} else if idx < 0 {
			_ = os.RemoveAll(target)
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if replacement != nil {
		if err := replacement.commit(); err != nil {
			slog.Warn("could not remove replaced content backup", "path", replacement.backup, "error", err)
		}
	}
	if moved {
		s.store.moveDiskPathLocked(oldPath, target)
	}
	if idx < 0 || gotContent {
		var indexErr error
		if entry.Kind == "folder" {
			indexErr = s.store.trackPathLocked(target, "folder")
		} else if gotContent {
			indexErr = s.store.trackExpectedFileLocked(target, contentPath)
		} else {
			indexErr = s.store.trackEmptyFileLocked(target)
		}
		if indexErr != nil {
			slog.Warn("could not index entry path", "id", entry.ID, "error", indexErr)
		}
	}
	if moved || idx < 0 || gotContent {
		if err := s.store.persistDiskIndexLocked(); err != nil {
			slog.Warn("could not persist filesystem index", "error", err)
		}
	}
	s.store.publishLocked(next.Revision)
	writeJSON(w, http.StatusOK, entryResponse{Revision: next.Revision, Entry: entry})
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
	s.store.beginMutationLocked()
	w, unlock := unlockBeforeResponse(w, s.store.mu.Unlock)
	defer unlock()
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
	oldPath, _ := s.store.entryPathLocked(next.Entries, id)
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
	if err := validateWorkspace(next.Entries, next.Layout); err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	newPath, pathErr := s.store.entryPathLocked(next.Entries, id)
	if pathErr != nil || ensureNoSymlink(s.store.filesDir, oldPath) != nil || ensureNoSymlink(s.store.filesDir, filepath.Dir(newPath)) != nil {
		writeError(w, http.StatusConflict, "invalid entry path")
		return
	}
	if oldPath != newPath {
		if _, err := os.Lstat(newPath); !errors.Is(err, os.ErrNotExist) {
			writeError(w, http.StatusConflict, "entry path already exists")
			return
		}
		if err := os.MkdirAll(filepath.Dir(newPath), 0o700); err != nil || os.Rename(oldPath, newPath) != nil {
			writeError(w, http.StatusInternalServerError, "could not move entry")
			return
		}
	}
	next.Revision++
	if err := s.store.persistLocked(next); err != nil {
		if oldPath != newPath {
			if rollbackErr := os.Rename(newPath, oldPath); rollbackErr != nil {
				slog.Error("could not roll back failed entry move", "from", newPath, "to", oldPath, "error", rollbackErr)
			}
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if oldPath != newPath {
		s.store.moveDiskPathLocked(oldPath, newPath)
		if err := s.store.persistDiskIndexLocked(); err != nil {
			slog.Warn("could not persist filesystem index", "error", err)
		}
	}
	s.store.publishLocked(next.Revision)
	writeJSON(w, http.StatusOK, entryResponse{Revision: next.Revision, Entry: entry})
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
	s.store.beginMutationLocked()
	w, unlock := unlockBeforeResponse(w, s.store.mu.Unlock)
	defer unlock()
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
	if err := validateWorkspace(next.Entries, next.Layout); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	path, pathErr := s.store.entryPathLocked(next.Entries, id)
	if pathErr != nil || ensureNoSymlink(s.store.filesDir, path) != nil {
		writeError(w, http.StatusConflict, "invalid file path")
		return
	}
	replacement, err := replaceFileContent(path, tmpPath, s.store.dir, s.maxUpload)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not persist content")
		return
	}
	next.Revision++
	if err := s.store.persistLocked(next); err != nil {
		if rollbackErr := replacement.rollback(); rollbackErr != nil {
			slog.Error("could not roll back failed content update", "path", path, "error", rollbackErr)
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := replacement.commit(); err != nil {
		slog.Warn("could not remove replaced content backup", "path", replacement.backup, "error", err)
	}
	if err := s.store.trackExpectedFileLocked(path, tmpPath); err != nil {
		slog.Warn("could not index updated file", "id", id, "error", err)
	}
	if err := s.store.persistDiskIndexLocked(); err != nil {
		slog.Warn("could not persist filesystem index", "error", err)
	}
	s.store.publishLocked(next.Revision)
	writeJSON(w, http.StatusOK, entryResponse{Revision: next.Revision, Entry: entry})
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
	if pathErr != nil || ensureNoSymlink(s.store.filesDir, path) != nil {
		s.store.mu.RUnlock()
		writeError(w, http.StatusNotFound, "file content not found")
		return
	}
	f, err := os.Open(path)
	if err == nil {
		if info, statErr := f.Stat(); statErr != nil || !info.Mode().IsRegular() {
			f.Close()
			err = os.ErrNotExist
		}
	}
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
	s.store.beginMutationLocked()
	w, unlock := unlockBeforeResponse(w, s.store.mu.Unlock)
	defer unlock()
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
	deletePath, _ := s.store.entryPathLocked(next.Entries, id)
	for _, entry := range next.Entries {
		if deleted[entry.ID] {
			deletedIDs = append(deletedIDs, entry.ID)
		} else {
			kept = append(kept, entry)
		}
	}
	next.Entries = kept
	next.Revision++
	trashDir := filepath.Join(s.store.dir, ".trash")
	var quarantinedPath string
	if _, err := os.Lstat(deletePath); err == nil {
		if err := ensureNoSymlink(s.store.filesDir, filepath.Dir(deletePath)); err != nil {
			writeError(w, http.StatusConflict, "invalid entry path")
			return
		}
		if err := os.MkdirAll(trashDir, 0o700); err != nil {
			writeError(w, http.StatusInternalServerError, "could not stage deleted entry")
			return
		}
		tmp, err := os.CreateTemp(trashDir, ".deleted-*")
		if err != nil {
			writeError(w, http.StatusInternalServerError, "could not stage deleted entry")
			return
		}
		quarantinedPath = tmp.Name()
		if closeErr := tmp.Close(); closeErr != nil {
			_ = os.Remove(quarantinedPath)
			writeError(w, http.StatusInternalServerError, "could not stage deleted entry")
			return
		}
		if err := os.Remove(quarantinedPath); err != nil || os.Rename(deletePath, quarantinedPath) != nil {
			_ = os.Remove(quarantinedPath)
			writeError(w, http.StatusInternalServerError, "could not quarantine deleted entry")
			return
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		writeError(w, http.StatusInternalServerError, "could not inspect deleted entry")
		return
	}
	if err := s.store.persistLocked(next); err != nil {
		if quarantinedPath != "" {
			if rollbackErr := os.Rename(quarantinedPath, deletePath); rollbackErr != nil {
				slog.Error("could not roll back failed entry deletion", "from", quarantinedPath, "to", deletePath, "error", rollbackErr)
			}
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.store.removeDiskPathLocked(deletePath)
	if err := s.store.persistDiskIndexLocked(); err != nil {
		slog.Warn("could not persist filesystem index", "error", err)
	}
	s.store.publishLocked(next.Revision)
	if quarantinedPath != "" {
		if err := os.RemoveAll(quarantinedPath); err != nil {
			slog.Warn("could not clean up quarantined entry", "path", quarantinedPath, "error", err)
		}
	}
	writeJSON(w, http.StatusOK, deleteResponse{Revision: next.Revision, DeletedIDs: deletedIDs})
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
	s.store.beginMutationLocked()
	w, unlock := unlockBeforeResponse(w, s.store.mu.Unlock)
	defer unlock()
	if !s.requireInitializedLocked(w) {
		return
	}
	next := cloneWorkspace(s.store.workspace)
	if err := validateWorkspace(next.Entries, layout); err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	next.Revision++
	next.Layout = layout
	next.LayoutRevision = next.Revision
	if err := s.store.persistLocked(next); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.store.publishLocked(next.Revision)
	writeJSON(w, http.StatusOK, layoutResponse{Revision: next.Revision, Layout: layout, LayoutRevision: next.LayoutRevision})
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
	s.store.beginMutationLocked()
	w, unlock := unlockBeforeResponse(w, s.store.mu.Unlock)
	defer unlock()
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
	if err := validateWorkspace(next.Entries, next.Layout); err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	if err := s.store.persistLocked(next); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.store.publishLocked(revision)
	writeJSON(w, http.StatusOK, desktopPositionsResponse{Revision: revision, Entries: entries})
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
	s.store.beginMutationLocked()
	w, unlock := unlockBeforeResponse(w, s.store.mu.Unlock)
	defer unlock()
	if !s.requireInitializedLocked(w) {
		return
	}
	next := cloneWorkspace(s.store.workspace)
	next.Revision++
	next.EditorSettings = settings
	next.SettingsRevision = next.Revision
	if err := s.store.persistLocked(next); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.store.publishLocked(next.Revision)
	writeJSON(w, http.StatusOK, settingsResponse{Revision: next.Revision, EditorSettings: settings, SettingsRevision: next.SettingsRevision})
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
		http.ServeFile(w, r, path)
		return
	}
	index := filepath.Join(s.staticDir, "index.html")
	if _, err := os.Stat(index); err != nil {
		http.NotFound(w, r)
		return
	}
	http.ServeFile(w, r, index)
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
