package syncapi

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	_ "modernc.org/sqlite"
)

const (
	databaseName          = "workspace.sqlite"
	databaseSchemaVersion = 4
	minimumSQLiteVersion  = 3051003
)

func (s *Store) openDatabase() error {
	path := filepath.Join(s.dir, databaseName)
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return fmt.Errorf("open workspace database: %w", err)
	}
	db.SetMaxOpenConns(1)
	s.db = db
	fail := func(err error) error {
		_ = db.Close()
		s.db = nil
		return err
	}

	var version string
	if err := db.QueryRow(`SELECT sqlite_version()`).Scan(&version); err != nil {
		return fail(fmt.Errorf("read SQLite version: %w", err))
	}
	var major, minor, patch int
	if _, err := fmt.Sscanf(version, "%d.%d.%d", &major, &minor, &patch); err != nil || major*1000000+minor*1000+patch < minimumSQLiteVersion {
		return fail(fmt.Errorf("SQLite 3.51.3 or newer is required, found %q", version))
	}
	var journalMode string
	if err := db.QueryRow(`PRAGMA journal_mode=WAL`).Scan(&journalMode); err != nil {
		return fail(fmt.Errorf("enable SQLite WAL: %w", err))
	}
	if !strings.EqualFold(journalMode, "wal") {
		return fail(fmt.Errorf("enable SQLite WAL: journal mode is %q", journalMode))
	}
	for _, pragma := range []string{`PRAGMA synchronous=FULL`, `PRAGMA foreign_keys=ON`, `PRAGMA busy_timeout=5000`} {
		if _, err := db.Exec(pragma); err != nil {
			return fail(fmt.Errorf("configure SQLite: %w", err))
		}
	}
	if err := initializeDatabaseSchema(db); err != nil {
		return fail(err)
	}
	if err := os.Chmod(path, 0o600); err != nil {
		return fail(fmt.Errorf("secure workspace database: %w", err))
	}
	return nil
}

func initializeDatabaseSchema(db *sql.DB) error {
	var version int
	if err := db.QueryRow(`PRAGMA user_version`).Scan(&version); err != nil {
		return fmt.Errorf("read database schema version: %w", err)
	}
	if version < 0 || version > databaseSchemaVersion {
		return fmt.Errorf("unsupported database schema version %d", version)
	}
	if version == databaseSchemaVersion {
		return nil
	}
	tx, err := db.Begin()
	if err != nil {
		return fmt.Errorf("begin database schema initialization: %w", err)
	}
	defer tx.Rollback()
	if version == 0 {
		statements := []string{
			`CREATE TABLE workspace (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            wire_schema_version INTEGER NOT NULL,
            workspace_id TEXT NOT NULL,
            initialized INTEGER NOT NULL CHECK (initialized IN (0, 1)),
            revision INTEGER NOT NULL,
            snap_to_grid INTEGER NOT NULL CHECK (snap_to_grid IN (0, 1)),
            wallpaper TEXT NOT NULL,
            layout_revision INTEGER NOT NULL,
            editor_auto_save INTEGER NOT NULL CHECK (editor_auto_save IN (0, 1)),
            editor_font_size INTEGER NOT NULL,
            editor_language TEXT NOT NULL,
            settings_revision INTEGER NOT NULL
        )`,
			`CREATE TABLE entries (
            ordinal INTEGER PRIMARY KEY CHECK (ordinal >= 0),
            id TEXT NOT NULL UNIQUE,
            kind TEXT NOT NULL,
            name TEXT NOT NULL,
            parent_id TEXT REFERENCES entries(id) DEFERRABLE INITIALLY DEFERRED,
            modified_at INTEGER NOT NULL,
            position_x REAL NOT NULL,
            position_y REAL NOT NULL,
            mime_type TEXT NOT NULL,
            size INTEGER NOT NULL,
            revision INTEGER NOT NULL,
            content_revision INTEGER NOT NULL
        )`,
			`CREATE TABLE migration_markers (
            name TEXT PRIMARY KEY,
            completed_at INTEGER NOT NULL DEFAULT (unixepoch())
        )`,
		}
		for _, statement := range statements {
			if _, err := tx.Exec(statement); err != nil {
				return fmt.Errorf("create database schema: %w", err)
			}
		}
		version = 1
	}
	if version == 1 {
		if _, err := tx.Exec(`CREATE TABLE mutation_receipts (
            client_id TEXT NOT NULL,
            operation_id TEXT NOT NULL,
            endpoint TEXT NOT NULL,
            request_hash BLOB NOT NULL CHECK (length(request_hash) = 32),
            status INTEGER NOT NULL CHECK (status BETWEEN 200 AND 299),
            response_body BLOB NOT NULL CHECK (length(response_body) <= 8388608),
            revision INTEGER NOT NULL CHECK (revision >= 0),
            created_at INTEGER NOT NULL DEFAULT (unixepoch()),
            PRIMARY KEY (client_id, operation_id)
        )`); err != nil {
			return fmt.Errorf("migrate database schema to version 2: %w", err)
		}
		version = 2
	}
	if version == 2 {
		statements := []string{
			`ALTER TABLE workspace ADD COLUMN selected_theme_id TEXT NOT NULL DEFAULT 'hiraya-dusk'`,
			`ALTER TABLE workspace ADD COLUMN theme_selection_revision INTEGER NOT NULL DEFAULT 0`,
			`CREATE TABLE custom_themes (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            definition_json TEXT NOT NULL,
            revision INTEGER NOT NULL
        )`,
			`UPDATE workspace SET selected_theme_id = 'hiraya-dusk',
		    theme_selection_revision = 0, wire_schema_version = 5`,
		}
		for _, statement := range statements {
			if _, err := tx.Exec(statement); err != nil {
				return fmt.Errorf("migrate database schema to version 3: %w", err)
			}
		}
		version = 3
	}
	if version == 3 {
		if _, err := tx.Exec(`CREATE TABLE IF NOT EXISTS activity (
            revision INTEGER PRIMARY KEY CHECK (revision > 0),
            action TEXT NOT NULL,
            source TEXT NOT NULL,
            occurred_at INTEGER NOT NULL,
            summary TEXT NOT NULL,
            details_json TEXT NOT NULL,
            search_text TEXT NOT NULL
        )`); err != nil {
			return fmt.Errorf("migrate database schema to version 4: %w", err)
		}
	}
	if _, err := tx.Exec(fmt.Sprintf(`PRAGMA user_version=%d`, databaseSchemaVersion)); err != nil {
		return fmt.Errorf("set database schema version: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit database schema: %w", err)
	}
	return nil
}

