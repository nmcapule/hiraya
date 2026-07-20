package syncapi

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestBootstrapAndPersistenceRestart(t *testing.T) {
	dir := t.TempDir()
	store, server := newTestServer(t, dir)
	workspace := testBootstrap()
	workspace.Layout.SnapToGrid = true
	workspace.Layout.Wallpaper = "grove"
	workspace.Entries = []Entry{
		folder("folder", "Docs", nil, ptr("view-1")),
		file("file", "hello.txt", ptr("folder"), nil, "text/plain", 5),
	}

	response := bootstrapRequest(t, server, workspace, map[string]string{"file": "hello"})
	if response.Code != http.StatusCreated {
		t.Fatalf("bootstrap status = %d, body = %s", response.Code, response.Body.String())
	}
	var created Workspace
	decodeResponse(t, response, &created)
	if !created.Initialized || created.Revision != 1 || created.LayoutRevision != 1 || created.SettingsRevision != 1 || !created.Layout.SnapToGrid || created.Layout.Wallpaper != "grove" {
		t.Fatalf("unexpected bootstrap revisions: %+v", created)
	}
	if created.Entries[0].Revision != 1 || created.Entries[1].ContentRevision != 1 || created.Entries[1].ModifiedAt == 1 {
		t.Fatalf("server did not assign entry metadata: %+v", created.Entries)
	}

	duplicate := bootstrapRequest(t, server, workspace, map[string]string{"file": "hello"})
	if duplicate.Code != http.StatusConflict {
		t.Fatalf("second bootstrap status = %d", duplicate.Code)
	}

	reopened, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	snapshot := reopened.snapshot()
	if snapshot.Revision != 1 || len(snapshot.Entries) != 2 || !snapshot.Layout.SnapToGrid || snapshot.Layout.Wallpaper != "grove" {
		t.Fatalf("reopened snapshot = %+v", snapshot)
	}
	content, err := os.ReadFile(filepath.Join(store.filesDir, "file"))
	if err != nil || string(content) != "hello" {
		t.Fatalf("persisted content = %q, %v", content, err)
	}
}

func TestPersistenceDefaultsLegacyWallpaper(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "files"), 0o700); err != nil {
		t.Fatal(err)
	}
	legacy := []byte(`{"initialized":true,"revision":1,"entries":[],"layout":{"views":[{"id":"view-1"}],"columns":1,"snapToGrid":false},"layoutRevision":1,"editorSettings":{"autoSave":true,"fontSize":13,"language":"auto"},"settingsRevision":1}`)
	if err := os.WriteFile(filepath.Join(dir, metadataName), legacy, 0o600); err != nil {
		t.Fatal(err)
	}

	store, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if wallpaper := store.snapshot().Layout.Wallpaper; wallpaper != "dusk" {
		t.Fatalf("legacy wallpaper = %q", wallpaper)
	}
}

func TestImportMultipleFilesAtomically(t *testing.T) {
	store, server := initializedTestServer(t)
	events, unsubscribe := store.subscribe()
	defer unsubscribe()
	<-events // Immediate current revision.
	entries := []Entry{
		file("first", "first.txt", nil, ptr("view-1"), "text/plain", 5),
		file("second", "second.json", nil, ptr("view-1"), "application/json", 2),
	}
	response := importRequest(t, server, entries, map[string]string{"first": "hello", "second": "{}"})
	if response.Code != http.StatusOK {
		t.Fatalf("import status = %d, body = %s", response.Code, response.Body.String())
	}
	var imported importResponse
	decodeResponse(t, response, &imported)
	if imported.Revision != 2 || len(imported.Entries) != 2 {
		t.Fatalf("import response = %+v", imported)
	}
	for _, entry := range imported.Entries {
		if entry.Revision != 2 || entry.ContentRevision != 2 || entry.ModifiedAt != 1_700_000_000_000 {
			t.Errorf("server fields for %s = %+v", entry.ID, entry)
		}
		content, err := os.ReadFile(filepath.Join(store.filesDir, entry.ID))
		if err != nil || string(content) != map[string]string{"first": "hello", "second": "{}"}[entry.ID] {
			t.Errorf("blob %s = %q, %v", entry.ID, content, err)
		}
	}
	snapshot := store.snapshot()
	if snapshot.Revision != 2 || len(snapshot.Entries) != 2 {
		t.Fatalf("workspace after import = %+v", snapshot)
	}
	if revision := <-events; revision != 2 {
		t.Fatalf("SSE revision = %d", revision)
	}
	select {
	case revision := <-events:
		t.Fatalf("unexpected second SSE event at revision %d", revision)
	default:
	}
}

