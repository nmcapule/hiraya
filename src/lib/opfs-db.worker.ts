/// <reference lib="webworker" />

import sqlite3InitModule, { type Database, type SqlValue } from "@sqlite.org/sqlite-wasm";
import type { DesktopEntry, EditorSettings, Wallpaper } from "../types";
import type { DesktopSyncState, PersistedManifestV13 } from "./manifest-codec";
import { DEFAULT_THEME_ID, parseCustomTheme, parseThemeState, type CustomTheme } from "./themes";
import type {
  StorageDbMethod,
  StorageDbRequest,
  StorageDbRequests,
  StorageDbResponses,
  StoredPreferences,
} from "./opfs-db-protocol";
import { applyOutboxOperation, normalizeOutboxOperation, type OutboxOperation, type OutboxRecord } from "./outbox";
import { parseManifestV13 } from "./manifest-codec";
import { EMPTY_WINDOW_SESSION, parseWindowSession, type WindowSession } from "./window-session";
import { activityRecord, parseActivityPage, parseActivityQuery, type ActivityPage, type NewActivityRecord } from "./activity";
import { canAdoptFreshPlaceholder, desktopIdForManifest } from "./desktop-catalog";

const DATABASE_NAME = "/hiraya.sqlite3";
const DATABASE_SCHEMA_VERSION = 8;
const HISTORY_LIMIT = Number(import.meta.env.HIRAYA_HISTORY_LIMIT);
const DEFAULT_PREFERENCES: StoredPreferences = { autoUpdate: true, externalEmbeddedPreviews: true };

type Row = Record<string, SqlValue>;
type WorkerPort = Pick<MessagePort, "postMessage"> & {
  start?: () => void;
  onmessage: ((event: MessageEvent<StorageDbRequest>) => void) | null;
};

function rows(db: Database, sql: string, bind?: SqlValue[]): Row[] {
  return db.exec({ sql, bind, rowMode: "object", returnValue: "resultRows" }) as Row[];
}

function scalar(db: Database, sql: string): SqlValue | undefined {
  return db.exec({ sql, rowMode: 0, returnValue: "resultRows" })[0];
}

function numberValue(value: SqlValue | undefined) {
  if (typeof value !== "number") throw new Error("The desktop database contains invalid numeric metadata.");
  return value;
}

function stringValue(value: SqlValue | undefined) {
  if (typeof value !== "string") throw new Error("The desktop database contains invalid text metadata.");
  return value;
}

function nullableString(value: SqlValue | undefined) {
  if (value === null) return null;
  return stringValue(value);
}

function nullableNumber(value: SqlValue | undefined) {
  if (value === null) return null;
  return numberValue(value);
}