func (s *Store) loadDatabaseWorkspace() (Workspace, bool, error) {
	var workspace Workspace
	var initialized, snapToGrid, autoSave int
	err := s.db.QueryRow(`SELECT wire_schema_version, workspace_id, initialized, revision,
        snap_to_grid, wallpaper, layout_revision, editor_auto_save, editor_font_size,
        editor_language, settings_revision, selected_theme_id, theme_selection_revision
        FROM workspace WHERE singleton = 1`).Scan(
		&workspace.SchemaVersion, &workspace.WorkspaceID, &initialized, &workspace.Revision,
		&snapToGrid, &workspace.Layout.Wallpaper, &workspace.LayoutRevision, &autoSave,
		&workspace.EditorSettings.FontSize, &workspace.EditorSettings.Language, &workspace.SettingsRevision,
		&workspace.Appearance.SelectedThemeID, &workspace.Appearance.SelectionRevision,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return Workspace{}, false, nil
	}
	if err != nil {
		return Workspace{}, false, fmt.Errorf("load workspace database: %w", err)
	}
	workspace.Initialized = initialized != 0
	workspace.Layout.SnapToGrid = snapToGrid != 0
	workspace.EditorSettings.AutoSave = autoSave != 0
	if workspace.SchemaVersion != workspaceSchemaVersion {
		return Workspace{}, false, fmt.Errorf("stored workspace has unsupported wire schema version %d", workspace.SchemaVersion)
	}
	rows, err := s.db.Query(`SELECT id, kind, name, parent_id, modified_at, position_x, position_y,
        mime_type, size, revision, content_revision FROM entries ORDER BY ordinal`)
	if err != nil {
		return Workspace{}, false, fmt.Errorf("load workspace entries: %w", err)
	}
	defer rows.Close()
	workspace.Entries = []Entry{}
	for rows.Next() {
		var entry Entry
		var parentID sql.NullString
		if err := rows.Scan(&entry.ID, &entry.Kind, &entry.Name, &parentID, &entry.ModifiedAt,
			&entry.Position.X, &entry.Position.Y, &entry.MimeType, &entry.Size, &entry.Revision, &entry.ContentRevision); err != nil {
			return Workspace{}, false, fmt.Errorf("load workspace entry: %w", err)
		}
		if parentID.Valid {
			entry.ParentID = &parentID.String
		}
		workspace.Entries = append(workspace.Entries, entry)
	}
	if err := rows.Err(); err != nil {
		return Workspace{}, false, fmt.Errorf("load workspace entries: %w", err)
	}
	themeRows, err := s.db.Query(`SELECT id, name, definition_json, revision FROM custom_themes ORDER BY rowid`)
	if err != nil {
		return Workspace{}, false, fmt.Errorf("load custom themes: %w", err)
	}
	defer themeRows.Close()
	workspace.Appearance.CustomThemes = []CustomTheme{}
	for themeRows.Next() {
		var theme CustomTheme
		var definition []byte
		if err := themeRows.Scan(&theme.ID, &theme.Name, &definition, &theme.Revision); err != nil {
			return Workspace{}, false, fmt.Errorf("load custom theme: %w", err)
		}
		if err := json.Unmarshal(definition, &theme.Definition); err != nil {
			return Workspace{}, false, fmt.Errorf("decode custom theme %q: %w", theme.ID, err)
		}
		workspace.Appearance.CustomThemes = append(workspace.Appearance.CustomThemes, theme)
	}
	if err := themeRows.Err(); err != nil {
		return Workspace{}, false, fmt.Errorf("load custom themes: %w", err)
	}
	if !validID(workspace.WorkspaceID) {
		return Workspace{}, false, fmt.Errorf("stored workspace has invalid workspace ID")
	}
	if err := validateAppearance(workspace.Appearance); err != nil {
		return Workspace{}, false, fmt.Errorf("stored workspace: %w", err)
	}
	if workspace.Initialized {
		if err := validateSettings(workspace.EditorSettings); err != nil {
			return Workspace{}, false, fmt.Errorf("stored workspace: %w", err)
		}
		if err := validateWorkspace(workspace.Entries, workspace.Layout, workspace.Appearance); err != nil {
			return Workspace{}, false, fmt.Errorf("stored workspace: %w", err)
		}
	}
	return workspace, true, nil
}

