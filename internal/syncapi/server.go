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
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "revision": s.store.snapshot().Revision})
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
	if err := validateEntries(input.Entries, input.Layout); err != nil {
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
	defer s.store.mu.Unlock()
	if s.store.workspace.Initialized {
		writeError(w, http.StatusConflict, "workspace is already initialized")
		return
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
			_, copyErr := atomicCopy(filepath.Join(s.store.filesDir, e.ID), f, s.maxUpload)
			f.Close()
			if copyErr != nil {
				writeError(w, http.StatusInternalServerError, "could not persist file")
				return
			}
		}
	}
	next := Workspace{Initialized: true, Revision: 1, Entries: input.Entries, Layout: input.Layout, LayoutRevision: 1, EditorSettings: input.EditorSettings, SettingsRevision: 1}
	if err := s.store.persistLocked(next); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
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
	defer s.store.mu.Unlock()
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
	if err := validateEntries(next.Entries, next.Layout); err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	for _, entry := range entries {
		file, openErr := os.Open(uploads[entry.ID].path)
		if openErr != nil {
			writeError(w, http.StatusInternalServerError, "could not read staged file")
			return
		}
		_, copyErr := atomicCopy(filepath.Join(s.store.filesDir, entry.ID), file, s.maxUpload)
		file.Close()
		if copyErr != nil {
			writeError(w, http.StatusInternalServerError, "could not persist imported file")
			return
		}
	}
	next.Revision = revision
	if err := s.store.persistLocked(next); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
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
	defer s.store.mu.Unlock()
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
	if err := validateEntries(next.Entries, next.Layout); err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	if entry.Kind == "file" && (gotContent || idx < 0) {
		var f *os.File
		if gotContent {
			f, err = os.Open(contentPath)
		} else {
			f, err = os.Open(os.DevNull)
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "could not read staged content")
			return
		}
		_, err = atomicCopy(filepath.Join(s.store.filesDir, entry.ID), f, s.maxUpload)
		f.Close()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "could not persist content")
			return
		}
	}
	next.Revision++
	if err := s.store.persistLocked(next); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
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
	defer s.store.mu.Unlock()
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
	if err := validateEntries(next.Entries, next.Layout); err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	next.Revision++
	if err := s.store.persistLocked(next); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
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
	defer s.store.mu.Unlock()
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
	if err := validateEntries(next.Entries, next.Layout); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	f, err := os.Open(tmpPath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not read staged content")
		return
	}
	_, err = atomicCopy(filepath.Join(s.store.filesDir, id), f, s.maxUpload)
	f.Close()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not persist content")
		return
	}
	next.Revision++
	if err := s.store.persistLocked(next); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
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
	s.store.mu.RUnlock()
	f, err := os.Open(filepath.Join(s.store.filesDir, id))
	if errors.Is(err, os.ErrNotExist) {
		writeError(w, http.StatusNotFound, "file content not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not read file content")
		return
	}
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
	defer s.store.mu.Unlock()
	if !s.requireInitializedLocked(w) {
		return
	}
	if entryIndex(s.store.workspace.Entries, id) < 0 {
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
	fileIDs := make([]string, 0)
	for _, entry := range next.Entries {
		if deleted[entry.ID] {
			deletedIDs = append(deletedIDs, entry.ID)
			if entry.Kind == "file" {
				fileIDs = append(fileIDs, entry.ID)
			}
		} else {
			kept = append(kept, entry)
		}
	}
	next.Entries = kept
	next.Revision++
	if err := s.store.persistLocked(next); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.store.publishLocked(next.Revision)
	for _, fileID := range fileIDs {
		if err := os.Remove(filepath.Join(s.store.filesDir, fileID)); err != nil && !errors.Is(err, os.ErrNotExist) {
			slog.Warn("could not clean up deleted blob", "id", fileID, "error", err)
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
	defer s.store.mu.Unlock()
	if !s.requireInitializedLocked(w) {
		return
	}
	next := cloneWorkspace(s.store.workspace)
	if err := validateEntries(next.Entries, layout); err != nil {
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
	defer s.store.mu.Unlock()
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
			fmt.Fprintf(w, "id: %d\nevent: workspace\ndata: {\"revision\":%d}\n\n", revision, revision)
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