function createSchema(db: Database) {
  const version = numberValue(scalar(db, "PRAGMA user_version"));
  if (version < 0 || version > DATABASE_SCHEMA_VERSION) {
    throw new Error(`The desktop database uses unsupported schema version ${version}.`);
  }
  if (version === 1) db.exec(`
    BEGIN IMMEDIATE;
    ALTER TABLE workspace RENAME TO workspace_v1;
    CREATE TABLE workspace (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      schema_version INTEGER NOT NULL CHECK (schema_version = 2),
      workspace_id TEXT,
      revision INTEGER NOT NULL CHECK (revision >= 0),
      layout_revision INTEGER NOT NULL CHECK (layout_revision >= 0),
      settings_revision INTEGER NOT NULL CHECK (settings_revision >= 0),
      theme_selection_revision INTEGER NOT NULL CHECK (theme_selection_revision >= 0)
    );
    INSERT INTO workspace
      SELECT singleton, 2, workspace_id, revision, layout_revision, settings_revision, 0 FROM workspace_v1;
    DROP TABLE workspace_v1;
    CREATE TABLE appearance (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      selected_theme_id TEXT NOT NULL
    );
    CREATE TABLE custom_themes (
      id TEXT PRIMARY KEY,
      ordinal INTEGER NOT NULL UNIQUE CHECK (ordinal >= 0),
      theme_json TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 0)
    );
    INSERT INTO appearance VALUES (1, '${DEFAULT_THEME_ID}');
    COMMIT;
  `);
  if (version > 0 && version < 5) db.exec(`
    ALTER TABLE editor_settings ADD COLUMN line_wrap INTEGER NOT NULL DEFAULT 1 CHECK (line_wrap IN (0, 1));
    ALTER TABLE editor_settings ADD COLUMN auto_format INTEGER NOT NULL DEFAULT 0 CHECK (auto_format IN (0, 1));
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      schema_version INTEGER NOT NULL CHECK (schema_version = 2),
      workspace_id TEXT,
      revision INTEGER NOT NULL CHECK (revision >= 0),
      layout_revision INTEGER NOT NULL CHECK (layout_revision >= 0),
      settings_revision INTEGER NOT NULL CHECK (settings_revision >= 0),
      theme_selection_revision INTEGER NOT NULL CHECK (theme_selection_revision >= 0)
    );
    CREATE TABLE IF NOT EXISTS layout (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      snap_to_grid INTEGER NOT NULL CHECK (snap_to_grid IN (0, 1)),
      wallpaper TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS editor_settings (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      auto_save INTEGER NOT NULL CHECK (auto_save IN (0, 1)),
      font_size INTEGER NOT NULL,
      language TEXT NOT NULL,
      line_wrap INTEGER NOT NULL CHECK (line_wrap IN (0, 1)),
      auto_format INTEGER NOT NULL CHECK (auto_format IN (0, 1))
    );
    CREATE TABLE IF NOT EXISTS appearance (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      selected_theme_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS custom_themes (
      id TEXT PRIMARY KEY,
      ordinal INTEGER NOT NULL UNIQUE CHECK (ordinal >= 0),
      theme_json TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 0)
    );
    CREATE TABLE IF NOT EXISTS preferences (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      auto_update INTEGER NOT NULL CHECK (auto_update IN (0, 1))
    );
    CREATE TABLE IF NOT EXISTS external_preview_preferences (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1))
    );
    CREATE TABLE IF NOT EXISTS window_session (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      session_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS desktops (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      ordinal INTEGER NOT NULL UNIQUE CHECK (ordinal >= 0),
      manifest_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS active_desktop (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      desktop_id TEXT NOT NULL REFERENCES desktops(id) ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS desktop_window_sessions (
      desktop_id TEXT PRIMARY KEY REFERENCES desktops(id) ON DELETE CASCADE,
      session_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY,
      ordinal INTEGER NOT NULL UNIQUE CHECK (ordinal >= 0),
      kind TEXT NOT NULL CHECK (kind IN ('file', 'folder')),
      name TEXT NOT NULL,
      parent_id TEXT REFERENCES entries(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
      modified_at INTEGER NOT NULL,
      position_x REAL NOT NULL,
      position_y REAL NOT NULL,
      mime_type TEXT,
      size INTEGER,
      entry_revision INTEGER CHECK (entry_revision >= 0),
      content_revision INTEGER CHECK (content_revision >= 0),
      CHECK ((kind = 'file' AND mime_type IS NOT NULL AND size >= 0) OR (kind = 'folder' AND mime_type IS NULL AND size IS NULL)),
      CHECK (kind = 'file' OR content_revision IS NULL)
    );
    CREATE TABLE IF NOT EXISTS client_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      client_id TEXT NOT NULL,
      next_sequence INTEGER NOT NULL CHECK (next_sequence > 0)
    );
    CREATE TABLE IF NOT EXISTS outbox (
      sequence INTEGER PRIMARY KEY CHECK (sequence > 0),
      operation_id TEXT NOT NULL UNIQUE,
      client_id TEXT NOT NULL,
      workspace_id TEXT,
      operation_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'blocked')),
      error TEXT
      ,desktop_id TEXT
    );
    CREATE TABLE IF NOT EXISTS activity (
      revision INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL CHECK (timestamp >= 0),
      action TEXT NOT NULL,
      source TEXT NOT NULL,
      summary TEXT NOT NULL,
      details_json TEXT NOT NULL,
      search_text TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS activity_timestamp ON activity(timestamp DESC, revision DESC);
  `);
  if (version > 0 && version < 6) db.exec("ALTER TABLE outbox ADD COLUMN desktop_id TEXT");
  if (version < 7) db.exec("ALTER TABLE desktops ADD COLUMN adoptable_placeholder INTEGER NOT NULL DEFAULT 0 CHECK (adoptable_placeholder IN (0, 1))");
  if (version < 8) db.exec("ALTER TABLE entries ADD COLUMN created_at INTEGER CHECK (created_at >= 0)");
  if (version < DATABASE_SCHEMA_VERSION) db.exec(`PRAGMA user_version=${DATABASE_SCHEMA_VERSION}`);
}

function readOutbox(db: Database, desktopId?: string): OutboxRecord[] {
  return rows(db, desktopId ? "SELECT * FROM outbox WHERE desktop_id=? ORDER BY sequence" : "SELECT * FROM outbox ORDER BY sequence", desktopId ? [desktopId] : undefined).map((row) => ({
    operationId: stringValue(row.operation_id),
    sequence: numberValue(row.sequence),
    clientId: stringValue(row.client_id),
    workspaceId: nullableString(row.workspace_id),
    desktopId: row.desktop_id === null ? desktopId ?? "legacy" : stringValue(row.desktop_id),
    operation: normalizeOutboxOperation(JSON.parse(stringValue(row.operation_json)) as OutboxOperation),
    status: stringValue(row.status) as OutboxRecord["status"],
    error: nullableString(row.error),
  }));
}

function reserveOperation(db: Database) {
  let state = rows(db, "SELECT * FROM client_state WHERE singleton=1")[0];
  if (!state) {
    db.exec({ sql: "INSERT INTO client_state VALUES (1, ?, 1)", bind: [crypto.randomUUID()] });
    state = rows(db, "SELECT * FROM client_state WHERE singleton=1")[0];
  }
  const clientId = stringValue(state.client_id);
  const sequence = numberValue(state.next_sequence);
  db.exec({ sql: "UPDATE client_state SET next_sequence=? WHERE singleton=1", bind: [sequence + 1] });
  return { clientId, sequence, operationId: `${sequence.toString().padStart(16, "0")}` };
}

let projectedDesktopId: string | null = null;