func (s *Store) persistDatabaseWithActivity(next Workspace, importedJSON bool, receipt *mutationReceipt, activity *ActivityRecord) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM entries`); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM custom_themes`); err != nil {
		return err
	}
	_, err = tx.Exec(`INSERT INTO workspace (singleton, wire_schema_version, workspace_id, initialized,
        revision, snap_to_grid, wallpaper, layout_revision, editor_auto_save, editor_font_size,
        editor_language, settings_revision, selected_theme_id, theme_selection_revision)
        VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET wire_schema_version=excluded.wire_schema_version,
        workspace_id=excluded.workspace_id, initialized=excluded.initialized, revision=excluded.revision,
        snap_to_grid=excluded.snap_to_grid, wallpaper=excluded.wallpaper, layout_revision=excluded.layout_revision,
        editor_auto_save=excluded.editor_auto_save, editor_font_size=excluded.editor_font_size,
        editor_language=excluded.editor_language, settings_revision=excluded.settings_revision,
        selected_theme_id=excluded.selected_theme_id, theme_selection_revision=excluded.theme_selection_revision`,
		next.SchemaVersion, next.WorkspaceID, next.Initialized, next.Revision, next.Layout.SnapToGrid,
		next.Layout.Wallpaper, next.LayoutRevision, next.EditorSettings.AutoSave,
		next.EditorSettings.FontSize, next.EditorSettings.Language, next.SettingsRevision,
		next.Appearance.SelectedThemeID, next.Appearance.SelectionRevision)
	if err != nil {
		return err
	}
	for ordinal, entry := range next.Entries {
		if _, err := tx.Exec(`INSERT INTO entries (ordinal, id, kind, name, parent_id, modified_at,
            position_x, position_y, mime_type, size, revision, content_revision)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, ordinal, entry.ID, entry.Kind, entry.Name,
			entry.ParentID, entry.ModifiedAt, entry.Position.X, entry.Position.Y, entry.MimeType,
			entry.Size, entry.Revision, entry.ContentRevision); err != nil {
			return err
		}
	}
	for _, theme := range next.Appearance.CustomThemes {
		definition, err := json.Marshal(theme.Definition)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(`INSERT INTO custom_themes (id, name, definition_json, revision) VALUES (?, ?, ?, ?)`,
			theme.ID, theme.Name, string(definition), theme.Revision); err != nil {
			return err
		}
	}
	if importedJSON {
		if _, err := tx.Exec(`INSERT OR IGNORE INTO migration_markers (name) VALUES ('workspace.json')`); err != nil {
			return err
		}
	}
	if receipt != nil {
		if _, err := tx.Exec(`INSERT INTO mutation_receipts
            (client_id, operation_id, endpoint, request_hash, status, response_body, revision)
            VALUES (?, ?, ?, ?, ?, ?, ?)`, receipt.ClientID, receipt.OperationID, receipt.Endpoint,
			receipt.RequestHash[:], receipt.Status, receipt.ResponseBody, receipt.Revision); err != nil {
			return err
		}
	}
	if err := insertActivity(tx, activity, s.historyLimit); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) mutationReceipt(clientID, operationID string) (mutationReceipt, bool, error) {
	var receipt mutationReceipt
	var requestHash []byte
	err := s.db.QueryRow(`SELECT endpoint, request_hash, status, response_body, revision
        FROM mutation_receipts WHERE client_id = ? AND operation_id = ?`, clientID, operationID).Scan(
		&receipt.Endpoint, &requestHash, &receipt.Status, &receipt.ResponseBody, &receipt.Revision)
	if errors.Is(err, sql.ErrNoRows) {
		return mutationReceipt{}, false, nil
	}
	if err != nil {
		return mutationReceipt{}, false, err
	}
	if len(requestHash) != len(receipt.RequestHash) {
		return mutationReceipt{}, false, fmt.Errorf("stored mutation receipt has invalid request hash")
	}
	copy(receipt.RequestHash[:], requestHash)
	receipt.ClientID = clientID
	receipt.OperationID = operationID
	return receipt, true, nil
}