func TestImportInvalidBatchIsAllOrNothing(t *testing.T) {
	store, server := initializedTestServer(t)
	tests := []struct {
		name    string
		entries []Entry
		files   map[string]string
	}{
		{
			name: "duplicate sibling name",
			entries: []Entry{
				file("duplicate-a", "Report.txt", nil, ptr("view-1"), "text/plain", 1),
				file("duplicate-b", "report.txt", nil, ptr("view-1"), "text/plain", 1),
			},
			files: map[string]string{"duplicate-a": "a", "duplicate-b": "b"},
		},
		{
			name:    "declared size mismatch",
			entries: []Entry{file("wrong-size", "wrong.txt", nil, ptr("view-1"), "text/plain", 20)},
			files:   map[string]string{"wrong-size": "short"},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := importRequest(t, server, test.entries, test.files)
			if response.Code != http.StatusConflict {
				t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
			}
			if snapshot := store.snapshot(); snapshot.Revision != 1 || len(snapshot.Entries) != 0 {
				t.Fatalf("rejected import changed workspace: %+v", snapshot)
			}
			for _, entry := range test.entries {
				if _, err := os.Stat(filepath.Join(store.filesDir, entry.ID)); !os.IsNotExist(err) {
					t.Errorf("rejected import wrote blob %q: %v", entry.ID, err)
				}
			}
		})
	}

	existing := multipartEntryRequest(t, server, http.MethodPost, "/api/entries", file("existing", "existing.txt", nil, ptr("view-1"), "text/plain", 0), ptr("old"))
	if existing.Code != http.StatusOK {
		t.Fatalf("create existing file: %d %s", existing.Code, existing.Body.String())
	}
	before := store.snapshot()
	response := importRequest(t, server, []Entry{
		file("new", "new.txt", nil, ptr("view-1"), "text/plain", 3),
		file("existing", "replacement.txt", nil, ptr("view-1"), "text/plain", 3),
	}, map[string]string{"new": "new", "existing": "new"})
	if response.Code != http.StatusConflict {
		t.Fatalf("existing ID status = %d, body = %s", response.Code, response.Body.String())
	}
	after := store.snapshot()
	if after.Revision != before.Revision || len(after.Entries) != len(before.Entries) {
		t.Fatalf("existing-ID batch partially committed: before=%+v after=%+v", before, after)
	}
	if _, err := os.Stat(filepath.Join(store.filesDir, "new")); !os.IsNotExist(err) {
		t.Fatalf("existing-ID batch wrote new blob: %v", err)
	}
	content, err := os.ReadFile(filepath.Join(store.filesDir, "existing"))
	if err != nil || string(content) != "old" {
		t.Fatalf("existing blob changed to %q: %v", content, err)
	}
}

func TestImportEnforcesCombinedUploadLimit(t *testing.T) {
	store, server := initializedTestServer(t)
	server.maxUpload = 3
	entries := []Entry{
		file("one", "one.txt", nil, ptr("view-1"), "text/plain", 2),
		file("two", "two.txt", nil, ptr("view-1"), "text/plain", 2),
	}
	response := importRequest(t, server, entries, map[string]string{"one": "12", "two": "34"})
	if response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if snapshot := store.snapshot(); snapshot.Revision != 1 || len(snapshot.Entries) != 0 {
		t.Fatalf("oversized import changed workspace: %+v", snapshot)
	}
	for _, entry := range entries {
		if _, err := os.Stat(filepath.Join(store.filesDir, entry.ID)); !os.IsNotExist(err) {
			t.Errorf("oversized import wrote blob %q: %v", entry.ID, err)
		}
	}
}

