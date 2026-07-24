/// <reference lib="webworker" />

import sqlite3InitModule, { type Database, type SqlValue } from "@sqlite.org/sqlite-wasm";
import type { DesktopEntry, DesktopIdentity, EditorSettings, Wallpaper } from "../types";
import { parseDesktopState, type DesktopSyncState, type PersistedDesktopState } from "./desktop-state";
import { applyOutboxOperation, desktopPendingOperationProtection, normalizeOutboxOperation, transferEntriesBetweenDesktopStates, type OutboxOperation, type OutboxRecord } from "./outbox";
import { parseCustomTheme, parseThemeState, type CustomTheme } from "./themes";
import { EMPTY_WINDOW_SESSION, parseWindowSession } from "./window-session";
import { activityRecord, parseActivityPage, parseActivityQuery, type ActivityPage, type NewActivityRecord } from "./activity";
import type { StorageDbMethod, StorageDbRequest, StorageDbRequests, StorageDbResponses, StoredPreferences } from "./opfs-db-protocol";

const DATABASE_SCHEMA_VERSION = 2;
const FRONTEND_ONLY = import.meta.env.HIRAYA_FRONTEND_ONLY === "true";
const HISTORY_LIMIT = Number(import.meta.env.HIRAYA_HISTORY_LIMIT);
const DEFAULT_PREFERENCES: StoredPreferences = { autoUpdate: true, externalEmbeddedPreviews: true };

type Row = Record<string, SqlValue>;
type WorkerPort = Pick<MessagePort, "postMessage"> & { start?: () => void; onmessage: ((event: MessageEvent<StorageDbRequest>) => void) | null };

let selectedStorageNamespace = "";
let resolveStorageNamespace!: (value: string) => void;
const storageNamespace = new Promise<string>((resolve) => { resolveStorageNamespace = resolve; });

function configureStorageNamespace(value: unknown) {
  if (typeof value !== "string" || !/^[a-f\d]{64}$/.test(value)) throw new Error("The SQLite worker has no valid storage namespace.");
  if (selectedStorageNamespace && selectedStorageNamespace !== value) throw new Error("The SQLite worker storage namespace cannot change.");
  if (!selectedStorageNamespace) {
    selectedStorageNamespace = value;
    resolveStorageNamespace(value);
  }
}

function rows(db: Database, sql: string, bind?: SqlValue[]): Row[] {
  return db.exec({ sql, bind, rowMode: "object", returnValue: "resultRows" }) as Row[];
}

function scalar(db: Database, sql: string, bind?: SqlValue[]): SqlValue | undefined {
  return db.exec({ sql, bind, rowMode: 0, returnValue: "resultRows" })[0];
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
  return value === null ? null : stringValue(value);
}

