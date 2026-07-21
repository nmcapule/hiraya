package syncapi

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSQLiteConfigurationAndSchema(t *testing.T) {
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })

	var journalMode string
	var synchronous, foreignKeys, busyTimeout, schemaVersion int
	if err := store.db.QueryRow(`PRAGMA journal_mode`).Scan(&journalMode); err != nil {
		t.Fatal(err)
	}
	if err := store.db.QueryRow(`PRAGMA synchronous`).Scan(&synchronous); err != nil {
		t.Fatal(err)
	}
	if err := store.db.QueryRow(`PRAGMA foreign_keys`).Scan(&foreignKeys); err != nil {
		t.Fatal(err)
	}
	if err := store.db.QueryRow(`PRAGMA busy_timeout`).Scan(&busyTimeout); err != nil {
		t.Fatal(err)
	}
	if err := store.db.QueryRow(`PRAGMA user_version`).Scan(&schemaVersion); err != nil {
		t.Fatal(err)
	}
	if journalMode != "wal" || synchronous != 2 || foreignKeys != 1 || busyTimeout != 5000 || schemaVersion != databaseSchemaVersion {
		t.Fatalf("SQLite configuration = journal=%q synchronous=%d foreign_keys=%d busy_timeout=%d schema=%d",
			journalMode, synchronous, foreignKeys, busyTimeout, schemaVersion)
	}
}

func TestSQLiteMigratesMutationReceiptsSchema(t *testing.T) {
	dir := t.TempDir()
	store, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`DROP TABLE mutation_receipts`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`PRAGMA user_version=1`); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	var schemaVersion int
	var tableName string
	if err := reopened.db.QueryRow(`PRAGMA user_version`).Scan(&schemaVersion); err != nil {
		t.Fatal(err)
	}
	if err := reopened.db.QueryRow(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mutation_receipts'`).Scan(&tableName); err != nil {
		t.Fatal(err)
	}
	if schemaVersion != databaseSchemaVersion || tableName != "mutation_receipts" {
		t.Fatalf("receipt migration = schema %d, table %q", schemaVersion, tableName)
	}
}

func TestWorkspaceJSONImportMarkerIsRestartSafe(t *testing.T) {
	dir := t.TempDir()
	legacy := []byte(`{"schemaVersion":4,"workspaceId":"original","initialized":false,"revision":7,"entries":[],"layout":{"snapToGrid":false,"wallpaper":"dusk"},"layoutRevision":2,"editorSettings":{"autoSave":true,"fontSize":13,"language":"auto"},"settingsRevision":3}`)
	if err := os.WriteFile(filepath.Join(dir, metadataName), legacy, 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	var markers int
	if err := store.db.QueryRow(`SELECT count(*) FROM migration_markers WHERE name = 'workspace.json'`).Scan(&markers); err != nil {
		t.Fatal(err)
	}
	if markers != 1 || store.snapshot().WorkspaceID != "original" {
		t.Fatalf("import marker count = %d, workspace = %+v", markers, store.snapshot())
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	replacement := []byte(`{"schemaVersion":4,"workspaceId":"replacement","initialized":false,"revision":99,"entries":[],"layout":{"snapToGrid":false,"wallpaper":"dusk"},"layoutRevision":2,"editorSettings":{"autoSave":true,"fontSize":13,"language":"auto"},"settingsRevision":3}`)
	if err := os.WriteFile(filepath.Join(dir, metadataName), replacement, 0o600); err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	if got := reopened.snapshot(); got.WorkspaceID != "original" || got.Revision != 7 {
		t.Fatalf("restart re-imported workspace.json: %+v", got)
	}
}

func TestSQLiteTransactionFailureRollsBackAndKeepsMemory(t *testing.T) {
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	before := store.snapshot()
	next := cloneWorkspace(before)
	next.Revision++
	next.Entries = []Entry{
		{Kind: "folder", ID: "duplicate", Name: "One", ModifiedAt: 1, Revision: next.Revision},
		{Kind: "folder", ID: "duplicate", Name: "Two", ModifiedAt: 1, Revision: next.Revision},
	}

	store.mu.Lock()
	err = store.persistLocked(next)
	store.mu.Unlock()
	if err == nil {
		t.Fatal("duplicate entry persistence unexpectedly succeeded")
	}
	if got := store.snapshot(); got.WorkspaceID != before.WorkspaceID || got.Revision != before.Revision || len(got.Entries) != 0 {
		t.Fatalf("failed transaction changed memory: before=%+v after=%+v", before, got)
	}
	persisted, found, err := store.loadDatabaseWorkspace()
	if err != nil {
		t.Fatal(err)
	}
	if !found || persisted.WorkspaceID != before.WorkspaceID || persisted.Revision != before.Revision || len(persisted.Entries) != 0 {
		t.Fatalf("failed transaction changed database: %+v, found=%v", persisted, found)
	}
}
