package syncapi

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
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
	t.Cleanup(func() { _ = reopened.Close() })
	snapshot := reopened.snapshot()
	if snapshot.Revision != 1 || len(snapshot.Entries) != 2 || !snapshot.Layout.SnapToGrid || snapshot.Layout.Wallpaper != "grove" {
		t.Fatalf("reopened snapshot = %+v", snapshot)
	}
	content, err := os.ReadFile(filepath.Join(store.filesDir, "Docs", "hello.txt"))
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
	t.Cleanup(func() { _ = store.Close() })
	if wallpaper := store.snapshot().Layout.Wallpaper; wallpaper != "dusk" {
		t.Fatalf("legacy wallpaper = %q", wallpaper)
	}
	workspace := store.snapshot()
	if workspace.SchemaVersion != workspaceSchemaVersion || workspace.WorkspaceID == "" {
		t.Fatalf("legacy identity migration = %+v", workspace)
	}
	reopened, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	if reopened.snapshot().WorkspaceID != workspace.WorkspaceID {
		t.Fatal("workspace identity changed after migration restart")
	}
}

func TestWorkspaceSchemaV1MigrationPreservesCoordinatesAndPersistsV4(t *testing.T) {
	dir := t.TempDir()
	filesDir := filepath.Join(dir, "files")
	if err := os.MkdirAll(filesDir, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"Second tie", "Later first view", "Earlier first view", "First tie"} {
		if err := os.Mkdir(filepath.Join(filesDir, name), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	legacy := []byte(`{"schemaVersion":1,"workspaceId":"workspace","initialized":true,"revision":12,"entries":[{"kind":"folder","id":"tie-2","name":"Second tie","parentId":null,"modifiedAt":1,"position":{"x":8,"y":4},"viewId":"view-2","revision":3,"contentRevision":0},{"kind":"folder","id":"later","name":"Later first view","parentId":null,"modifiedAt":2,"position":{"x":20,"y":1},"viewId":"view-1","revision":4,"contentRevision":0},{"kind":"folder","id":"earlier","name":"Earlier first view","parentId":null,"modifiedAt":3,"position":{"x":10,"y":9},"viewId":"view-1","revision":5,"contentRevision":0},{"kind":"folder","id":"tie-1","name":"First tie","parentId":null,"modifiedAt":4,"position":{"x":8,"y":4},"viewId":"view-2","revision":6,"contentRevision":0}],"layout":{"views":[{"id":"view-1"},{"id":"view-2"}],"columns":2,"snapToGrid":true,"wallpaper":"ember"},"layoutRevision":7,"editorSettings":{"autoSave":false,"fontSize":17,"language":"typescript"},"settingsRevision":8}`)
	if err := os.WriteFile(filepath.Join(dir, metadataName), legacy, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, logicalMarker), []byte("1\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	store, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	workspace := store.snapshot()
	if workspace.SchemaVersion != workspaceSchemaVersion || workspace.Revision != 12 || workspace.LayoutRevision != 7 || workspace.SettingsRevision != 8 {
		t.Fatalf("migration changed revisions: %+v", workspace)
	}
	if findEntry(t, workspace.Entries, "tie-2").Position != (Position{X: 8, Y: 4}) || findEntry(t, workspace.Entries, "later").Position != (Position{X: 20, Y: 1}) {
		t.Fatalf("migration changed coordinates: %+v", workspace.Entries)
	}
	if !workspace.Layout.SnapToGrid || workspace.Layout.Wallpaper != "ember" || workspace.EditorSettings.FontSize != 17 {
		t.Fatalf("migration changed layout or settings: %+v", workspace)
	}
	persisted, err := os.ReadFile(filepath.Join(dir, metadataName))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(persisted, legacy) {
		t.Fatal("workspace.json changed before or after its validated SQLite import")
	}
}

func TestWorkspaceSchemaV3MigrationDropsTopologyAndPreservesSignedCoordinates(t *testing.T) {
	dir := t.TempDir()
	filesDir := filepath.Join(dir, "files")
	if err := os.MkdirAll(filepath.Join(filesDir, "Root"), 0o700); err != nil {
		t.Fatal(err)
	}
	legacy := []byte(`{"schemaVersion":3,"workspaceId":"workspace","initialized":true,"revision":4,"entries":[{"kind":"folder","id":"root","name":"Root","parentId":null,"modifiedAt":1,"position":{"x":-120.5,"y":44},"revision":4,"contentRevision":0}],"layout":{"rootOrder":["root"],"workspaceBreaks":[{"entryId":"root","maxCapacity":8}],"snapToGrid":true,"wallpaper":"grove"},"layoutRevision":3,"editorSettings":{"autoSave":true,"fontSize":13,"language":"auto"},"settingsRevision":2}`)
	if err := os.WriteFile(filepath.Join(dir, metadataName), legacy, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, logicalMarker), []byte("1\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	store, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	workspace := store.snapshot()
	if workspace.SchemaVersion != workspaceSchemaVersion || workspace.Revision != 4 || workspace.LayoutRevision != 3 || findEntry(t, workspace.Entries, "root").Position != (Position{X: -120.5, Y: 44}) {
		t.Fatalf("v3 migration = %+v", workspace)
	}
	persisted, err := os.ReadFile(filepath.Join(dir, metadataName))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(persisted, legacy) {
		t.Fatal("workspace.json changed before or after its validated SQLite import")
	}
}

func TestOpenStoreRejectsSymlinkedFilesRoot(t *testing.T) {
	dir := t.TempDir()
	target := t.TempDir()
	if err := os.Symlink(target, filepath.Join(dir, "files")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if store, err := OpenStore(dir); err == nil {
		_ = store.Close()
		t.Fatal("OpenStore accepted a symlinked files directory")
	}
}

func TestMigratesIDKeyedStorageToLogicalPaths(t *testing.T) {
	dir := t.TempDir()
	filesDir := filepath.Join(dir, "files")
	if err := os.MkdirAll(filesDir, 0o700); err != nil {
		t.Fatal(err)
	}
	b := []byte(`{"schemaVersion":1,"initialized":true,"revision":4,"entries":[{"kind":"folder","id":"folder-id","name":"Docs","parentId":null,"modifiedAt":1,"position":{"x":1,"y":2},"viewId":"view-1","revision":2,"contentRevision":0},{"kind":"file","id":"file-id","name":"notes.txt","parentId":"folder-id","modifiedAt":1,"position":{"x":1,"y":2},"viewId":null,"mimeType":"text/plain","size":5,"revision":4,"contentRevision":4}],"layout":{"views":[{"id":"view-1"}],"columns":1,"snapToGrid":false,"wallpaper":"dusk"},"layoutRevision":1,"editorSettings":{"autoSave":true,"fontSize":13,"language":"auto"},"settingsRevision":1}`)
	if err := os.WriteFile(filepath.Join(dir, metadataName), b, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(filesDir, "file-id"), []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}

	store, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	content, err := os.ReadFile(filepath.Join(filesDir, "Docs", "notes.txt"))
	if err != nil || string(content) != "hello" {
		t.Fatalf("migrated content = %q, %v", content, err)
	}
	if _, err := os.Stat(filepath.Join(filesDir, "file-id")); !os.IsNotExist(err) {
		t.Fatalf("ID-keyed blob remains after migration: %v", err)
	}
	if snapshot := store.snapshot(); snapshot.Revision != 4 || findEntry(t, snapshot.Entries, "file-id").Name != "notes.txt" {
		t.Fatalf("migration changed API identity or revision: %+v", snapshot)
	}
}

func TestMigrationPreservesUnknownLegacyFiles(t *testing.T) {
	dir := t.TempDir()
	filesDir := filepath.Join(dir, "files")
	if err := os.MkdirAll(filesDir, 0o700); err != nil {
		t.Fatal(err)
	}
	b := []byte(`{"schemaVersion":1,"initialized":true,"revision":1,"entries":[{"kind":"file","id":"known","name":"known.txt","parentId":null,"modifiedAt":1,"position":{"x":1,"y":2},"viewId":"view-1","mimeType":"text/plain","size":5,"revision":1,"contentRevision":1}],"layout":{"views":[{"id":"view-1"}],"columns":1,"snapToGrid":false,"wallpaper":"dusk"},"layoutRevision":1,"editorSettings":{"autoSave":true,"fontSize":13,"language":"auto"},"settingsRevision":1}`)
	if err := os.WriteFile(filepath.Join(dir, metadataName), b, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(filesDir, "known"), []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(filesDir, "orphan"), []byte("recover me"), 0o600); err != nil {
		t.Fatal(err)
	}

	store, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	recoveryDirs, err := filepath.Glob(filepath.Join(dir, ".legacy-files-recovery-*"))
	if err != nil || len(recoveryDirs) != 1 {
		t.Fatalf("legacy recovery directories = %v, %v", recoveryDirs, err)
	}
	content, err := os.ReadFile(filepath.Join(recoveryDirs[0], "orphan"))
	if err != nil || string(content) != "recover me" {
		t.Fatalf("preserved orphan = %q, %v", content, err)
	}
}

func TestLogicalPathsFollowAPIRenameMoveAndDelete(t *testing.T) {
	store, server := initializedTestServer(t)
	for _, item := range []struct {
		entry   Entry
		content *string
	}{
		{folder("a", "A", nil, ptr("view-1")), nil},
		{folder("b", "B", nil, ptr("view-1")), nil},
		{file("f", "draft.txt", ptr("a"), nil, "text/plain", 0), ptr("draft")},
	} {
		response := multipartEntryRequest(t, server, http.MethodPost, "/api/entries", item.entry, item.content)
		if response.Code != http.StatusOK {
			t.Fatalf("create %s: %d %s", item.entry.ID, response.Code, response.Body.String())
		}
	}
	if info, err := os.Stat(filepath.Join(store.filesDir, "A")); err != nil || !info.IsDir() {
		t.Fatalf("logical folder was not created: %v", err)
	}
	entry := findEntry(t, store.snapshot().Entries, "f")
	entry.Name = "final.txt"
	entry.ParentID = ptr("b")
	response := jsonRequest(t, server, http.MethodPatch, "/api/entries/f", entry)
	if response.Code != http.StatusOK {
		t.Fatalf("move file: %d %s", response.Code, response.Body.String())
	}
	content, err := os.ReadFile(filepath.Join(store.filesDir, "B", "final.txt"))
	if err != nil || string(content) != "draft" {
		t.Fatalf("moved logical content = %q, %v", content, err)
	}
	if _, err := os.Stat(filepath.Join(store.filesDir, "A", "draft.txt")); !os.IsNotExist(err) {
		t.Fatalf("old logical path remains: %v", err)
	}
	response = httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodDelete, "/api/entries/b", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("delete folder: %d %s", response.Code, response.Body.String())
	}
	if _, err := os.Stat(filepath.Join(store.filesDir, "B")); !os.IsNotExist(err) {
		t.Fatalf("deleted logical directory remains: %v", err)
	}
	before := store.snapshot().Revision
	time.Sleep(3 * watchDebounce)
	if got := store.snapshot().Revision; got != before {
		t.Fatalf("watcher duplicated API mutation revision: got %d, want %d", got, before)
	}
}

func TestExternalFilesystemChangesReconcileLive(t *testing.T) {
	store, _ := initializedTestServer(t)
	if err := os.Mkdir(filepath.Join(store.filesDir, "External"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(store.filesDir, "External", "note.md"), []byte("one"), 0o600); err != nil {
		t.Fatal(err)
	}
	waitForRevision(t, store, 2)
	first := store.snapshot()
	folderEntry := findEntryByName(t, first.Entries, "External")
	fileEntry := findEntryByName(t, first.Entries, "note.md")
	if folderEntry.ParentID != nil || folderEntry.Position != (Position{X: 24, Y: 24}) {
		t.Fatalf("external root placement = %+v", folderEntry)
	}
	if fileEntry.ParentID == nil || *fileEntry.ParentID != folderEntry.ID || !strings.HasPrefix(fileEntry.MimeType, "text/markdown") {
		t.Fatalf("external nested metadata = %+v", fileEntry)
	}

	if err := os.WriteFile(filepath.Join(store.filesDir, "External", "note.md"), []byte("two"), 0o600); err != nil {
		t.Fatal(err)
	}
	waitForRevision(t, store, 3)
	edited := findEntryByName(t, store.snapshot().Entries, "note.md")
	if edited.ID != fileEntry.ID || edited.ContentRevision != 3 || edited.Size != 3 {
		t.Fatalf("same-path external edit did not preserve identity: old=%+v new=%+v", fileEntry, edited)
	}

	if err := os.Rename(filepath.Join(store.filesDir, "External", "note.md"), filepath.Join(store.filesDir, "External", "renamed.md")); err != nil {
		t.Fatal(err)
	}
	waitForRevision(t, store, 4)
	renamed := findEntryByName(t, store.snapshot().Entries, "renamed.md")
	if renamed.ID == fileEntry.ID || entryIndex(store.snapshot().Entries, fileEntry.ID) >= 0 {
		t.Fatalf("external rename retained old identity: old=%s new=%s", fileEntry.ID, renamed.ID)
	}

	linkPath := filepath.Join(store.filesDir, "linked.txt")
	if err := os.Symlink(filepath.Join(store.filesDir, "External", "renamed.md"), linkPath); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	time.Sleep(3 * watchDebounce)
	if entryWithName(store.snapshot().Entries, "linked.txt") != nil {
		t.Fatal("watcher imported a symbolic link")
	}
}

func TestExternalSameSizeEditDetectedAtStartup(t *testing.T) {
	dir := t.TempDir()
	store, server := newTestServer(t, dir)
	response := bootstrapRequest(t, server, testBootstrap(), nil)
	if response.Code != http.StatusCreated {
		t.Fatal(response.Body.String())
	}
	response = multipartEntryRequest(t, server, http.MethodPost, "/api/entries", file("stable-id", "same.txt", nil, ptr("view-1"), "text/plain", 0), ptr("one"))
	if response.Code != http.StatusOK {
		t.Fatal(response.Body.String())
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "files", "same.txt"), []byte("two"), 0o600); err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	entry := findEntry(t, reopened.snapshot().Entries, "stable-id")
	if reopened.snapshot().Revision != 3 || entry.ContentRevision != 3 || entry.ID != "stable-id" {
		t.Fatalf("startup reconciliation = %+v workspace=%+v", entry, reopened.snapshot())
	}
	if err := reopened.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestExternalAdditionDetectedAtStartupWithEmptyIndex(t *testing.T) {
	dir := t.TempDir()
	store, server := newTestServer(t, dir)
	response := bootstrapRequest(t, server, testBootstrap(), nil)
	if response.Code != http.StatusCreated {
		t.Fatal(response.Body.String())
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "files", "outside.txt"), []byte("added while stopped"), 0o600); err != nil {
		t.Fatal(err)
	}

	reopened, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	snapshot := reopened.snapshot()
	entry := findEntryByName(t, snapshot.Entries, "outside.txt")
	if snapshot.Revision != 2 || entry.ContentRevision != 2 {
		t.Fatalf("startup addition reconciliation = %+v workspace=%+v", entry, snapshot)
	}
}

func TestMetadataMutationDoesNotSwallowExternalEdit(t *testing.T) {
	store, server := initializedTestServer(t)
	response := multipartEntryRequest(t, server, http.MethodPost, "/api/entries", file("stable", "stable.txt", nil, ptr("view-1"), "text/plain", 0), ptr("before"))
	if response.Code != http.StatusOK {
		t.Fatal(response.Body.String())
	}
	if err := os.WriteFile(filepath.Join(store.filesDir, "stable.txt"), []byte("after"), 0o600); err != nil {
		t.Fatal(err)
	}
	settings := jsonRequest(t, server, http.MethodPut, "/api/editor-settings", EditorSettings{AutoSave: false, FontSize: 13, Language: "auto"})
	if settings.Code != http.StatusOK {
		t.Fatal(settings.Body.String())
	}
	waitForRevision(t, store, 4)
	entry := findEntry(t, store.snapshot().Entries, "stable")
	if entry.ContentRevision <= 2 || entry.Size != 5 {
		t.Fatalf("external edit was swallowed by metadata mutation: %+v", entry)
	}
}

func TestFilesystemReconciliationRetriesAfterConcurrentMutation(t *testing.T) {
	store, _ := initializedTestServer(t)
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	release := make(chan struct{})
	var calls atomic.Int32
	store.scanFiles = func(root string) (map[string]diskNode, error) {
		nodes, err := scanFilesystem(root)
		if calls.Add(1) == 1 {
			close(started)
			<-release
		}
		return nodes, err
	}
	done := make(chan error, 1)
	go func() { done <- store.reconcileFilesystem() }()
	<-started
	store.mu.Lock()
	store.beginMutationLocked()
	store.mu.Unlock()
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if calls.Load() < 2 {
		t.Fatalf("filesystem scans = %d, want retry", calls.Load())
	}
}

func TestFailedBootstrapRemovesStagedLogicalTree(t *testing.T) {
	dir := t.TempDir()
	store, server := newTestServer(t, dir)
	store.persistWorkspace = func(Workspace, bool, *mutationReceipt, *ActivityRecord) error {
		return errors.New("injected persistence failure")
	}
	workspace := testBootstrap()
	workspace.Entries = []Entry{file("file", "retry.txt", nil, ptr("view-1"), "text/plain", 5)}
	response := bootstrapRequest(t, server, workspace, map[string]string{"file": "hello"})
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("failed bootstrap status = %d, body = %s", response.Code, response.Body.String())
	}
	if _, err := os.Stat(filepath.Join(store.filesDir, "retry.txt")); !os.IsNotExist(err) {
		t.Fatalf("failed bootstrap left logical content: %v", err)
	}
	if store.snapshot().Initialized {
		t.Fatal("failed bootstrap initialized workspace")
	}
}

func TestFailedContentPersistenceRestoresExistingBytes(t *testing.T) {
	store, server := initializedTestServer(t)
	created := multipartEntryRequest(t, server, http.MethodPost, "/api/entries", file("file", "old.txt", nil, ptr("view-1"), "text/plain", 0), ptr("old bytes"))
	if created.Code != http.StatusOK {
		t.Fatal(created.Body.String())
	}
	before := store.snapshot()
	store.persistWorkspace = func(Workspace, bool, *mutationReceipt, *ActivityRecord) error {
		return errors.New("injected persistence failure")
	}

	request := httptest.NewRequest(http.MethodPut, "/api/files/file/content", strings.NewReader("new bytes"))
	request.Header.Set("Content-Type", "text/plain")
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	content, err := os.ReadFile(filepath.Join(store.filesDir, "old.txt"))
	if err != nil || string(content) != "old bytes" {
		t.Fatalf("rolled-back content = %q, %v", content, err)
	}
	if after := store.snapshot(); after.Revision != before.Revision || findEntry(t, after.Entries, "file").ContentRevision != findEntry(t, before.Entries, "file").ContentRevision {
		t.Fatalf("failed update changed metadata: before=%+v after=%+v", before, after)
	}
	assertNoContentBackups(t, store.dir)
}

func TestFailedMoveAndContentPersistenceRestoresPathAndBytes(t *testing.T) {
	store, server := initializedTestServer(t)
	created := multipartEntryRequest(t, server, http.MethodPost, "/api/entries", file("file", "old.txt", nil, ptr("view-1"), "text/plain", 0), ptr("old bytes"))
	if created.Code != http.StatusOK {
		t.Fatal(created.Body.String())
	}
	entry := findEntry(t, store.snapshot().Entries, "file")
	entry.Name = "new.txt"
	store.persistWorkspace = func(Workspace, bool, *mutationReceipt, *ActivityRecord) error {
		return errors.New("injected persistence failure")
	}

	response := multipartEntryRequest(t, server, http.MethodPost, "/api/entries", entry, ptr("new bytes"))
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	content, err := os.ReadFile(filepath.Join(store.filesDir, "old.txt"))
	if err != nil || string(content) != "old bytes" {
		t.Fatalf("rolled-back moved content = %q, %v", content, err)
	}
	if _, err := os.Stat(filepath.Join(store.filesDir, "new.txt")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("replacement path remains after rollback: %v", err)
	}
	if got := findEntry(t, store.snapshot().Entries, "file").Name; got != "old.txt" {
		t.Fatalf("failed move changed metadata name to %q", got)
	}
	assertNoContentBackups(t, store.dir)
}

func assertNoContentBackups(t *testing.T, root string) {
	t.Helper()
	matches, err := filepath.Glob(filepath.Join(root, ".content-backup-*"))
	if err != nil || len(matches) != 0 {
		t.Fatalf("content backups = %v, %v", matches, err)
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
		content, err := os.ReadFile(filepath.Join(store.filesDir, entry.Name))
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

func TestImportNestedMixedTreeAtomically(t *testing.T) {
	store, server := initializedTestServer(t)
	if response := multipartEntryRequest(t, server, http.MethodPost, "/api/entries", folder("destination", "Destination", nil, nil), nil); response.Code != http.StatusOK {
		t.Fatal(response.Body.String())
	}
	events, unsubscribe := store.subscribe()
	defer unsubscribe()
	<-events
	entries := []Entry{
		file("nested-file", "notes.txt", ptr("nested-folder"), nil, "text/plain", 5),
		folder("empty-folder", "Empty", ptr("import-root"), nil),
		folder("import-root", "Copied", ptr("destination"), nil),
		folder("nested-folder", "Docs", ptr("import-root"), nil),
	}
	response := idempotentImportRequest(t, server, entries, map[string]string{"nested-file": "hello"}, "browser-1", "tree-import")
	if response.Code != http.StatusOK {
		t.Fatalf("import status = %d, body = %s", response.Code, response.Body.String())
	}
	var result importResponse
	decodeResponse(t, response, &result)
	if result.Revision != 3 || len(result.Entries) != len(entries) {
		t.Fatalf("import response = %+v", result)
	}
	for _, entry := range result.Entries {
		if entry.Revision != 3 || entry.Kind == "folder" && entry.ContentRevision != 0 || entry.Kind == "file" && entry.ContentRevision != 3 {
			t.Errorf("imported revisions for %s = %+v", entry.ID, entry)
		}
	}
	content, err := os.ReadFile(filepath.Join(store.filesDir, "Destination", "Copied", "Docs", "notes.txt"))
	if err != nil || string(content) != "hello" {
		t.Fatalf("nested content = %q, %v", content, err)
	}
	if info, err := os.Stat(filepath.Join(store.filesDir, "Destination", "Copied", "Empty")); err != nil || !info.IsDir() {
		t.Fatalf("empty imported folder = %v, %v", info, err)
	}
	if revision := <-events; revision != 3 {
		t.Fatalf("import SSE revision = %d", revision)
	}
	retry := idempotentImportRequest(t, server, entries, map[string]string{"nested-file": "hello"}, "browser-1", "tree-import")
	if retry.Code != http.StatusOK || retry.Header().Get(replayHeader) != "true" || retry.Body.String() != response.Body.String() || store.snapshot().Revision != 3 {
		t.Fatalf("import retry = %d %q headers=%v", retry.Code, retry.Body.String(), retry.Header())
	}
}

func TestFailedNestedImportRemovesPromotedTree(t *testing.T) {
	store, server := initializedTestServer(t)
	before := store.snapshot()
	store.persistWorkspace = func(Workspace, bool, *mutationReceipt, *ActivityRecord) error {
		return errors.New("injected persistence failure")
	}
	entries := []Entry{
		folder("root", "Copied", nil, nil),
		file("child", "child.txt", ptr("root"), nil, "text/plain", 5),
	}
	response := importRequest(t, server, entries, map[string]string{"child": "hello"})
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("failed import status = %d, body = %s", response.Code, response.Body.String())
	}
	if after := store.snapshot(); after.Revision != before.Revision || len(after.Entries) != len(before.Entries) {
		t.Fatalf("failed import changed workspace: before=%+v after=%+v", before, after)
	}
	if _, err := os.Stat(filepath.Join(store.filesDir, "Copied")); !os.IsNotExist(err) {
		t.Fatalf("failed import left promoted tree: %v", err)
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
		{
			name:    "folder with file part",
			entries: []Entry{folder("folder-content", "Folder", nil, nil)},
			files:   map[string]string{"folder-content": "unexpected"},
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
				if _, err := os.Stat(filepath.Join(store.filesDir, entry.Name)); !os.IsNotExist(err) {
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
	if _, err := os.Stat(filepath.Join(store.filesDir, "new.txt")); !os.IsNotExist(err) {
		t.Fatalf("existing-ID batch wrote new blob: %v", err)
	}
	content, err := os.ReadFile(filepath.Join(store.filesDir, "existing.txt"))
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
		if _, err := os.Stat(filepath.Join(store.filesDir, entry.Name)); !os.IsNotExist(err) {
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
	layout := jsonRequest(t, server, http.MethodPut, "/api/layout", Layout{SnapToGrid: true, Wallpaper: "ember"})
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

func TestDesktopPositionsAreAtomicDurableAndPublishOnce(t *testing.T) {
	store, server := initializedTestServer(t)
	for _, entry := range []Entry{file("first", "first.txt", nil, nil, "text/plain", 0), folder("second", "Second", nil, nil)} {
		var content *string
		if entry.Kind == "file" {
			content = ptr("content")
		}
		if created := multipartEntryRequest(t, server, http.MethodPost, "/api/entries", entry, content); created.Code != http.StatusOK {
			t.Fatal(created.Body.String())
		}
	}
	before := store.snapshot()
	contentRevision := findEntry(t, before.Entries, "first").ContentRevision
	layoutRevision := before.LayoutRevision
	events, unsubscribe := store.subscribe()
	defer unsubscribe()
	<-events
	input := []desktopPosition{
		{EntryID: "first", Position: Position{X: -48, Y: 96}},
		{EntryID: "second", Position: Position{X: 120, Y: -32}},
	}
	response := jsonRequest(t, server, http.MethodPut, "/api/desktop-positions", input)
	if response.Code != http.StatusOK {
		t.Fatalf("positions status = %d, body = %s", response.Code, response.Body.String())
	}
	var result desktopPositionsResponse
	decodeResponse(t, response, &result)
	wantRevision := before.Revision + 1
	if result.Revision != wantRevision || len(result.Entries) != 2 || result.Entries[0].Revision != wantRevision || result.Entries[0].Position != input[0].Position || result.Entries[0].ContentRevision != contentRevision || result.Entries[1].Revision != wantRevision || result.Entries[1].Position != input[1].Position {
		t.Fatalf("positions response = %+v", result)
	}
	if revision := <-events; revision != wantRevision {
		t.Fatalf("positions SSE revision = %d", revision)
	}
	select {
	case revision := <-events:
		t.Fatalf("unexpected second positions SSE event at revision %d", revision)
	default:
	}

	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenStore(store.dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	after := reopened.snapshot()
	first := findEntry(t, after.Entries, "first")
	second := findEntry(t, after.Entries, "second")
	if after.Revision != wantRevision || after.LayoutRevision != layoutRevision || first.Position != input[0].Position || first.Revision != wantRevision || first.ContentRevision != contentRevision || second.Position != input[1].Position || second.Revision != wantRevision {
		t.Fatalf("restarted positions = %+v", after)
	}
}

func TestDesktopPositionsValidateBatchAndFailureChangesNothing(t *testing.T) {
	store, server := initializedTestServer(t)
	if response := multipartEntryRequest(t, server, http.MethodPost, "/api/entries", folder("root", "Root", nil, nil), nil); response.Code != http.StatusOK {
		t.Fatal(response.Body.String())
	}
	if response := multipartEntryRequest(t, server, http.MethodPost, "/api/entries", folder("child", "Child", ptr("root"), nil), nil); response.Code != http.StatusOK {
		t.Fatal(response.Body.String())
	}
	before := store.snapshot()
	events, unsubscribe := store.subscribe()
	defer unsubscribe()
	<-events
	invalid := jsonRequest(t, server, http.MethodPut, "/api/desktop-positions", []desktopPosition{{EntryID: "root", Position: Position{X: 9, Y: 10}}, {EntryID: "child", Position: Position{X: 3, Y: 4}}})
	if invalid.Code != http.StatusConflict || store.snapshot().Revision != before.Revision {
		t.Fatalf("invalid batch = %d %s", invalid.Code, invalid.Body.String())
	}
	duplicate := jsonRequest(t, server, http.MethodPut, "/api/desktop-positions", []desktopPosition{{EntryID: "root"}, {EntryID: "root"}})
	if duplicate.Code != http.StatusBadRequest || store.snapshot().Revision != before.Revision {
		t.Fatalf("duplicate batch = %d %s", duplicate.Code, duplicate.Body.String())
	}
	store.persistWorkspace = func(Workspace, bool, *mutationReceipt, *ActivityRecord) error {
		return errors.New("injected persistence failure")
	}
	response := jsonRequest(t, server, http.MethodPut, "/api/desktop-positions", []desktopPosition{{EntryID: "root", Position: Position{X: -9, Y: 10}}})
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("positions failure status = %d, body = %s", response.Code, response.Body.String())
	}
	after := store.snapshot()
	if after.Revision != before.Revision || findEntry(t, after.Entries, "root").Position != findEntry(t, before.Entries, "root").Position || after.Layout != before.Layout {
		t.Fatalf("failed positions changed workspace: before=%+v after=%+v", before, after)
	}
	select {
	case revision := <-events:
		t.Fatalf("failed positions published revision %d", revision)
	default:
	}
}

func TestBatchMoveIsAtomicAndRollsBackFilesystem(t *testing.T) {
	store, server := initializedTestServer(t)
	for _, item := range []struct {
		entry   Entry
		content *string
	}{
		{folder("destination", "Destination", nil, nil), nil},
		{folder("folder", "Folder", nil, nil), nil},
		{file("nested", "nested.txt", ptr("folder"), nil, "text/plain", 0), ptr("nested")},
		{file("loose", "loose.txt", nil, nil, "text/plain", 0), ptr("loose")},
	} {
		if response := multipartEntryRequest(t, server, http.MethodPost, "/api/entries", item.entry, item.content); response.Code != http.StatusOK {
			t.Fatalf("create %s: %s", item.entry.ID, response.Body.String())
		}
	}
	events, unsubscribe := store.subscribe()
	defer unsubscribe()
	<-events
	before := store.snapshot()
	response := jsonRequest(t, server, http.MethodPost, "/api/entries/batch-move", batchMoveRequest{EntryIDs: []string{"folder", "loose"}, ParentID: ptr("destination")})
	if response.Code != http.StatusOK {
		t.Fatalf("move status = %d, body = %s", response.Code, response.Body.String())
	}
	var result batchMoveResponse
	decodeResponse(t, response, &result)
	if result.Revision != before.Revision+1 || len(result.Entries) != 2 || result.Entries[0].Revision != result.Revision || result.Entries[1].Revision != result.Revision {
		t.Fatalf("move response = %+v", result)
	}
	for _, path := range []string{
		filepath.Join(store.filesDir, "Destination", "Folder", "nested.txt"),
		filepath.Join(store.filesDir, "Destination", "loose.txt"),
	} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("moved path %q: %v", path, err)
		}
	}
	if revision := <-events; revision != result.Revision {
		t.Fatalf("move SSE revision = %d", revision)
	}

	store.persistWorkspace = func(Workspace, bool, *mutationReceipt, *ActivityRecord) error {
		return errors.New("injected persistence failure")
	}
	failed := jsonRequest(t, server, http.MethodPost, "/api/entries/batch-move", batchMoveRequest{EntryIDs: []string{"folder", "loose"}, ParentID: nil})
	if failed.Code != http.StatusInternalServerError {
		t.Fatalf("failed move status = %d, body = %s", failed.Code, failed.Body.String())
	}
	after := store.snapshot()
	if after.Revision != result.Revision || findEntry(t, after.Entries, "folder").ParentID == nil || *findEntry(t, after.Entries, "folder").ParentID != "destination" {
		t.Fatalf("failed move changed workspace = %+v", after)
	}
	if _, err := os.Stat(filepath.Join(store.filesDir, "Destination", "Folder", "nested.txt")); err != nil {
		t.Fatalf("failed move did not restore folder: %v", err)
	}
	if _, err := os.Stat(filepath.Join(store.filesDir, "Destination", "loose.txt")); err != nil {
		t.Fatalf("failed move did not restore file: %v", err)
	}
	select {
	case revision := <-events:
		t.Fatalf("failed move published revision %d", revision)
	default:
	}
}

func TestMutationResponseDoesNotHoldStoreLock(t *testing.T) {
	store, server := initializedTestServer(t)
	w := &blockingResponseWriter{header: make(http.Header), started: make(chan struct{}), release: make(chan struct{})}
	done := make(chan struct{})
	go func() {
		server.ServeHTTP(w, httptest.NewRequest(http.MethodPut, "/api/editor-settings", strings.NewReader(`{"autoSave":false,"fontSize":13,"language":"auto"}`)))
		close(done)
	}()
	select {
	case <-w.started:
	case <-time.After(5 * time.Second):
		t.Fatal("response did not start")
	}
	snapshotDone := make(chan Workspace, 1)
	go func() { snapshotDone <- store.snapshot() }()
	select {
	case snapshot := <-snapshotDone:
		if snapshot.Revision != 2 {
			t.Fatalf("snapshot revision = %d", snapshot.Revision)
		}
	case <-time.After(time.Second):
		t.Fatal("response encoding retained the store lock")
	}
	close(w.release)
	<-done
}

type blockingResponseWriter struct {
	header  http.Header
	started chan struct{}
	release chan struct{}
}

func (w *blockingResponseWriter) Header() http.Header { return w.header }

func (w *blockingResponseWriter) WriteHeader(int) {
	close(w.started)
	<-w.release
}

func (w *blockingResponseWriter) Write(p []byte) (int, error) { return len(p), nil }

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
	if _, err := os.Stat(filepath.Join(store.filesDir, "Parent")); !os.IsNotExist(err) {
		t.Fatalf("nested blob still exists: %v", err)
	}
	if _, err := os.Stat(filepath.Join(store.filesDir, "keep.txt")); err != nil {
		t.Fatalf("kept blob missing: %v", err)
	}
	if entries := store.snapshot().Entries; len(entries) != 1 || entries[0].ID != "keep" {
		t.Fatalf("remaining entries = %+v", entries)
	}
}

func TestBatchDeleteRecursesOnceAndIsIdempotent(t *testing.T) {
	store, server := initializedTestServer(t)
	for _, item := range []struct {
		entry   Entry
		content *string
	}{
		{folder("parent", "Parent", nil, nil), nil},
		{file("child", "child.txt", ptr("parent"), nil, "text/plain", 0), ptr("child")},
		{file("other", "other.txt", nil, nil, "text/plain", 0), ptr("other")},
		{file("keep", "keep.txt", nil, nil, "text/plain", 0), ptr("keep")},
	} {
		if response := multipartEntryRequest(t, server, http.MethodPost, "/api/entries", item.entry, item.content); response.Code != http.StatusOK {
			t.Fatal(response.Body.String())
		}
	}
	events, unsubscribe := store.subscribe()
	defer unsubscribe()
	<-events
	body, err := json.Marshal(batchDeleteRequest{EntryIDs: []string{"parent", "other"}})
	if err != nil {
		t.Fatal(err)
	}
	before := store.snapshot().Revision
	response := idempotentRequest(server, http.MethodPost, "/api/entries/batch-delete", "application/json", body, "browser-1", "batch-delete")
	if response.Code != http.StatusOK {
		t.Fatalf("delete status = %d, body = %s", response.Code, response.Body.String())
	}
	var result deleteResponse
	decodeResponse(t, response, &result)
	if result.Revision != before+1 || strings.Join(result.DeletedIDs, ",") != "parent,child,other" {
		t.Fatalf("delete response = %+v", result)
	}
	if got := store.snapshot().Entries; len(got) != 1 || got[0].ID != "keep" {
		t.Fatalf("remaining entries = %+v", got)
	}
	for _, path := range []string{filepath.Join(store.filesDir, "Parent"), filepath.Join(store.filesDir, "other.txt")} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("deleted path %q remains: %v", path, err)
		}
	}
	if revision := <-events; revision != result.Revision {
		t.Fatalf("delete SSE revision = %d", revision)
	}
	retry := idempotentRequest(server, http.MethodPost, "/api/entries/batch-delete", "application/json", body, "browser-1", "batch-delete")
	if retry.Code != http.StatusOK || retry.Header().Get(replayHeader) != "true" || retry.Body.String() != response.Body.String() || store.snapshot().Revision != result.Revision {
		t.Fatalf("delete retry = %d %q headers=%v", retry.Code, retry.Body.String(), retry.Header())
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
	cycle := jsonRequest(t, server, http.MethodPatch, "/api/entries/one", parent)
	if cycle.Code != http.StatusConflict {
		t.Fatalf("cycle status = %d, body = %s", cycle.Code, cycle.Body.String())
	}
	badSettings := jsonRequest(t, server, http.MethodPut, "/api/editor-settings", EditorSettings{AutoSave: true, FontSize: 50, Language: "auto"})
	if badSettings.Code != http.StatusBadRequest {
		t.Fatalf("bad settings status = %d", badSettings.Code)
	}
	badWallpaper := jsonRequest(t, server, http.MethodPut, "/api/layout", Layout{Wallpaper: "ocean"})
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
	identity := store.snapshot()
	if event := readSSEEvent(t, reader); event != fmt.Sprintf("id: 1\nevent: workspace\ndata: {\"revision\":1,\"schemaVersion\":%d,\"workspaceId\":%q}\n", workspaceSchemaVersion, identity.WorkspaceID) {
		t.Fatalf("initial SSE event = %q", event)
	}

	mutation := jsonRequest(t, handler, http.MethodPut, "/api/editor-settings", EditorSettings{AutoSave: false, FontSize: 13, Language: "auto"})
	if mutation.Code != http.StatusOK || store.snapshot().Revision != 2 {
		t.Fatalf("mutation failed: %d %s", mutation.Code, mutation.Body.String())
	}
	if event := readSSEEvent(t, reader); event != fmt.Sprintf("id: 2\nevent: workspace\ndata: {\"revision\":2,\"schemaVersion\":%d,\"workspaceId\":%q}\n", workspaceSchemaVersion, identity.WorkspaceID) {
		t.Fatalf("mutation SSE event = %q", event)
	}

	reopened, err := OpenStore(store.dir)
	if err == nil {
		t.Cleanup(func() { _ = reopened.Close() })
	}
	if err != nil || reopened.snapshot().Revision != 2 {
		t.Fatalf("event was published without durable revision: %v %+v", err, reopened)
	}
}

func TestUninitializedSnapshotAndUploadLimit(t *testing.T) {
	_, server := newTestServer(t, t.TempDir())
	snapshot := getWorkspace(t, server)
	if snapshot.Initialized || snapshot.Revision != 0 || snapshot.Entries == nil {
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
	t.Cleanup(func() { _ = store.Close() })
	limited := New(store, t.TempDir(), 3)
	workspace := testBootstrap()
	workspace.Entries = []Entry{file("file", "large.txt", nil, ptr("view-1"), "text/plain", 4)}
	response := bootstrapRequest(t, limited, workspace, map[string]string{"file": "four"})
	if response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized bootstrap status = %d, body = %s", response.Code, response.Body.String())
	}
}

func TestIdempotencyLostResponseRetryAndMismatch(t *testing.T) {
	store, server := initializedTestServer(t)
	body := []byte(`{"autoSave":false,"fontSize":17,"language":"typescript"}`)
	first := idempotentRequest(server, http.MethodPut, "/api/editor-settings", "application/json", body, "browser-1", "settings-1")
	if first.Code != http.StatusOK {
		t.Fatalf("first mutation = %d %s", first.Code, first.Body.String())
	}
	firstBody := first.Body.String()
	retry := idempotentRequest(server, http.MethodPut, "/api/editor-settings", "application/json", body, "browser-1", "settings-1")
	if retry.Code != http.StatusOK || retry.Body.String() != firstBody || retry.Header().Get(replayHeader) != "true" {
		t.Fatalf("retry = %d %q headers=%v", retry.Code, retry.Body.String(), retry.Header())
	}
	if got := store.snapshot().Revision; got != 2 {
		t.Fatalf("retry advanced revision to %d", got)
	}
	different := []byte(`{"autoSave":true,"fontSize":13,"language":"auto"}`)
	mismatch := idempotentRequest(server, http.MethodPut, "/api/editor-settings", "application/json", different, "browser-1", "settings-1")
	if mismatch.Code != http.StatusConflict || store.snapshot().Revision != 2 {
		t.Fatalf("mismatched reuse = %d, revision=%d", mismatch.Code, store.snapshot().Revision)
	}
}

func TestIdempotencyDeleteRetry(t *testing.T) {
	store, server := initializedTestServer(t)
	created := multipartEntryRequest(t, server, http.MethodPost, "/api/entries", folder("folder", "Folder", nil, nil), nil)
	if created.Code != http.StatusOK {
		t.Fatalf("create = %d %s", created.Code, created.Body.String())
	}
	first := idempotentRequest(server, http.MethodDelete, "/api/entries/folder", "", nil, "browser-1", "delete-1")
	retry := idempotentRequest(server, http.MethodDelete, "/api/entries/folder", "", nil, "browser-1", "delete-1")
	if first.Code != http.StatusOK || retry.Code != first.Code || retry.Body.String() != first.Body.String() || retry.Header().Get(replayHeader) != "true" {
		t.Fatalf("delete responses: first=%d %q retry=%d %q", first.Code, first.Body.String(), retry.Code, retry.Body.String())
	}
	if got := store.snapshot(); got.Revision != 3 || len(got.Entries) != 0 {
		t.Fatalf("delete retry workspace = %+v", got)
	}
}

func TestIdempotencyContentAndImportRetry(t *testing.T) {
	store, server := initializedTestServer(t)
	created := multipartEntryRequest(t, server, http.MethodPost, "/api/entries", file("file", "file.txt", nil, nil, "text/plain", 0), ptr("old"))
	if created.Code != http.StatusOK {
		t.Fatalf("create = %d %s", created.Code, created.Body.String())
	}
	content := []byte("new content")
	firstContent := idempotentRequest(server, http.MethodPut, "/api/files/file/content", "text/plain", content, "browser-1", "content-1")
	retryContent := idempotentRequest(server, http.MethodPut, "/api/files/file/content", "text/plain", content, "browser-1", "content-1")
	if firstContent.Code != http.StatusOK || retryContent.Body.String() != firstContent.Body.String() || retryContent.Header().Get(replayHeader) != "true" {
		t.Fatalf("content retry: first=%d retry=%d %s", firstContent.Code, retryContent.Code, retryContent.Body.String())
	}
	entry := file("imported", "imported.txt", nil, nil, "text/plain", 8)
	firstImport := idempotentImportRequest(t, server, []Entry{entry}, map[string]string{"imported": "imported"}, "browser-1", "import-1")
	retryImport := idempotentImportRequest(t, server, []Entry{entry}, map[string]string{"imported": "imported"}, "browser-1", "import-1")
	if firstImport.Code != http.StatusOK || retryImport.Body.String() != firstImport.Body.String() || retryImport.Header().Get(replayHeader) != "true" {
		t.Fatalf("import retry: first=%d %q retry=%d %q", firstImport.Code, firstImport.Body.String(), retryImport.Code, retryImport.Body.String())
	}
	if got := store.snapshot().Revision; got != 4 {
		t.Fatalf("content/import retries advanced revision to %d", got)
	}
	bytesOnDisk, err := os.ReadFile(filepath.Join(store.filesDir, "file.txt"))
	if err != nil || string(bytesOnDisk) != string(content) {
		t.Fatalf("content on disk = %q, %v", bytesOnDisk, err)
	}
}

func TestIdempotencyReceiptSurvivesRestart(t *testing.T) {
	dir := t.TempDir()
	store, server := newTestServer(t, dir)
	if response := bootstrapRequest(t, server, testBootstrap(), nil); response.Code != http.StatusCreated {
		t.Fatalf("bootstrap = %d %s", response.Code, response.Body.String())
	}
	body := []byte(`{"snapToGrid":true,"wallpaper":"grove"}`)
	first := idempotentRequest(server, http.MethodPut, "/api/layout", "application/json", body, "browser-restart", "layout-1")
	if first.Code != http.StatusOK {
		t.Fatalf("first = %d %s", first.Code, first.Body.String())
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	retry := idempotentRequest(New(reopened, t.TempDir(), 10<<20), http.MethodPut, "/api/layout", "application/json", body, "browser-restart", "layout-1")
	if retry.Code != http.StatusOK || retry.Body.String() != first.Body.String() || retry.Header().Get(replayHeader) != "true" || reopened.snapshot().Revision != 2 {
		t.Fatalf("restart retry = %d %q revision=%d", retry.Code, retry.Body.String(), reopened.snapshot().Revision)
	}
}

func TestBootstrapAppearanceDefaultsAndAssignsInitialRevisions(t *testing.T) {
	_, server := newTestServer(t, t.TempDir())
	input := testBootstrap()
	input.Appearance = BootstrapAppearance{
		SelectedThemeID: "custom-one",
		CustomThemes:    []BootstrapCustomTheme{{ID: "custom-one", Name: "Custom One", Definition: testThemeDefinition()}},
	}
	response := bootstrapRequest(t, server, input, nil)
	if response.Code != http.StatusCreated {
		t.Fatalf("bootstrap = %d %s", response.Code, response.Body.String())
	}
	workspace := getWorkspace(t, server)
	if workspace.Appearance.SelectedThemeID != "custom-one" || workspace.Appearance.SelectionRevision != 1 || len(workspace.Appearance.CustomThemes) != 1 || workspace.Appearance.CustomThemes[0].Revision != 1 {
		t.Fatalf("bootstrap appearance = %+v", workspace.Appearance)
	}

	_, defaultServer := initializedTestServer(t)
	if got := getWorkspace(t, defaultServer).Appearance; got.SelectedThemeID != defaultThemeID || got.SelectionRevision != 1 || len(got.CustomThemes) != 0 {
		t.Fatalf("default bootstrap appearance = %+v", got)
	}
}

func TestThemeMutationsAreIndependentDurableAndIdempotent(t *testing.T) {
	dir := t.TempDir()
	store, server := newTestServer(t, dir)
	if response := bootstrapRequest(t, server, testBootstrap(), nil); response.Code != http.StatusCreated {
		t.Fatal(response.Body.String())
	}
	one := BootstrapCustomTheme{ID: "theme-one", Name: "Theme One", Definition: testThemeDefinition()}
	body, err := json.Marshal(one)
	if err != nil {
		t.Fatal(err)
	}
	first := idempotentRequest(server, http.MethodPut, "/api/themes/theme-one", "application/json", body, "themes-client", "upsert-one")
	retry := idempotentRequest(server, http.MethodPut, "/api/themes/theme-one", "application/json", body, "themes-client", "upsert-one")
	if first.Code != http.StatusOK || retry.Body.String() != first.Body.String() || retry.Header().Get(replayHeader) != "true" || store.snapshot().Revision != 2 {
		t.Fatalf("idempotent upsert: first=%d retry=%d revision=%d", first.Code, retry.Code, store.snapshot().Revision)
	}
	two := BootstrapCustomTheme{ID: "theme-two", Name: "Theme Two", Definition: testThemeDefinition()}
	if response := jsonRequest(t, server, http.MethodPut, "/api/themes/theme-two", two); response.Code != http.StatusOK {
		t.Fatal(response.Body.String())
	}
	one.Name = "Theme One Edited"
	if response := jsonRequest(t, server, http.MethodPut, "/api/themes/theme-one", one); response.Code != http.StatusOK {
		t.Fatal(response.Body.String())
	}
	selected := jsonRequest(t, server, http.MethodPut, "/api/theme-selection", map[string]string{"themeId": "theme-one"})
	if selected.Code != http.StatusOK {
		t.Fatal(selected.Body.String())
	}
	beforeDelete := store.snapshot()
	if len(beforeDelete.Appearance.CustomThemes) != 2 || beforeDelete.Appearance.CustomThemes[0].Name != "Theme One Edited" || beforeDelete.Appearance.CustomThemes[1].ID != "theme-two" || beforeDelete.Appearance.SelectionRevision != beforeDelete.Revision {
		t.Fatalf("independent themes = %+v", beforeDelete.Appearance)
	}
	deleted := httptest.NewRecorder()
	server.ServeHTTP(deleted, httptest.NewRequest(http.MethodDelete, "/api/themes/theme-one", nil))
	if deleted.Code != http.StatusOK {
		t.Fatal(deleted.Body.String())
	}
	afterDelete := store.snapshot()
	if afterDelete.Revision != beforeDelete.Revision+1 || afterDelete.Appearance.SelectedThemeID != defaultThemeID || afterDelete.Appearance.SelectionRevision != afterDelete.Revision || len(afterDelete.Appearance.CustomThemes) != 1 || afterDelete.Appearance.CustomThemes[0].ID != "theme-two" {
		t.Fatalf("deleted active theme = %+v", afterDelete)
	}
	repeatedDelete := httptest.NewRecorder()
	server.ServeHTTP(repeatedDelete, httptest.NewRequest(http.MethodDelete, "/api/themes/theme-one", nil))
	if repeatedDelete.Code != http.StatusOK || store.snapshot().Revision != afterDelete.Revision {
		t.Fatalf("repeated delete = %d revision=%d", repeatedDelete.Code, store.snapshot().Revision)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	if got := reopened.snapshot(); got.Revision != afterDelete.Revision || !reflect.DeepEqual(got.Appearance, afterDelete.Appearance) {
		t.Fatalf("restarted appearance = %+v, want %+v", got.Appearance, afterDelete.Appearance)
	}
}

func TestThemeValidationAndMutationFailures(t *testing.T) {
	_, server := initializedTestServer(t)
	definition := testThemeDefinition()
	definition.Colors.Accent = "#12345g"
	invalid := jsonRequest(t, server, http.MethodPut, "/api/themes/invalid", BootstrapCustomTheme{ID: "invalid", Name: "Invalid", Definition: definition})
	if invalid.Code != http.StatusBadRequest {
		t.Fatalf("invalid color = %d %s", invalid.Code, invalid.Body.String())
	}
	builtIn := jsonRequest(t, server, http.MethodPut, "/api/themes/hiraya-dusk", BootstrapCustomTheme{ID: defaultThemeID, Name: "Built in", Definition: testThemeDefinition()})
	if builtIn.Code != http.StatusBadRequest {
		t.Fatalf("built-in upsert = %d", builtIn.Code)
	}
	mismatch := jsonRequest(t, server, http.MethodPut, "/api/themes/path-id", BootstrapCustomTheme{ID: "body-id", Name: "Mismatch", Definition: testThemeDefinition()})
	if mismatch.Code != http.StatusBadRequest {
		t.Fatalf("mismatched IDs = %d", mismatch.Code)
	}
	missingSelection := jsonRequest(t, server, http.MethodPut, "/api/theme-selection", map[string]string{"themeId": "missing"})
	if missingSelection.Code != http.StatusNotFound {
		t.Fatalf("missing selection = %d", missingSelection.Code)
	}
	deleted := httptest.NewRecorder()
	server.ServeHTTP(deleted, httptest.NewRequest(http.MethodDelete, "/api/themes/high-contrast", nil))
	if deleted.Code != http.StatusBadRequest {
		t.Fatalf("built-in delete = %d", deleted.Code)
	}
}

func testThemeDefinition() ThemeDefinition {
	colors := ThemeColors{
		Shell: "#112233", Chrome: "#112233", ChromeText: "#ffffff", Window: "#ffffff",
		WindowMuted: "#eeeeee", Text: "#112233", TextMuted: "#445566", Accent: "#f0c060",
		AccentText: "#112233", Border: "#778899", Danger: "#881111", DangerSurface: "#ffeeee",
		DesktopText: "#ffffff", Selection: "#2255aa", EditorBackground: "#ffffff", EditorText: "#112233",
		EditorGutter: "#112233", EditorKeyword: "#112233", EditorString: "#112233", EditorComment: "#112233",
	}
	return ThemeDefinition{
		Colors: colors, Shape: ThemeShape{Radius: 12, BorderWidth: 1},
		Effects:    ThemeEffects{Blur: 10, Opacity: .9, Shadow: .5},
		Typography: ThemeTypography{Family: "humanist", Scale: 1, Weight: 500},
		Density:    1, Motion: 1, IconSize: 60,
	}
}

func newTestServer(t *testing.T, dir string) (*Store, *Server) {
	t.Helper()
	store, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
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
		Layout:         Layout{Wallpaper: "dusk"},
		EditorSettings: EditorSettings{AutoSave: true, FontSize: 13, Language: "auto"},
	}
}

func folder(id, name string, parentID, viewID *string) Entry {
	return Entry{Kind: "folder", ID: id, Name: name, ParentID: parentID, ModifiedAt: 1, Position: Position{X: 1, Y: 2}}
}

func file(id, name string, parentID, viewID *string, mimeType string, size int64) Entry {
	return Entry{Kind: "file", ID: id, Name: name, ParentID: parentID, ModifiedAt: 1, Position: Position{X: 1, Y: 2}, MimeType: mimeType, Size: size}
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

func idempotentImportRequest(t *testing.T, handler http.Handler, entries []Entry, files map[string]string, clientID, operationID string) *httptest.ResponseRecorder {
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
	return idempotentRequest(handler, http.MethodPost, "/api/imports", w.FormDataContentType(), body.Bytes(), clientID, operationID)
}

func idempotentRequest(handler http.Handler, method, path, contentType string, body []byte, clientID, operationID string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, bytes.NewReader(body))
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	request.Header.Set(clientIDHeader, clientID)
	request.Header.Set(operationIDHeader, operationID)
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

func findEntryByName(t *testing.T, entries []Entry, name string) Entry {
	t.Helper()
	if entry := entryWithName(entries, name); entry != nil {
		return *entry
	}
	t.Fatalf("entry named %q not found", name)
	return Entry{}
}

func entryWithName(entries []Entry, name string) *Entry {
	for i := range entries {
		if entries[i].Name == name {
			return &entries[i]
		}
	}
	return nil
}

func waitForRevision(t *testing.T, store *Store, revision int64) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if got := store.snapshot().Revision; got >= revision {
			if got != revision {
				t.Fatalf("revision advanced more than once: got %d, want %d", got, revision)
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for revision %d; workspace=%+v", revision, store.snapshot())
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
	t.Cleanup(func() { _ = store.Close() })
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

func TestStaticCacheHeaders(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "assets"), 0o700); err != nil {
		t.Fatal(err)
	}
	for path, contents := range map[string]string{
		"index.html":           "index",
		"sw.js":                "worker",
		"assets/app-abc123.js": "asset",
	} {
		if err := os.WriteFile(filepath.Join(dir, filepath.FromSlash(path)), []byte(contents), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	server := New(store, dir, 1024)

	for path, want := range map[string]string{
		"/assets/app-abc123.js": "public, max-age=31536000, immutable",
		"/sw.js":                "no-cache",
		"/route":                "no-cache",
	} {
		response := httptest.NewRecorder()
		server.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusOK {
			t.Fatalf("GET %s = %d", path, response.Code)
		}
		if got := response.Header().Get("Cache-Control"); got != want {
			t.Errorf("GET %s Cache-Control = %q, want %q", path, got, want)
		}
	}
}

func Example_entryResponse() {
	response := entryResponse{Revision: 4, Entry: Entry{Kind: "folder", ID: "docs", Name: "Docs", Revision: 4}}
	b, _ := json.Marshal(response)
	fmt.Println(string(b))
	// Output: {"revision":4,"entry":{"kind":"folder","id":"docs","name":"Docs","parentId":null,"modifiedAt":0,"position":{"x":0,"y":0},"revision":4,"contentRevision":0}}
}