func TestMutationsRevisionsAndLastRequestWins(t *testing.T) {
	_, server := initializedTestServer(t)

	create := multipartEntryRequest(t, server, http.MethodPost, "/api/entries", file("file", "one.txt", nil, ptr("view-1"), "text/plain", 0), ptr("one"))
	if create.Code != http.StatusOK {
		t.Fatalf("create status = %d, body = %s", create.Code, create.Body.String())
	}
	var first entryResponse
	decodeResponse(t, create, &first)
	if first.Revision != 2 || first.Entry.Revision != 2 || first.Entry.ContentRevision != 2 || first.Entry.Size != 3 {
		t.Fatalf("create response = %+v", first)
	}
	empty := multipartEntryRequest(t, server, http.MethodPost, "/api/entries", file("empty", "empty.txt", nil, ptr("view-1"), "text/plain", 0), nil)
	if empty.Code != http.StatusOK || !strings.Contains(empty.Body.String(), `"size":0`) {
		t.Fatalf("empty file response must retain TS file fields: %d %s", empty.Code, empty.Body.String())
	}

	firstPatch := first.Entry
	firstPatch.Name = "two.txt"
	patched := jsonRequest(t, server, http.MethodPatch, "/api/entries/file", firstPatch)
	if patched.Code != http.StatusOK {
		t.Fatalf("patch status = %d, body = %s", patched.Code, patched.Body.String())
	}
	secondPatch := first.Entry // Deliberately stale metadata: request processing order wins.
	secondPatch.Name = "three.txt"
	patched = jsonRequest(t, server, http.MethodPatch, "/api/entries/file", secondPatch)
	if patched.Code != http.StatusOK {
		t.Fatalf("stale patch status = %d, body = %s", patched.Code, patched.Body.String())
	}
	var last entryResponse
	decodeResponse(t, patched, &last)
	if last.Revision != 5 || last.Entry.Name != "three.txt" || last.Entry.ContentRevision != 2 {
		t.Fatalf("last patch response = %+v", last)
	}

	content := httptest.NewRequest(http.MethodPut, "/api/files/file/content", strings.NewReader("updated"))
	content.Header.Set("Content-Type", "text/markdown")
	contentResponse := httptest.NewRecorder()
	server.ServeHTTP(contentResponse, content)
	var updated entryResponse
	decodeResponse(t, contentResponse, &updated)
	if updated.Revision != 6 || updated.Entry.ContentRevision != 6 || updated.Entry.Revision != 6 || updated.Entry.Size != 7 || updated.Entry.MimeType != "text/markdown" {
		t.Fatalf("content response = %+v", updated)
	}
	staleAfterContent := first.Entry
	staleAfterContent.Name = "metadata-wins.txt"
	patched = jsonRequest(t, server, http.MethodPatch, "/api/entries/file", staleAfterContent)
	decodeResponse(t, patched, &last)
	if patched.Code != http.StatusOK || last.Revision != 7 || last.Entry.Size != 7 || last.Entry.ContentRevision != 6 || last.Entry.Name != "metadata-wins.txt" {
		t.Fatalf("stale metadata LWW response = %d %+v", patched.Code, last)
	}

	settings := jsonRequest(t, server, http.MethodPut, "/api/editor-settings", EditorSettings{AutoSave: false, FontSize: 17, Language: "typescript"})
	var settingsResult settingsResponse
	decodeResponse(t, settings, &settingsResult)
	if settingsResult.Revision != 8 || settingsResult.SettingsRevision != 8 {
		t.Fatalf("settings response = %+v", settingsResult)
	}
	layout := jsonRequest(t, server, http.MethodPut, "/api/layout", Layout{Views: []View{{ID: "view-1"}, {ID: "view-2"}}, Columns: 2, SnapToGrid: true, Wallpaper: "ember"})
	var layoutResult layoutResponse
	decodeResponse(t, layout, &layoutResult)
	if layoutResult.Revision != 9 || layoutResult.LayoutRevision != 9 || !layoutResult.Layout.SnapToGrid || layoutResult.Layout.Wallpaper != "ember" {
		t.Fatalf("layout response = %+v", layoutResult)
	}

	get := httptest.NewRecorder()
	server.ServeHTTP(get, httptest.NewRequest(http.MethodGet, "/api/files/file/content", nil))
	if get.Code != http.StatusOK || get.Body.String() != "updated" || get.Header().Get("X-Hiraya-Revision") != "6" {
		t.Fatalf("content GET = %d %q headers=%v", get.Code, get.Body.String(), get.Header())
	}
}