function createSchema(db: Database) {
  const version = numberValue(scalar(db, "PRAGMA user_version"));
  if (version === 1) {
    db.exec("BEGIN IMMEDIATE; ALTER TABLE desktops ADD COLUMN access_json TEXT; PRAGMA user_version=2; COMMIT;");
    return;
  }
  if (version !== 0 && version !== DATABASE_SCHEMA_VERSION) throw new Error(`The desktop database uses unsupported schema version ${version}.`);
  if (version === DATABASE_SCHEMA_VERSION) return;
  db.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE desktops (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      ordinal INTEGER NOT NULL UNIQUE CHECK (ordinal >= 0),
      catalog_id TEXT,
      catalog_revision INTEGER NOT NULL CHECK (catalog_revision >= 0),
      layout_revision INTEGER NOT NULL CHECK (layout_revision >= 0),
      settings_revision INTEGER NOT NULL CHECK (settings_revision >= 0),
      theme_selection_revision INTEGER NOT NULL CHECK (theme_selection_revision >= 0)
      ,access_json TEXT
    );
    CREATE TABLE desktop_layouts (
      desktop_id TEXT PRIMARY KEY REFERENCES desktops(id) ON DELETE CASCADE,
      snap_to_grid INTEGER NOT NULL CHECK (snap_to_grid IN (0, 1)),
      wallpaper TEXT NOT NULL
    );
    CREATE TABLE desktop_editor_settings (
      desktop_id TEXT PRIMARY KEY REFERENCES desktops(id) ON DELETE CASCADE,
      auto_save INTEGER NOT NULL CHECK (auto_save IN (0, 1)),
      auto_format INTEGER NOT NULL CHECK (auto_format IN (0, 1)),
      font_size INTEGER NOT NULL,
      language TEXT NOT NULL,
      line_wrap INTEGER NOT NULL CHECK (line_wrap IN (0, 1))
    );
    CREATE TABLE desktop_appearance (
      desktop_id TEXT PRIMARY KEY REFERENCES desktops(id) ON DELETE CASCADE,
      selected_theme_id TEXT NOT NULL
    );
    CREATE TABLE custom_themes (
      desktop_id TEXT NOT NULL REFERENCES desktops(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      theme_json TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 0),
      PRIMARY KEY (desktop_id, id),
      UNIQUE (desktop_id, ordinal)
    );
    CREATE TABLE entries (
      id TEXT PRIMARY KEY,
      desktop_id TEXT NOT NULL REFERENCES desktops(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      kind TEXT NOT NULL CHECK (kind IN ('file', 'folder')),
      name TEXT NOT NULL,
      parent_id TEXT REFERENCES entries(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
      created_at INTEGER CHECK (created_at >= 0),
      modified_at INTEGER NOT NULL CHECK (modified_at >= 0),
      position_x REAL NOT NULL,
      position_y REAL NOT NULL,
      mime_type TEXT,
      size INTEGER,
      entry_revision INTEGER,
      content_revision INTEGER,
      UNIQUE (desktop_id, ordinal),
      CHECK ((kind = 'file' AND mime_type IS NOT NULL AND size >= 0) OR (kind = 'folder' AND mime_type IS NULL AND size IS NULL))
    );
    CREATE TABLE preferences (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), auto_update INTEGER NOT NULL, external_embedded_previews INTEGER NOT NULL);
    CREATE TABLE desktop_window_sessions (desktop_id TEXT PRIMARY KEY REFERENCES desktops(id) ON DELETE CASCADE, session_json TEXT NOT NULL);
    CREATE TABLE client_state (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), client_id TEXT NOT NULL, next_sequence INTEGER NOT NULL CHECK (next_sequence > 0));
    CREATE TABLE outbox (
      sequence INTEGER PRIMARY KEY CHECK (sequence > 0),
      operation_id TEXT NOT NULL UNIQUE,
      client_id TEXT NOT NULL,
      catalog_id TEXT,
      desktop_id TEXT NOT NULL,
      operation_schema_version INTEGER NOT NULL CHECK (operation_schema_version = 1),
      operation_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'blocked')),
      error TEXT
    );
    CREATE TABLE activity (catalog_revision INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL, action TEXT NOT NULL, source TEXT NOT NULL, summary TEXT NOT NULL, details_json TEXT NOT NULL, search_text TEXT NOT NULL);
    CREATE INDEX activity_timestamp ON activity(timestamp DESC, catalog_revision DESC);
    PRAGMA user_version=1;
    COMMIT;
  `);
}

function readDesktopState(db: Database, desktopId: string): PersistedDesktopState {
  const desktop = rows(db, "SELECT * FROM desktops WHERE id=?", [desktopId])[0];
  const layout = rows(db, "SELECT * FROM desktop_layouts WHERE desktop_id=?", [desktopId])[0];
  const settings = rows(db, "SELECT * FROM desktop_editor_settings WHERE desktop_id=?", [desktopId])[0];
  const appearanceRow = rows(db, "SELECT * FROM desktop_appearance WHERE desktop_id=?", [desktopId])[0];
  if (!desktop || !layout || !settings || !appearanceRow) throw new Error("That desktop no longer exists.");
  const entryRevisions: Record<string, number> = {};
  const contentRevisions: Record<string, number> = {};
  const themeRevisions: Record<string, number> = {};
  const customThemes: CustomTheme[] = rows(db, "SELECT * FROM custom_themes WHERE desktop_id=? ORDER BY ordinal", [desktopId]).map((row) => {
    const theme = parseCustomTheme(JSON.parse(stringValue(row.theme_json)));
    themeRevisions[theme.id] = numberValue(row.revision);
    return theme;
  });
  const entries: DesktopEntry[] = rows(db, "SELECT * FROM entries WHERE desktop_id=? ORDER BY ordinal", [desktopId]).map((row) => {
    const id = stringValue(row.id);
    if (row.entry_revision !== null) entryRevisions[id] = numberValue(row.entry_revision);
    const common = { id, name: stringValue(row.name), parentId: nullableString(row.parent_id), createdAt: row.created_at === null ? null : numberValue(row.created_at), modifiedAt: numberValue(row.modified_at), position: { x: numberValue(row.position_x), y: numberValue(row.position_y) } };
    if (row.kind === "folder") return { ...common, kind: "folder" };
    if (row.kind !== "file") throw new Error("The desktop database contains an invalid entry kind.");
    if (row.content_revision !== null) contentRevisions[id] = numberValue(row.content_revision);
    return { ...common, kind: "file", mimeType: stringValue(row.mime_type), size: numberValue(row.size) };
  });
  const sync: DesktopSyncState = {
    catalogId: nullableString(desktop.catalog_id), catalogRevision: numberValue(desktop.catalog_revision), entryRevisions, contentRevisions,
    layoutRevision: numberValue(desktop.layout_revision), settingsRevision: numberValue(desktop.settings_revision),
    themeSelectionRevision: numberValue(desktop.theme_selection_revision), themeRevisions,
  };
  const editorSettings: EditorSettings = { autoSave: numberValue(settings.auto_save) === 1, autoFormat: numberValue(settings.auto_format) === 1, fontSize: numberValue(settings.font_size), language: stringValue(settings.language) as EditorSettings["language"], lineWrap: numberValue(settings.line_wrap) === 1 };
  const wallpaperText = stringValue(layout.wallpaper);
  let wallpaper: Wallpaper | string;
  try { wallpaper = JSON.parse(wallpaperText) as Wallpaper; } catch { wallpaper = wallpaperText; }
  return parseDesktopState({ entries, snapToGrid: numberValue(layout.snap_to_grid) === 1, wallpaper, editorSettings, appearance: parseThemeState({ selectedThemeId: stringValue(appearanceRow.selected_theme_id), customThemes }), sync });
}

function replaceDesktopStateRows(db: Database, desktopId: string, value: PersistedDesktopState) {
  const state = parseDesktopState(value);
  db.exec({ sql: "UPDATE desktops SET catalog_id=?, catalog_revision=?, layout_revision=?, settings_revision=?, theme_selection_revision=? WHERE id=?", bind: [state.sync.catalogId, state.sync.catalogRevision, state.sync.layoutRevision, state.sync.settingsRevision, state.sync.themeSelectionRevision, desktopId] });
  if (db.changes() !== 1) throw new Error("That desktop no longer exists.");
  db.exec({ sql: "INSERT INTO desktop_layouts VALUES (?, ?, ?) ON CONFLICT(desktop_id) DO UPDATE SET snap_to_grid=excluded.snap_to_grid, wallpaper=excluded.wallpaper", bind: [desktopId, state.snapToGrid, JSON.stringify(state.wallpaper)] });
  db.exec({ sql: "INSERT INTO desktop_editor_settings VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(desktop_id) DO UPDATE SET auto_save=excluded.auto_save, auto_format=excluded.auto_format, font_size=excluded.font_size, language=excluded.language, line_wrap=excluded.line_wrap", bind: [desktopId, state.editorSettings.autoSave, state.editorSettings.autoFormat, state.editorSettings.fontSize, state.editorSettings.language, state.editorSettings.lineWrap] });
  db.exec({ sql: "INSERT INTO desktop_appearance VALUES (?, ?) ON CONFLICT(desktop_id) DO UPDATE SET selected_theme_id=excluded.selected_theme_id", bind: [desktopId, state.appearance.selectedThemeId] });
  db.exec({ sql: "DELETE FROM custom_themes WHERE desktop_id=?", bind: [desktopId] });
  const themeStatement = db.prepare("INSERT INTO custom_themes VALUES (?, ?, ?, ?, ?)");
  try { state.appearance.customThemes.forEach((theme, ordinal) => themeStatement.bind([desktopId, theme.id, ordinal, JSON.stringify(theme), state.sync.themeRevisions[theme.id] ?? 0]).stepReset().clearBindings()); } finally { themeStatement.finalize(); }
  db.exec({ sql: "DELETE FROM entries WHERE desktop_id=?", bind: [desktopId] });
  const statement = db.prepare("INSERT INTO entries (id, desktop_id, ordinal, kind, name, parent_id, created_at, modified_at, position_x, position_y, mime_type, size, entry_revision, content_revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  try {
    state.entries.forEach((entry, ordinal) => statement.bind([entry.id, desktopId, ordinal, entry.kind, entry.name, entry.parentId, entry.createdAt, entry.modifiedAt, entry.position.x, entry.position.y, entry.kind === "file" ? entry.mimeType : null, entry.kind === "file" ? entry.size : null, state.sync.entryRevisions[entry.id] ?? null, entry.kind === "file" ? state.sync.contentRevisions[entry.id] ?? null : null]).stepReset().clearBindings());
  } finally { statement.finalize(); }
}

function createDesktopRows(db: Database, desktop: DesktopIdentity, state: PersistedDesktopState) {
  db.exec({ sql: "INSERT INTO desktops(id,name,ordinal,catalog_id,catalog_revision,layout_revision,settings_revision,theme_selection_revision,access_json) VALUES (?, ?, (SELECT COUNT(*) FROM desktops), NULL, 0, 0, 0, 0, ?)", bind: [desktop.id, desktop.name, JSON.stringify(desktop)] });
  replaceDesktopStateRows(db, desktop.id, state);
}

function readOutbox(db: Database, desktopId?: string): OutboxRecord[] {
  return rows(db, desktopId ? "SELECT * FROM outbox WHERE desktop_id=? ORDER BY sequence" : "SELECT * FROM outbox ORDER BY sequence", desktopId ? [desktopId] : undefined).map((row) => ({
    operationId: stringValue(row.operation_id), sequence: numberValue(row.sequence), clientId: stringValue(row.client_id), catalogId: nullableString(row.catalog_id), desktopId: stringValue(row.desktop_id),
    operation: normalizeOutboxOperation(JSON.parse(stringValue(row.operation_json)) as OutboxOperation), status: stringValue(row.status) as OutboxRecord["status"], error: nullableString(row.error),
  }));
}

function reserveOperation(db: Database) {
  let state = rows(db, "SELECT * FROM client_state WHERE singleton=1")[0];
  if (!state) { db.exec({ sql: "INSERT INTO client_state VALUES (1, ?, 1)", bind: [crypto.randomUUID()] }); state = rows(db, "SELECT * FROM client_state WHERE singleton=1")[0]; }
  const sequence = numberValue(state.next_sequence);
  db.exec({ sql: "UPDATE client_state SET next_sequence=? WHERE singleton=1", bind: [sequence + 1] });
  return { clientId: stringValue(state.client_id), sequence, operationId: sequence.toString().padStart(16, "0") };
}

function appendActivity(db: Database, value: NewActivityRecord) {
  const record = activityRecord(value.summary, value.details, value.timestamp, value.action);
  db.exec({ sql: "INSERT INTO activity (timestamp, action, source, summary, details_json, search_text) VALUES (?, ?, ?, ?, ?, ?)", bind: [record.timestamp, record.action, record.source, record.summary, JSON.stringify(record.details), [record.action, record.source, record.summary, ...record.details].join("\n").toLocaleLowerCase()] });
  db.exec({ sql: "DELETE FROM activity WHERE catalog_revision NOT IN (SELECT catalog_revision FROM activity ORDER BY catalog_revision DESC LIMIT ?)", bind: [HISTORY_LIMIT] });
}

function listActivity(db: Database, value: StorageDbRequests["listActivity"]): ActivityPage {
  const query = parseActivityQuery(value);
  const where: string[] = [];
  const bind: SqlValue[] = [];
  if (query.before !== undefined) { where.push("catalog_revision < ?"); bind.push(query.before); }
  if (query.q) { where.push("search_text LIKE ? ESCAPE '\\'"); bind.push(`%${query.q.toLocaleLowerCase().replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`); }
  bind.push(query.limit + 1);
  const found = rows(db, `SELECT * FROM activity ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY catalog_revision DESC LIMIT ?`, bind);
  const activities = found.slice(0, query.limit).map((row) => ({ ...activityRecord(stringValue(row.summary), JSON.parse(stringValue(row.details_json)) as string[], numberValue(row.timestamp), stringValue(row.action)), source: stringValue(row.source), catalogRevision: numberValue(row.catalog_revision) }));
  return parseActivityPage({ activities, nextBefore: found.length > query.limit ? activities.at(-1)!.catalogRevision : null });
}

function readPreferences(db: Database): StoredPreferences {
  const row = rows(db, "SELECT * FROM preferences WHERE singleton=1")[0];
  return row ? { autoUpdate: numberValue(row.auto_update) === 1, externalEmbeddedPreviews: numberValue(row.external_embedded_previews) === 1 } : DEFAULT_PREFERENCES;
}

function writePreferences(db: Database, value: StoredPreferences) {
  db.exec({ sql: "INSERT INTO preferences VALUES (1, ?, ?) ON CONFLICT(singleton) DO UPDATE SET auto_update=excluded.auto_update, external_embedded_previews=excluded.external_embedded_previews", bind: [value.autoUpdate, value.externalEmbeddedPreviews] });
}

let existedBeforeOpen = false;
const database = (async () => {
  const namespace = await storageNamespace;
  const databaseName = FRONTEND_ONLY ? "/hiraya-catalog-v1.sqlite3" : `/hiraya-catalog-v1-${namespace}.sqlite3`;
  const sqlite3 = await sqlite3InitModule();
  const pool = await sqlite3.installOpfsSAHPoolVfs({ directory: FRONTEND_ONLY ? ".hiraya-sqlite-v1" : `.hiraya-sqlite-v1-${namespace}`, initialCapacity: 6 });
  existedBeforeOpen = pool.getFileNames().includes(databaseName);
  const db = new pool.OpfsSAHPoolDb(databaseName);
  if (String(scalar(db, "PRAGMA locking_mode=EXCLUSIVE")).toLowerCase() !== "exclusive") throw new Error("SQLite could not enable exclusive locking.");
  if (String(scalar(db, "PRAGMA journal_mode=WAL")).toLowerCase() !== "wal") throw new Error("SQLite could not enable WAL journaling.");
  db.exec("PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON");
  createSchema(db);
  return db;
})();

async function dispatch<M extends StorageDbMethod>(method: M, params: StorageDbRequests[M], desktopId: string | null): Promise<StorageDbResponses[M]> {
  const db = await database;
  switch (method) {
    case "ping": return undefined as StorageDbResponses[M];
    case "status": return { existedBeforeOpen } as StorageDbResponses[M];
    case "listDesktops": return { desktops: rows(db, "SELECT id,name,access_json FROM desktops ORDER BY ordinal").map((row) => {
      const identity = row.access_json === null ? { id: stringValue(row.id), name: stringValue(row.name) } : JSON.parse(stringValue(row.access_json)) as DesktopIdentity;
      return { ...identity, id: stringValue(row.id), name: stringValue(row.name) };
    }) } as StorageDbResponses[M];
    case "createDesktop": { const input = params as StorageDbRequests["createDesktop"]; db.transaction("IMMEDIATE", () => createDesktopRows(db, input.desktop, input.state)); return input.desktop as StorageDbResponses[M]; }
    case "createOfflineDesktop": {
      const input = params as StorageDbRequests["createOfflineDesktop"];
      return db.transaction("IMMEDIATE", () => {
        createDesktopRows(db, input.desktop, input.state);
        const reservation = reserveOperation(db);
        const operation: OutboxOperation = { schemaVersion: 1, kind: "create-desktop", desktop: input.desktop };
        db.exec({ sql: "INSERT INTO outbox VALUES (?, ?, ?, NULL, ?, 1, ?, 'pending', NULL)", bind: [reservation.sequence, reservation.operationId, reservation.clientId, input.desktop.id, JSON.stringify(operation)] });
        return { desktop: input.desktop, record: readOutbox(db).find((record) => record.operationId === reservation.operationId)! };
      }) as StorageDbResponses[M];
    }
    case "renameDesktop": {
      const input = params as StorageDbRequests["renameDesktop"];
      const row = rows(db, "SELECT access_json FROM desktops WHERE id=?", [input.desktopId])[0];
      if (!row) throw new Error("That desktop no longer exists.");
      const identity = row.access_json === null ? { id: input.desktopId, name: input.name } : { ...(JSON.parse(stringValue(row.access_json)) as DesktopIdentity), name: input.name };
      db.exec({ sql: "UPDATE desktops SET name=?,access_json=? WHERE id=?", bind: [input.name, JSON.stringify(identity), input.desktopId] });
      return identity as StorageDbResponses[M];
    }
    case "updateDesktopIdentity": {
      const desktop = (params as StorageDbRequests["updateDesktopIdentity"]).desktop;
      db.exec({ sql: "UPDATE desktops SET access_json=? WHERE id=?", bind: [JSON.stringify(desktop), desktop.id] });
      if (db.changes() !== 1) throw new Error("That desktop no longer exists.");
      return desktop as StorageDbResponses[M];
    }
    case "deleteDesktop": {
      const id = (params as StorageDbRequests["deleteDesktop"]).desktopId;
      const protection = desktopPendingOperationProtection(readOutbox(db), id);
      if (protection) throw new Error(protection);
      db.exec({ sql: "DELETE FROM desktops WHERE id=?", bind: [id] });
      if (db.changes() !== 1) throw new Error("That desktop no longer exists.");
      return undefined as StorageDbResponses[M];
    }
    case "readDesktop": return readDesktopState(db, (params as StorageDbRequests["readDesktop"]).desktopId) as StorageDbResponses[M];
    case "replaceDesktopState": { if (!desktopId) throw new Error("No desktop is active for this request."); const input = params as StorageDbRequests["replaceDesktopState"]; db.transaction("IMMEDIATE", () => { replaceDesktopStateRows(db, desktopId, input.state); if (input.activity) appendActivity(db, input.activity); }); return undefined as StorageDbResponses[M]; }
    case "transferEntries": {
      const input = params as StorageDbRequests["transferEntries"];
      const source = readDesktopState(db, input.sourceDesktopId); const destination = readDesktopState(db, input.destinationDesktopId);
      const transferred = transferEntriesBetweenDesktopStates(source, destination, input.entryIds, input.parentId);
      const nextSource = parseDesktopState(transferred.source);
      const nextDestination = parseDesktopState(transferred.destination);
      db.transaction("IMMEDIATE", () => { replaceDesktopStateRows(db, input.sourceDesktopId, nextSource); replaceDesktopStateRows(db, input.destinationDesktopId, nextDestination); });
      return { source: nextSource, destination: nextDestination } as StorageDbResponses[M];
    }
    case "readPreferences": return readPreferences(db) as StorageDbResponses[M];
    case "writePreferences": writePreferences(db, (params as StorageDbRequests["writePreferences"]).preferences); return undefined as StorageDbResponses[M];
    case "readWindowSession": { const id = (params as StorageDbRequests["readWindowSession"]).desktopId; const value = scalar(db, "SELECT session_json FROM desktop_window_sessions WHERE desktop_id=?", [id]); return (value === undefined ? EMPTY_WINDOW_SESSION : parseWindowSession(JSON.parse(stringValue(value)))) as StorageDbResponses[M]; }
    case "writeWindowSession": { const input = params as StorageDbRequests["writeWindowSession"]; db.exec({ sql: "INSERT INTO desktop_window_sessions VALUES (?, ?) ON CONFLICT(desktop_id) DO UPDATE SET session_json=excluded.session_json", bind: [input.desktopId, JSON.stringify(parseWindowSession(input.session))] }); return undefined as StorageDbResponses[M]; }
    case "reserveOperation": return db.transaction("IMMEDIATE", () => reserveOperation(db)) as StorageDbResponses[M];
    case "enqueueMutation": {
      if (!desktopId) throw new Error("No desktop is active for this request.");
      const input = params as StorageDbRequests["enqueueMutation"];
      return db.transaction("IMMEDIATE", () => { const current = readDesktopState(db, desktopId); const state = parseDesktopState(applyOutboxOperation(current, input.operation)); const identity = rows(db, "SELECT * FROM client_state WHERE singleton=1")[0]; const sequence = Number.parseInt(input.operationId, 10); db.exec({ sql: "INSERT INTO outbox VALUES (?, ?, ?, ?, ?, 1, ?, 'pending', NULL)", bind: [sequence, input.operationId, stringValue(identity.client_id), input.catalogId, desktopId, JSON.stringify(input.operation)] }); replaceDesktopStateRows(db, desktopId, state); return { state, record: readOutbox(db).find((record) => record.operationId === input.operationId)! }; }) as StorageDbResponses[M];
    }
    case "enqueueTransfer": {
      const input = params as StorageDbRequests["enqueueTransfer"];
      const operation: OutboxOperation = { schemaVersion: 1, kind: "entry-transfer", entryIds: input.entryIds, destinationDesktopId: input.destinationDesktopId, parentId: input.parentId };
      return db.transaction("IMMEDIATE", () => {
        const source = readDesktopState(db, input.sourceDesktopId);
        const destination = readDesktopState(db, input.destinationDesktopId);
        const transferred = transferEntriesBetweenDesktopStates(source, destination, input.entryIds, input.parentId);
        const nextSource = parseDesktopState(transferred.source);
        const nextDestination = parseDesktopState(transferred.destination);
        replaceDesktopStateRows(db, input.sourceDesktopId, nextSource); replaceDesktopStateRows(db, input.destinationDesktopId, nextDestination);
        const identity = rows(db, "SELECT * FROM client_state WHERE singleton=1")[0]; const sequence = Number.parseInt(input.operationId, 10);
        db.exec({ sql: "INSERT INTO outbox VALUES (?, ?, ?, ?, ?, 1, ?, 'pending', NULL)", bind: [sequence, input.operationId, stringValue(identity.client_id), input.catalogId, input.sourceDesktopId, JSON.stringify(operation)] });
        return { state: nextSource, record: readOutbox(db).find((record) => record.operationId === input.operationId)! };
      }) as StorageDbResponses[M];
    }
    case "readOutbox": return readOutbox(db) as StorageDbResponses[M];
    case "bindOutboxCatalog": {
      const id = (params as StorageDbRequests["bindOutboxCatalog"]).catalogId;
      db.transaction("IMMEDIATE", () => {
        db.exec({ sql: "UPDATE outbox SET catalog_id=? WHERE catalog_id IS NULL", bind: [id] });
      });
      return undefined as StorageDbResponses[M];
    }
    case "applyRemoteWithOutbox": {
      if (!desktopId) throw new Error("No desktop is active for this request."); const input = params as StorageDbRequests["applyRemoteWithOutbox"];
      return db.transaction("IMMEDIATE", () => { let state = parseDesktopState(input.state); const blocked: OutboxRecord[] = []; for (const record of readOutbox(db, desktopId)) { if (record.operationId === input.acknowledgedOperationId) continue; if (record.catalogId !== state.sync.catalogId) { const error = "Pending changes belong to a different catalog."; db.exec({ sql: "UPDATE outbox SET status='blocked', error=? WHERE operation_id=?", bind: [error, record.operationId] }); blocked.push({ ...record, status: "blocked", error }); continue; } try { state = parseDesktopState(applyOutboxOperation(state, record.operation)); } catch (error) { const message = error instanceof Error ? error.message : String(error); db.exec({ sql: "UPDATE outbox SET status='blocked', error=? WHERE operation_id=?", bind: [message, record.operationId] }); blocked.push({ ...record, status: "blocked", error: message }); } } replaceDesktopStateRows(db, desktopId, state); return { state, blocked }; }) as StorageDbResponses[M];
    }
    case "acknowledgeMutation": db.exec({ sql: "DELETE FROM outbox WHERE operation_id=?", bind: [(params as StorageDbRequests["acknowledgeMutation"]).operationId] }); return undefined as StorageDbResponses[M];
    case "blockMutation": { const input = params as StorageDbRequests["blockMutation"]; db.exec({ sql: "UPDATE outbox SET status='blocked', error=? WHERE operation_id=?", bind: [input.error, input.operationId] }); return undefined as StorageDbResponses[M]; }
    case "listActivity": return listActivity(db, params as StorageDbRequests["listActivity"]) as StorageDbResponses[M];
    case "pruneDesktops": { const retained = new Set((params as StorageDbRequests["pruneDesktops"]).retainedDesktopIds); db.transaction("IMMEDIATE", () => { for (const row of rows(db, "SELECT id FROM desktops")) { const id = stringValue(row.id); if (!retained.has(id)) db.exec({ sql: "DELETE FROM desktops WHERE id=?", bind: [id] }); } }); return undefined as StorageDbResponses[M]; }
  }
}

function attach(port: WorkerPort, ready: Promise<void> = Promise.resolve()) {
  port.onmessage = (event) => { const request = event.data; void ready.then(() => dispatch(request.method, request.params, request.desktopId)).then((result) => port.postMessage({ id: request.id, result }), (error: unknown) => port.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) })); };
  port.start?.();
}

const workerScope = self as typeof self & { onconnect?: ((event: MessageEvent & { ports: MessagePort[] }) => void) | null };
if (!("onconnect" in workerScope)) {
  const owner = storageNamespace.then((namespace) => new Promise<void>((resolve, reject) => {
    if (!("locks" in navigator)) { reject(new Error("SharedWorker is unavailable and this browser cannot guarantee a single SQLite owner.")); return; }
    void navigator.locks.request(FRONTEND_ONLY ? "hiraya-sqlite-v1-owner" : `hiraya-sqlite-v1-owner-${namespace}`, { mode: "exclusive", ifAvailable: true }, async (lock) => { if (!lock) { reject(new Error("Another Hiraya tab owns local storage. Close it before using this browser.")); return; } resolve(); await new Promise(() => undefined); }).catch(reject);
  }));
  workerScope.onmessage = (event: MessageEvent<StorageDbRequest | { type: "configure-storage"; storage: string } | { type: "attach"; storage: string; port: MessagePort }>) => {
    if ("type" in event.data && event.data.type === "configure-storage") { configureStorageNamespace(event.data.storage); return; }
    if ("type" in event.data && event.data.type === "attach") { const port = event.data.port; configureStorageNamespace(event.data.storage); void owner.then(() => database).then(() => { port.postMessage({ type: "engine-ready" }); attach(port); }).catch((error: unknown) => port.postMessage({ type: "engine-error", error: error instanceof Error ? error.message : String(error) })); return; }
    const request = event.data as StorageDbRequest; void owner.then(() => dispatch(request.method, request.params, request.desktopId)).then((result) => workerScope.postMessage({ id: request.id, result }), (error: unknown) => workerScope.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) }));
  };
}