function replaceManifestRows(db: Database, manifest: PersistedManifestV13) {
    db.exec({
      sql: `INSERT INTO workspace VALUES (1, 2, ?, ?, ?, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET workspace_id=excluded.workspace_id, revision=excluded.revision,
        layout_revision=excluded.layout_revision, settings_revision=excluded.settings_revision,
        theme_selection_revision=excluded.theme_selection_revision`,
      bind: [manifest.sync.workspaceId, manifest.sync.revision, manifest.sync.layoutRevision, manifest.sync.settingsRevision, manifest.sync.themeSelectionRevision],
    });
    db.exec({
      sql: `INSERT INTO layout VALUES (1, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET snap_to_grid=excluded.snap_to_grid, wallpaper=excluded.wallpaper`,
      bind: [manifest.snapToGrid, manifest.wallpaper],
    });
    db.exec({
      sql: `INSERT INTO appearance VALUES (1, ?)
        ON CONFLICT(singleton) DO UPDATE SET selected_theme_id=excluded.selected_theme_id`,
      bind: [manifest.appearance.selectedThemeId],
    });
    db.exec("DELETE FROM custom_themes");
    const themeStatement = db.prepare("INSERT INTO custom_themes (id, ordinal, theme_json, revision) VALUES (?, ?, ?, ?)");
    try {
      manifest.appearance.customThemes.forEach((theme, ordinal) => {
        themeStatement.bind([theme.id, ordinal, JSON.stringify(theme), manifest.sync.themeRevisions[theme.id] ?? 0]).stepReset().clearBindings();
      });
    } finally {
      themeStatement.finalize();
    }
    db.exec({
      sql: `INSERT INTO editor_settings VALUES (1, ?, ?, ?, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET auto_save=excluded.auto_save, font_size=excluded.font_size, language=excluded.language,
        line_wrap=excluded.line_wrap, auto_format=excluded.auto_format`,
      bind: [manifest.editorSettings.autoSave, manifest.editorSettings.fontSize, manifest.editorSettings.language, manifest.editorSettings.lineWrap, manifest.editorSettings.autoFormat],
    });
    db.exec("DELETE FROM entries");
    const statement = db.prepare(`INSERT INTO entries
      (id, ordinal, kind, name, parent_id, created_at, modified_at, position_x, position_y, mime_type, size, entry_revision, content_revision)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    try {
      manifest.entries.forEach((entry, ordinal) => {
        statement.bind([
          entry.id,
          ordinal,
          entry.kind,
          entry.name,
          entry.parentId,
          entry.createdAt,
          entry.modifiedAt,
          entry.position.x,
          entry.position.y,
          entry.kind === "file" ? entry.mimeType : null,
          entry.kind === "file" ? entry.size : null,
          manifest.sync.entryRevisions[entry.id] ?? null,
          entry.kind === "file" ? manifest.sync.contentRevisions[entry.id] ?? null : null,
        ]).stepReset().clearBindings();
      });
    } finally {
      statement.finalize();
    }
    if (projectedDesktopId) db.exec({ sql: "UPDATE desktops SET manifest_json=? WHERE id=?", bind: [JSON.stringify(manifest), projectedDesktopId] });
}

function appendActivity(db: Database, value: NewActivityRecord) {
  const record = activityRecord(value.summary, value.details, value.timestamp, value.action);
  const searchText = [record.action, record.source, record.summary, ...record.details].join("\n").toLocaleLowerCase();
  db.exec({
    sql: "INSERT INTO activity (timestamp, action, source, summary, details_json, search_text) VALUES (?, ?, ?, ?, ?, ?)",
    bind: [record.timestamp, record.action, record.source, record.summary, JSON.stringify(record.details), searchText],
  });
  pruneActivity(db);
}

function pruneActivity(db: Database) {
  db.exec({ sql: "DELETE FROM activity WHERE revision NOT IN (SELECT revision FROM activity ORDER BY revision DESC LIMIT ?)", bind: [HISTORY_LIMIT] });
}

function listActivity(db: Database, value: StorageDbRequests["listActivity"]): ActivityPage {
  const query = parseActivityQuery(value);
  const where: string[] = [];
  const bind: SqlValue[] = [];
  if (query.before !== undefined) {
    where.push("revision < ?");
    bind.push(query.before);
  }
  if (query.q) {
    where.push("search_text LIKE ? ESCAPE '\\'");
    bind.push(`%${query.q.toLocaleLowerCase().replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`);
  }
  bind.push(query.limit + 1);
  const found = rows(db, `SELECT revision, timestamp, action, source, summary, details_json FROM activity ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY revision DESC LIMIT ?`, bind);
  const hasMore = found.length > query.limit;
  const activities = found.slice(0, query.limit).map((row) => {
    const revision = numberValue(row.revision);
    try {
      const record = activityRecord(
        stringValue(row.summary),
        JSON.parse(stringValue(row.details_json)) as string[],
        numberValue(row.timestamp),
        stringValue(row.action),
      );
      return { ...record, source: stringValue(row.source), revision };
    } catch {
      return { revision, broken: true as const };
    }
  });
  return parseActivityPage({ activities, nextBefore: hasMore ? activities.at(-1)!.revision : null });
}

function replaceManifest(db: Database, manifest: PersistedManifestV13, activity?: NewActivityRecord) {
  db.transaction("IMMEDIATE", () => {
    replaceManifestRows(db, manifest);
    if (activity) appendActivity(db, activity);
  });
}

function writePreferences(db: Database, preferences: StoredPreferences) {
  db.exec({
    sql: `INSERT INTO preferences (singleton, auto_update) VALUES (1, ?)
      ON CONFLICT(singleton) DO UPDATE SET auto_update=excluded.auto_update`,
    bind: [preferences.autoUpdate],
  });
  db.exec({
    sql: `INSERT INTO external_preview_preferences (singleton, enabled) VALUES (1, ?)
      ON CONFLICT(singleton) DO UPDATE SET enabled=excluded.enabled`,
    bind: [preferences.externalEmbeddedPreviews],
  });
}

function readWindowSession(db: Database, desktopId: string): WindowSession {
  const value = rows(db, "SELECT session_json FROM desktop_window_sessions WHERE desktop_id=?", [desktopId])[0]?.session_json;
  return value === undefined ? EMPTY_WINDOW_SESSION : parseWindowSession(JSON.parse(stringValue(value)));
}

function writeWindowSession(db: Database, desktopId: string, session: WindowSession) {
  const parsed = parseWindowSession(session);
  db.exec({
    sql: `INSERT INTO desktop_window_sessions (desktop_id, session_json) VALUES (?, ?)
      ON CONFLICT(desktop_id) DO UPDATE SET session_json=excluded.session_json`,
    bind: [desktopId, JSON.stringify(parsed)],
  });
}

function readManifest(db: Database): PersistedManifestV13 {
  const workspace = rows(db, "SELECT * FROM workspace WHERE singleton=1")[0];
  const layout = rows(db, "SELECT * FROM layout WHERE singleton=1")[0];
  const settings = rows(db, "SELECT * FROM editor_settings WHERE singleton=1")[0];
  const appearanceRow = rows(db, "SELECT * FROM appearance WHERE singleton=1")[0];
  if (!workspace || !layout || !settings || !appearanceRow) throw new Error("The desktop database is not initialized.");

  const entryRevisions: Record<string, number> = {};
  const contentRevisions: Record<string, number> = {};
  const themeRevisions: Record<string, number> = {};
  const customThemes: CustomTheme[] = rows(db, "SELECT * FROM custom_themes ORDER BY ordinal").map((row) => {
    const theme = parseCustomTheme(JSON.parse(stringValue(row.theme_json)));
    if (theme.id !== stringValue(row.id)) throw new Error("The desktop database contains inconsistent theme metadata.");
    themeRevisions[theme.id] = numberValue(row.revision);
    return theme;
  });
  const appearance = parseThemeState({ selectedThemeId: stringValue(appearanceRow.selected_theme_id), customThemes });
  const entries: DesktopEntry[] = rows(db, "SELECT * FROM entries ORDER BY ordinal").map((row) => {
    const id = stringValue(row.id);
    if (row.entry_revision !== null) entryRevisions[id] = numberValue(row.entry_revision);
    const common = {
      id,
      name: stringValue(row.name),
      parentId: nullableString(row.parent_id),
      createdAt: nullableNumber(row.created_at),
      modifiedAt: numberValue(row.modified_at),
      position: { x: numberValue(row.position_x), y: numberValue(row.position_y) },
    };
    if (row.kind === "folder") return { ...common, kind: "folder" };
    if (row.kind !== "file") throw new Error("The desktop database contains an invalid entry kind.");
    if (row.content_revision !== null) contentRevisions[id] = numberValue(row.content_revision);
    return { ...common, kind: "file", mimeType: stringValue(row.mime_type), size: numberValue(row.size) };
  });
  const sync: DesktopSyncState = {
    workspaceId: nullableString(workspace.workspace_id),
    revision: numberValue(workspace.revision),
    entryRevisions,
    contentRevisions,
    layoutRevision: numberValue(workspace.layout_revision),
    settingsRevision: numberValue(workspace.settings_revision),
    themeSelectionRevision: numberValue(workspace.theme_selection_revision),
    themeRevisions,
  };
  const editorSettings: EditorSettings = {
    autoSave: numberValue(settings.auto_save) === 1,
    fontSize: numberValue(settings.font_size),
    language: stringValue(settings.language) as EditorSettings["language"],
    lineWrap: numberValue(settings.line_wrap) === 1,
    autoFormat: numberValue(settings.auto_format) === 1,
  };
  return {
    version: 13,
    entries,
    snapToGrid: numberValue(layout.snap_to_grid) === 1,
    wallpaper: stringValue(layout.wallpaper) as Wallpaper,
    editorSettings,
    appearance,
    sync,
  };
}

function activateDesktopProjection(db: Database, desktopId: string) {
  if (projectedDesktopId === desktopId) return true;
  const value = rows(db, "SELECT manifest_json FROM desktops WHERE id=?", [desktopId])[0]?.manifest_json;
  if (value === undefined) return false;
  projectedDesktopId = desktopId;
  replaceManifestRows(db, parseManifestV13(JSON.parse(stringValue(value))));
  return true;
}

let existedBeforeOpen = false;
const database = (async () => {
  const sqlite3 = await sqlite3InitModule();
  const pool = await sqlite3.installOpfsSAHPoolVfs({ directory: ".hiraya-sqlite", initialCapacity: 6 });
  existedBeforeOpen = pool.getFileNames().includes(DATABASE_NAME);
  const db = new pool.OpfsSAHPoolDb(DATABASE_NAME);

  // WAL without shared memory requires exclusive locking before any other database operation.
  const lockingMode = scalar(db, "PRAGMA locking_mode=EXCLUSIVE");
  if (String(lockingMode).toLowerCase() !== "exclusive") throw new Error("SQLite could not enable exclusive locking.");
  const journalMode = scalar(db, "PRAGMA journal_mode=WAL");
  if (String(journalMode).toLowerCase() !== "wal") throw new Error("SQLite could not enable WAL journaling.");
  db.exec("PRAGMA synchronous=FULL");
  db.exec("PRAGMA foreign_keys=ON");
  if (numberValue(scalar(db, "PRAGMA foreign_keys")) !== 1) throw new Error("SQLite could not enable foreign keys.");
  createSchema(db);
  if (scalar(db, "SELECT COUNT(*) FROM desktops") === 0 && scalar(db, "SELECT COUNT(*) FROM workspace") !== 0) {
    const manifest = readManifest(db);
    const desktopId = desktopIdForManifest(manifest, crypto.randomUUID());
    db.transaction("IMMEDIATE", () => {
      db.exec({ sql: "INSERT INTO desktops (id, name, ordinal, manifest_json) VALUES (?, 'Desktop', 0, ?)", bind: [desktopId, JSON.stringify(manifest)] });
      db.exec({ sql: "INSERT INTO active_desktop VALUES (1, ?)", bind: [desktopId] });
      db.exec({ sql: "UPDATE outbox SET desktop_id=? WHERE desktop_id IS NULL", bind: [desktopId] });
      const legacySession = scalar(db, "SELECT session_json FROM window_session WHERE singleton=1");
      if (legacySession !== undefined) db.exec({ sql: "INSERT INTO desktop_window_sessions VALUES (?, ?)", bind: [desktopId, legacySession] });
    });
  }
  const fallbackDesktopId = scalar(db, "SELECT desktop_id FROM active_desktop WHERE singleton=1");
  if (typeof fallbackDesktopId === "string") projectedDesktopId = fallbackDesktopId;
  pruneActivity(db);
  return db;
})();

const CONTEXT_OPTIONAL_METHODS = new Set<StorageDbMethod>([
  "ping", "status", "listDesktops", "createDesktop", "renameDesktop", "deleteDesktop", "adoptFreshDesktop", "readDesktop",
  "transferEntries", "bootstrap", "readPreferences", "writePreferences", "readWindowSession", "writeWindowSession", "reserveOperation",
  "readOutbox", "acknowledgeMutation", "blockMutation", "pruneDesktops", "listActivity",
]);

async function dispatch<M extends StorageDbMethod>(method: M, params: StorageDbRequests[M], desktopId: string | null): Promise<StorageDbResponses[M]> {
  const db = await database;
  if (desktopId && !activateDesktopProjection(db, desktopId) && !CONTEXT_OPTIONAL_METHODS.has(method)) throw new Error("That desktop no longer exists.");
  switch (method) {
    case "ping":
      return undefined as StorageDbResponses[M];
    case "status":
      return { existedBeforeOpen, needsBootstrap: scalar(db, "SELECT COUNT(*) FROM desktops") === 0 } as StorageDbResponses[M];
    case "listDesktops":
      return {
        desktops: rows(db, "SELECT id, name FROM desktops ORDER BY ordinal").map((row) => ({ id: stringValue(row.id), name: stringValue(row.name) })),
        activeDesktopId: nullableString(scalar(db, "SELECT desktop_id FROM active_desktop WHERE singleton=1")),
      } as StorageDbResponses[M];
    case "createDesktop": {
      const input = params as StorageDbRequests["createDesktop"];
      const manifest = parseManifestV13(input.manifest);
      db.transaction("IMMEDIATE", () => db.exec({ sql: "INSERT INTO desktops (id, name, ordinal, manifest_json) VALUES (?, ?, (SELECT COUNT(*) FROM desktops), ?)", bind: [input.desktop.id, input.desktop.name, JSON.stringify(manifest)] }));
      return input.desktop as StorageDbResponses[M];
    }
    case "renameDesktop": {
      const input = params as StorageDbRequests["renameDesktop"];
      db.exec({ sql: "UPDATE desktops SET name=? WHERE id=?", bind: [input.name, input.desktopId] });
      if (db.changes() !== 1) throw new Error("That desktop no longer exists.");
      return { id: input.desktopId, name: input.name } as StorageDbResponses[M];
    }
    case "deleteDesktop": {
      const { desktopId } = params as StorageDbRequests["deleteDesktop"];
      if (numberValue(scalar(db, "SELECT COUNT(*) FROM desktops")) <= 1) throw new Error("The last desktop cannot be deleted.");
      if (projectedDesktopId === desktopId) throw new Error("Switch desktops before deleting the active desktop.");
      db.transaction("IMMEDIATE", () => {
        db.exec({ sql: "DELETE FROM outbox WHERE desktop_id=?", bind: [desktopId] });
        db.exec({ sql: "DELETE FROM desktops WHERE id=?", bind: [desktopId] });
      });
      return undefined as StorageDbResponses[M];
    }
    case "switchDesktop": {
      const { desktopId } = params as StorageDbRequests["switchDesktop"];
      if (!activateDesktopProjection(db, desktopId)) throw new Error("That desktop no longer exists.");
      return readManifest(db) as StorageDbResponses[M];
    }
    case "adoptFreshDesktop": {
      const input = params as StorageDbRequests["adoptFreshDesktop"];
      const row = rows(db, "SELECT * FROM desktops WHERE id=?", [input.desktopId])[0];
      if (!row || rows(db, "SELECT id FROM desktops WHERE id=?", [input.target.id]).length) return { adopted: false } as StorageDbResponses[M];
      const manifest = parseManifestV13(JSON.parse(stringValue(row.manifest_json)));
      const adoptable = canAdoptFreshPlaceholder({
        adoptablePlaceholder: numberValue(row.adoptable_placeholder) === 1,
        desktopCount: numberValue(scalar(db, "SELECT COUNT(*) FROM desktops")),
        entryCount: manifest.entries.length,
        outboxCount: numberValue(rows(db, "SELECT COUNT(*) AS count FROM outbox WHERE desktop_id=?", [input.desktopId])[0].count),
        workspaceId: manifest.sync.workspaceId,
      });
      if (!adoptable) return { adopted: false } as StorageDbResponses[M];
      const ordinal = numberValue(row.ordinal);
      db.transaction("IMMEDIATE", () => {
        db.exec({ sql: "INSERT INTO desktops (id, name, ordinal, manifest_json, adoptable_placeholder) VALUES (?, ?, (SELECT COALESCE(MAX(ordinal), -1) + 1 FROM desktops), ?, 0)", bind: [input.target.id, input.target.name, stringValue(row.manifest_json)] });
        db.exec({ sql: "INSERT INTO desktop_window_sessions (desktop_id, session_json) SELECT ?, session_json FROM desktop_window_sessions WHERE desktop_id=?", bind: [input.target.id, input.desktopId] });
        db.exec({ sql: "UPDATE outbox SET desktop_id=? WHERE desktop_id=?", bind: [input.target.id, input.desktopId] });
        db.exec({ sql: "UPDATE active_desktop SET desktop_id=? WHERE desktop_id=?", bind: [input.target.id, input.desktopId] });
        db.exec({ sql: "DELETE FROM desktops WHERE id=?", bind: [input.desktopId] });
        db.exec({ sql: "UPDATE desktops SET ordinal=? WHERE id=?", bind: [ordinal, input.target.id] });
      });
      if (projectedDesktopId === input.desktopId) projectedDesktopId = input.target.id;
      return { adopted: true } as StorageDbResponses[M];
    }
    case "readDesktop": {
      const { desktopId } = params as StorageDbRequests["readDesktop"];
      const value = rows(db, "SELECT manifest_json FROM desktops WHERE id=?", [desktopId])[0]?.manifest_json;
      if (value === undefined) throw new Error("That desktop no longer exists.");
      return parseManifestV13(JSON.parse(stringValue(value))) as StorageDbResponses[M];
    }
    case "transferEntries": {
      const input = params as StorageDbRequests["transferEntries"];
      if (input.sourceDesktopId === input.destinationDesktopId) throw new Error("Choose a different desktop.");
      const sourceValue = rows(db, "SELECT manifest_json FROM desktops WHERE id=?", [input.sourceDesktopId])[0]?.manifest_json;
      const destinationValue = rows(db, "SELECT manifest_json FROM desktops WHERE id=?", [input.destinationDesktopId])[0]?.manifest_json;
      if (sourceValue === undefined || destinationValue === undefined) throw new Error("A desktop no longer exists.");
      const source = parseManifestV13(JSON.parse(stringValue(sourceValue)));
      const destination = parseManifestV13(JSON.parse(stringValue(destinationValue)));
      const roots = new Set(input.entryIds);
      if (!roots.size || roots.size !== input.entryIds.length || input.entryIds.some((id) => !source.entries.some((entry) => entry.id === id))) throw new Error("An entry no longer exists.");
      if (input.parentId !== null && !destination.entries.some((entry) => entry.id === input.parentId && entry.kind === "folder")) throw new Error("The destination folder no longer exists.");
      const included = new Set(roots);
      for (let changed = true; changed;) {
        changed = false;
        for (const entry of source.entries) if (entry.parentId && included.has(entry.parentId) && !included.has(entry.id)) { included.add(entry.id); changed = true; }
      }
      const moving = source.entries.filter((entry) => included.has(entry.id)).map((entry) => roots.has(entry.id) ? { ...entry, parentId: input.parentId, modifiedAt: Date.now() } : entry);
      const nextSource = parseManifestV13({ ...source, entries: source.entries.filter((entry) => !included.has(entry.id)) });
      const nextDestination = parseManifestV13({ ...destination, entries: [...destination.entries, ...moving] });
      db.transaction("IMMEDIATE", () => {
        db.exec({ sql: "UPDATE desktops SET manifest_json=? WHERE id=?", bind: [JSON.stringify(nextSource), input.sourceDesktopId] });
        db.exec({ sql: "UPDATE desktops SET manifest_json=? WHERE id=?", bind: [JSON.stringify(nextDestination), input.destinationDesktopId] });
        if (projectedDesktopId === input.sourceDesktopId) replaceManifestRows(db, nextSource);
        else if (projectedDesktopId === input.destinationDesktopId) replaceManifestRows(db, nextDestination);
      });
      return { source: nextSource, destination: nextDestination } as StorageDbResponses[M];
    }
    case "readWindowSession":
      return readWindowSession(db, (params as StorageDbRequests["readWindowSession"]).desktopId) as StorageDbResponses[M];
    case "writeWindowSession":
      writeWindowSession(db, (params as StorageDbRequests["writeWindowSession"]).desktopId, (params as StorageDbRequests["writeWindowSession"]).session);
      return undefined as StorageDbResponses[M];
    case "bootstrap": {
      if (scalar(db, "SELECT COUNT(*) FROM desktops") === 0) {
        const input = params as StorageDbRequests["bootstrap"];
        db.transaction("IMMEDIATE", () => {
          const desktopId = desktopIdForManifest(input.manifest, crypto.randomUUID());
          db.exec({ sql: "INSERT INTO desktops (id, name, ordinal, manifest_json, adoptable_placeholder) VALUES (?, 'Desktop', 0, ?, ?)", bind: [desktopId, JSON.stringify(input.manifest), input.adoptablePlaceholder] });
          db.exec({ sql: "INSERT INTO active_desktop VALUES (1, ?)", bind: [desktopId] });
          projectedDesktopId = desktopId;
          replaceManifestRows(db, input.manifest);
          writePreferences(db, input.preferences);
        });
      }
      return { manifest: readManifest(db), preferences: readPreferences(db) } as StorageDbResponses[M];
    }
    case "readManifest":
      return readManifest(db) as StorageDbResponses[M];
    case "replaceManifest":
      replaceManifest(db, (params as StorageDbRequests["replaceManifest"]).manifest, (params as StorageDbRequests["replaceManifest"]).activity);
      return undefined as StorageDbResponses[M];
    case "readPreferences":
      return readPreferences(db) as StorageDbResponses[M];
    case "writePreferences":
      db.transaction("IMMEDIATE", () => writePreferences(db, (params as StorageDbRequests["writePreferences"]).preferences));
      return undefined as StorageDbResponses[M];
    case "reserveOperation":
      return db.transaction("IMMEDIATE", () => reserveOperation(db)) as StorageDbResponses[M];
    case "enqueueMutation": {
      const input = params as StorageDbRequests["enqueueMutation"];
      return db.transaction("IMMEDIATE", () => {
        const identity = rows(db, "SELECT * FROM client_state WHERE singleton=1")[0];
        if (!identity) throw new Error("The operation identity was not reserved.");
        const sequence = Number.parseInt(input.operationId, 10);
        if (!Number.isSafeInteger(sequence) || sequence <= 0 || sequence >= numberValue(identity.next_sequence)) throw new Error("The operation identity is invalid.");
        const current = readManifest(db);
        const manifest = parseManifestV13(applyOutboxOperation(current, input.operation));
        const clientId = stringValue(identity.client_id);
        db.exec({
          sql: "INSERT INTO outbox (sequence, operation_id, client_id, workspace_id, operation_json, status, error, desktop_id) VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?)",
          bind: [sequence, input.operationId, clientId, input.workspaceId, JSON.stringify(input.operation), projectedDesktopId],
        });
        replaceManifestRows(db, manifest);
        const record = readOutbox(db).find((item) => item.operationId === input.operationId)!;
        return { manifest, record };
      }) as StorageDbResponses[M];
    }
    case "enqueueTransfer": {
      const input = params as StorageDbRequests["enqueueTransfer"];
      return db.transaction("IMMEDIATE", () => {
        const identity = rows(db, "SELECT * FROM client_state WHERE singleton=1")[0];
        if (!identity) throw new Error("The operation identity was not reserved.");
        const sequence = Number.parseInt(input.operationId, 10);
        if (!Number.isSafeInteger(sequence) || sequence <= 0 || sequence >= numberValue(identity.next_sequence)) throw new Error("The operation identity is invalid.");
        const sourceValue = rows(db, "SELECT manifest_json FROM desktops WHERE id=?", [input.sourceDesktopId])[0]?.manifest_json;
        const destinationValue = rows(db, "SELECT manifest_json FROM desktops WHERE id=?", [input.destinationDesktopId])[0]?.manifest_json;
        if (sourceValue === undefined || destinationValue === undefined) throw new Error("A desktop no longer exists.");
        const source = parseManifestV13(JSON.parse(stringValue(sourceValue)));
        const destination = parseManifestV13(JSON.parse(stringValue(destinationValue)));
        const roots = new Set(input.entryIds);
        if (!roots.size || roots.size !== input.entryIds.length) throw new Error("An entry no longer exists.");
        if (input.parentId !== null && !destination.entries.some((entry) => entry.id === input.parentId && entry.kind === "folder")) throw new Error("The destination folder no longer exists.");
        const included = new Set(roots);
        for (let changed = true; changed;) {
          changed = false;
          for (const entry of source.entries) if (entry.parentId && included.has(entry.parentId) && !included.has(entry.id)) { included.add(entry.id); changed = true; }
        }
        const moving = source.entries.filter((entry) => included.has(entry.id)).map((entry) => roots.has(entry.id) ? { ...entry, parentId: input.parentId, modifiedAt: Date.now() } : entry);
        if (moving.length < roots.size) throw new Error("An entry no longer exists.");
        const operation: OutboxOperation = { kind: "transfer", entryIds: input.entryIds, destinationDesktopId: input.destinationDesktopId, parentId: input.parentId };
        const manifest = parseManifestV13(applyOutboxOperation(source, operation));
        const nextDestination = parseManifestV13({ ...destination, entries: [...destination.entries, ...moving] });
        const clientId = stringValue(identity.client_id);
        db.exec({
          sql: "INSERT INTO outbox (sequence, operation_id, client_id, workspace_id, operation_json, status, error, desktop_id) VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?)",
          bind: [sequence, input.operationId, clientId, input.workspaceId, JSON.stringify(operation), input.sourceDesktopId],
        });
        db.exec({ sql: "UPDATE desktops SET manifest_json=? WHERE id=?", bind: [JSON.stringify(nextDestination), input.destinationDesktopId] });
        replaceManifestRows(db, manifest);
        return { manifest, record: readOutbox(db).find((item) => item.operationId === input.operationId)! };
      }) as StorageDbResponses[M];
    }
    case "readOutbox":
      return readOutbox(db) as StorageDbResponses[M];
    case "bindOutboxWorkspace": {
      const { workspaceId } = params as StorageDbRequests["bindOutboxWorkspace"];
      db.transaction("IMMEDIATE", () => {
        if (!projectedDesktopId) throw new Error("No desktop is active for this request.");
        const desktopId = projectedDesktopId;
        const error = "Pending changes belong to a different shared desktop.";
        db.exec({
          sql: "UPDATE outbox SET status='blocked', error=? WHERE desktop_id=? AND workspace_id IS NOT NULL AND workspace_id<>?",
          bind: [error, desktopId, workspaceId],
        });
        db.exec({ sql: "UPDATE outbox SET workspace_id=? WHERE desktop_id=? AND workspace_id IS NULL", bind: [workspaceId, desktopId] });
      });
      return undefined as StorageDbResponses[M];
    }
    case "applyRemoteWithOutbox": {
      const input = params as StorageDbRequests["applyRemoteWithOutbox"];
      const remote = parseManifestV13(input.manifest);
      return db.transaction("IMMEDIATE", () => {
        let manifest = remote;
        const blocked: OutboxRecord[] = [];
        for (const record of readOutbox(db, projectedDesktopId ?? undefined)) {
          if (record.operationId === input.acknowledgedOperationId) continue;
          if (record.workspaceId !== null && record.workspaceId !== remote.sync.workspaceId) {
            const error = "Pending changes belong to a different shared desktop.";
            db.exec({ sql: "UPDATE outbox SET status='blocked', error=? WHERE operation_id=?", bind: [error, record.operationId] });
            blocked.push({ ...record, status: "blocked", error });
            continue;
          }
          try {
            manifest = parseManifestV13(applyOutboxOperation(manifest, record.operation));
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            db.exec({ sql: "UPDATE outbox SET status='blocked', error=? WHERE operation_id=?", bind: [message, record.operationId] });
            blocked.push({ ...record, status: "blocked", error: message });
          }
        }
        replaceManifestRows(db, manifest);
        return { manifest, blocked };
      }) as StorageDbResponses[M];
    }
    case "acknowledgeMutation":
      db.exec({ sql: "DELETE FROM outbox WHERE operation_id=?", bind: [(params as StorageDbRequests["acknowledgeMutation"]).operationId] });
      return undefined as StorageDbResponses[M];
    case "blockMutation": {
      const input = params as StorageDbRequests["blockMutation"];
      db.exec({ sql: "UPDATE outbox SET status='blocked', error=? WHERE operation_id=?", bind: [input.error, input.operationId] });
      return undefined as StorageDbResponses[M];
    }
    case "listActivity":
      return listActivity(db, params as StorageDbRequests["listActivity"]) as StorageDbResponses[M];
    case "pruneDesktops": {
      const retained = new Set((params as StorageDbRequests["pruneDesktops"]).retainedDesktopIds);
      const active = projectedDesktopId;
      db.transaction("IMMEDIATE", () => {
        for (const row of rows(db, "SELECT id FROM desktops")) {
          const id = stringValue(row.id);
          if (id === active || retained.has(id)) continue;
          db.exec({ sql: "DELETE FROM outbox WHERE desktop_id=?", bind: [id] });
          db.exec({ sql: "DELETE FROM desktops WHERE id=?", bind: [id] });
        }
      });
      return undefined as StorageDbResponses[M];
    }
  }
}

function readPreferences(db: Database): StoredPreferences {
  const autoUpdate = scalar(db, "SELECT auto_update FROM preferences WHERE singleton=1");
  const externalEmbeddedPreviews = scalar(db, "SELECT enabled FROM external_preview_preferences WHERE singleton=1");
  return {
    autoUpdate: autoUpdate === undefined ? DEFAULT_PREFERENCES.autoUpdate : numberValue(autoUpdate) === 1,
    externalEmbeddedPreviews: externalEmbeddedPreviews === undefined ? DEFAULT_PREFERENCES.externalEmbeddedPreviews : numberValue(externalEmbeddedPreviews) === 1,
  };
}

function attach(port: WorkerPort, ready: Promise<void> = Promise.resolve()) {
  port.onmessage = (event) => {
    const request = event.data;
    void ready.then(() => dispatch(request.method, request.params, request.desktopId)).then(
      (result) => port.postMessage({ id: request.id, result }),
      (error: unknown) => port.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) }),
    );
  };
  port.start?.();
}

const workerScope = self as typeof self & {
  onconnect?: ((event: MessageEvent & { ports: MessagePort[] }) => void) | null;
};

if (!("onconnect" in workerScope)) {
  let resolveOwner!: () => void;
  let rejectOwner!: (error: unknown) => void;
  const owner = new Promise<void>((resolve, reject) => {
    resolveOwner = resolve;
    rejectOwner = reject;
  });
  if (!("locks" in navigator)) {
    rejectOwner(new Error("SharedWorker is unavailable and this browser cannot guarantee a single SQLite owner."));
  } else {
    void navigator.locks.request("hiraya-sqlite-owner", { mode: "exclusive", ifAvailable: true }, async (lock) => {
      if (!lock) {
        rejectOwner(new Error("Another Hiraya tab owns local storage. Close it before using this browser."));
        return;
      }
      resolveOwner();
      await new Promise(() => undefined);
    }).catch(rejectOwner);
  }
  workerScope.onmessage = (event: MessageEvent<StorageDbRequest | { type: "attach"; port: MessagePort }>) => {
    if ("type" in event.data && event.data.type === "attach") {
      const port = event.data.port;
      void owner.then(() => database).then(() => {
        port.postMessage({ type: "engine-ready" });
        attach(port);
      }).catch((error: unknown) => {
        port.postMessage({ type: "engine-error", error: error instanceof Error ? error.message : String(error) });
      });
      return;
    }
    const request = event.data as StorageDbRequest;
    void owner.then(() => dispatch(request.method, request.params, request.desktopId)).then(
      (result) => workerScope.postMessage({ id: request.id, result }),
      (error: unknown) => workerScope.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) }),
    );
  };
}