func TestRecursiveDeletionCommitsBeforeBlobCleanup(t *testing.T) {
	store, server := initializedTestServer(t)
	entries := []struct {
		entry   Entry
		content *string
	}{
		{folder("parent", "Parent", nil, ptr("view-1")), nil},
		{folder("child", "Child", ptr("parent"), nil), nil},
		{file("nested", "nested.txt", ptr("child"), nil, "text/plain", 0), ptr("bytes")},
		{file("keep", "keep.txt", nil, ptr("view-1"), "text/plain", 0), ptr("keep")},
	}
	for _, item := range entries {
		response := multipartEntryRequest(t, server, http.MethodPost, "/api/entries", item.entry, item.content)
		if response.Code != http.StatusOK {
			t.Fatalf("create %s: %d %s", item.entry.ID, response.Code, response.Body.String())
		}
	}
	response := httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodDelete, "/api/entries/parent", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("delete status = %d, body = %s", response.Code, response.Body.String())
	}
	var deleted deleteResponse
	decodeResponse(t, response, &deleted)
	if strings.Join(deleted.DeletedIDs, ",") != "parent,child,nested" {
		t.Fatalf("deleted IDs = %v", deleted.DeletedIDs)
	}
	if _, err := os.Stat(filepath.Join(store.filesDir, "nested")); !os.IsNotExist(err) {
		t.Fatalf("nested blob still exists: %v", err)
	}
	if _, err := os.Stat(filepath.Join(store.filesDir, "keep")); err != nil {
		t.Fatalf("kept blob missing: %v", err)
	}
	if entries := store.snapshot().Entries; len(entries) != 1 || entries[0].ID != "keep" {
		t.Fatalf("remaining entries = %+v", entries)
	}
}

func TestValidationRejectsInvalidStructuresAndPayloads(t *testing.T) {
	_, server := initializedTestServer(t)

	badID := multipartEntryRequest(t, server, http.MethodPost, "/api/entries", file("bad/id", "bad.txt", nil, ptr("view-1"), "text/plain", 0), ptr(""))
	if badID.Code != http.StatusConflict {
		t.Fatalf("unsafe ID status = %d", badID.Code)
	}
	first := multipartEntryRequest(t, server, http.MethodPost, "/api/entries", folder("one", "Same", nil, ptr("view-1")), nil)
	if first.Code != http.StatusOK {
		t.Fatalf("first folder status = %d", first.Code)
	}
	duplicate := multipartEntryRequest(t, server, http.MethodPost, "/api/entries", folder("two", "same", nil, ptr("view-1")), nil)
	if duplicate.Code != http.StatusConflict {
		t.Fatalf("duplicate name status = %d", duplicate.Code)
	}
	child := multipartEntryRequest(t, server, http.MethodPost, "/api/entries", folder("child", "Child", ptr("one"), nil), nil)
	if child.Code != http.StatusOK {
		t.Fatalf("child status = %d", child.Code)
	}

	snapshot := getWorkspace(t, server)
	parent := findEntry(t, snapshot.Entries, "one")
	parent.ParentID = ptr("child")
	parent.ViewID = nil
	cycle := jsonRequest(t, server, http.MethodPatch, "/api/entries/one", parent)
	if cycle.Code != http.StatusConflict {
		t.Fatalf("cycle status = %d, body = %s", cycle.Code, cycle.Body.String())
	}
	badSettings := jsonRequest(t, server, http.MethodPut, "/api/editor-settings", EditorSettings{AutoSave: true, FontSize: 50, Language: "auto"})
	if badSettings.Code != http.StatusBadRequest {
		t.Fatalf("bad settings status = %d", badSettings.Code)
	}
	removedView := jsonRequest(t, server, http.MethodPut, "/api/layout", Layout{Views: []View{{ID: "other"}}, Columns: 1, Wallpaper: "dusk"})
	if removedView.Code != http.StatusConflict {
		t.Fatalf("linked view removal status = %d", removedView.Code)
	}
	badWallpaper := jsonRequest(t, server, http.MethodPut, "/api/layout", Layout{Views: []View{{ID: "view-1"}}, Columns: 1, Wallpaper: "ocean"})
	if badWallpaper.Code != http.StatusBadRequest {
		t.Fatalf("bad wallpaper status = %d", badWallpaper.Code)
	}
}

func TestSSENotifiesAfterMutation(t *testing.T) {
	store, handler := initializedTestServer(t)
	httpServer := httptest.NewServer(handler)
	defer httpServer.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, httpServer.URL+"/api/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	reader := bufio.NewReader(response.Body)
	if event := readSSEEvent(t, reader); event != "id: 1\nevent: workspace\ndata: {\"revision\":1}\n" {
		t.Fatalf("initial SSE event = %q", event)
	}

	mutation := jsonRequest(t, handler, http.MethodPut, "/api/editor-settings", EditorSettings{AutoSave: false, FontSize: 13, Language: "auto"})
	if mutation.Code != http.StatusOK || store.snapshot().Revision != 2 {
		t.Fatalf("mutation failed: %d %s", mutation.Code, mutation.Body.String())
	}
	if event := readSSEEvent(t, reader); event != "id: 2\nevent: workspace\ndata: {\"revision\":2}\n" {
		t.Fatalf("mutation SSE event = %q", event)
	}

	reopened, err := OpenStore(store.dir)
	if err != nil || reopened.snapshot().Revision != 2 {
		t.Fatalf("event was published without durable revision: %v %+v", err, reopened)
	}
}

func TestUninitializedSnapshotAndUploadLimit(t *testing.T) {
	_, server := newTestServer(t, t.TempDir())
	snapshot := getWorkspace(t, server)
	if snapshot.Initialized || snapshot.Revision != 0 || snapshot.Entries == nil || snapshot.Layout.Views == nil {
		t.Fatalf("uninitialized snapshot = %+v", snapshot)
	}
	mutation := jsonRequest(t, server, http.MethodPut, "/api/editor-settings", EditorSettings{AutoSave: true, FontSize: 13, Language: "auto"})
	if mutation.Code != http.StatusConflict {
		t.Fatalf("uninitialized mutation status = %d", mutation.Code)
	}

	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	limited := New(store, t.TempDir(), 3)
	workspace := testBootstrap()
	workspace.Entries = []Entry{file("file", "large.txt", nil, ptr("view-1"), "text/plain", 4)}
	response := bootstrapRequest(t, limited, workspace, map[string]string{"file": "four"})
	if response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized bootstrap status = %d, body = %s", response.Code, response.Body.String())
	}
}

func newTestServer(t *testing.T, dir string) (*Store, *Server) {
	t.Helper()
	store, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	server := New(store, t.TempDir(), 10<<20)
	server.now = func() time.Time { return time.UnixMilli(1_700_000_000_000) }
	return store, server
}

func initializedTestServer(t *testing.T) (*Store, *Server) {
	t.Helper()
	store, server := newTestServer(t, t.TempDir())
	response := bootstrapRequest(t, server, testBootstrap(), nil)
	if response.Code != http.StatusCreated {
		t.Fatalf("initialize: %d %s", response.Code, response.Body.String())
	}
	return store, server
}

func testBootstrap() bootstrapWorkspace {
	return bootstrapWorkspace{
		Entries:        []Entry{},
		Layout:         Layout{Views: []View{{ID: "view-1"}}, Columns: 1, Wallpaper: "dusk"},
		EditorSettings: EditorSettings{AutoSave: true, FontSize: 13, Language: "auto"},
	}
}

func folder(id, name string, parentID, viewID *string) Entry {
	return Entry{Kind: "folder", ID: id, Name: name, ParentID: parentID, ModifiedAt: 1, Position: Position{X: 1, Y: 2}, ViewID: viewID}
}

func file(id, name string, parentID, viewID *string, mimeType string, size int64) Entry {
	return Entry{Kind: "file", ID: id, Name: name, ParentID: parentID, ModifiedAt: 1, Position: Position{X: 1, Y: 2}, ViewID: viewID, MimeType: mimeType, Size: size}
}

func ptr[T any](value T) *T { return &value }

func bootstrapRequest(t *testing.T, handler http.Handler, workspace bootstrapWorkspace, files map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	part, err := w.CreateFormField("workspace")
	if err != nil {
		t.Fatal(err)
	}
	if err := json.NewEncoder(part).Encode(workspace); err != nil {
		t.Fatal(err)
	}
	for id, content := range files {
		part, err := w.CreateFormFile("file-"+id, id)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.WriteString(part, content)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/bootstrap", &body)
	request.Header.Set("Content-Type", w.FormDataContentType())
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func multipartEntryRequest(t *testing.T, handler http.Handler, method, path string, entry Entry, content *string) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	if content != nil { // Write content first to verify multipart order independence.
		part, err := w.CreateFormFile("content", entry.Name)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.WriteString(part, *content)
	}
	part, err := w.CreateFormField("entry")
	if err != nil {
		t.Fatal(err)
	}
	if err := json.NewEncoder(part).Encode(entry); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(method, path, &body)
	request.Header.Set("Content-Type", w.FormDataContentType())
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func importRequest(t *testing.T, handler http.Handler, entries []Entry, files map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	part, err := w.CreateFormField("entries")
	if err != nil {
		t.Fatal(err)
	}
	if err := json.NewEncoder(part).Encode(entries); err != nil {
		t.Fatal(err)
	}
	for id, content := range files {
		part, err := w.CreateFormFile("file-"+id, id)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.WriteString(part, content)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/imports", &body)
	request.Header.Set("Content-Type", w.FormDataContentType())
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func jsonRequest(t *testing.T, handler http.Handler, method, path string, value any) *httptest.ResponseRecorder {
	t.Helper()
	b, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(method, path, bytes.NewReader(b))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func getWorkspace(t *testing.T, handler http.Handler) Workspace {
	t.Helper()
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/workspace", nil))
	var workspace Workspace
	decodeResponse(t, response, &workspace)
	return workspace
}

func findEntry(t *testing.T, entries []Entry, id string) Entry {
	t.Helper()
	for _, entry := range entries {
		if entry.ID == id {
			return entry
		}
	}
	t.Fatalf("entry %q not found", id)
	return Entry{}
}

func decodeResponse(t *testing.T, response *httptest.ResponseRecorder, dst any) {
	t.Helper()
	if err := json.Unmarshal(response.Body.Bytes(), dst); err != nil {
		t.Fatalf("decode response %q: %v", response.Body.String(), err)
	}
}

func readSSEEvent(t *testing.T, reader *bufio.Reader) string {
	t.Helper()
	var event strings.Builder
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		if line == "\n" {
			return event.String()
		}
		event.WriteString(line)
	}
}

func TestStaticSPAFallbackDoesNotInterceptAPI(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("index"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "asset.js"), []byte("asset"), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	server := New(store, dir, 1024)
	for path, want := range map[string]string{"/route": "index", "/asset.js": "asset"} {
		response := httptest.NewRecorder()
		server.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusOK || response.Body.String() != want {
			t.Errorf("GET %s = %d %q", path, response.Code, response.Body.String())
		}
	}
	response := httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/missing", nil))
	if response.Code != http.StatusNotFound || !strings.Contains(response.Header().Get("Content-Type"), "application/json") {
		t.Fatalf("missing API = %d %q %s", response.Code, response.Header().Get("Content-Type"), response.Body.String())
	}
}

func Example_entryResponse() {
	response := entryResponse{Revision: 4, Entry: Entry{Kind: "folder", ID: "docs", Name: "Docs", Revision: 4}}
	b, _ := json.Marshal(response)
	fmt.Println(string(b))
	// Output: {"revision":4,"entry":{"kind":"folder","id":"docs","name":"Docs","parentId":null,"modifiedAt":0,"position":{"x":0,"y":0},"viewId":null,"revision":4,"contentRevision":0}}
}
