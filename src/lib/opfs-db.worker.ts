/// <reference lib="webworker" />

import sqlite3InitModule, { type Database, type SqlValue } from "@sqlite.org/sqlite-wasm";
import type { DesktopEntry, EditorSettings, Wallpaper } from "../types";
import type { DesktopSyncState, PersistedManifestV12 } from "./manifest-codec";
import type {
  StorageDbMethod,
  StorageDbRequest,
  StorageDbRequests,
  StorageDbResponses,
  StoredPreferences,
} from "./opfs-db-protocol";
import { applyOutboxOperation, type OutboxOperation, type OutboxRecord } from "./outbox";
import { parseManifestV12 } from "./manifest-codec";

const DATABASE_NAME = "/hiraya.sqlite3";
const DATABASE_SCHEMA_VERSION = 1;
const DEFAULT_PREFERENCES: StoredPreferences = { autoUpdate: true };

type Row = Record<string, SqlValue>;
type WorkerPort = Pick<MessagePort, "postMessage"> & {
  start?: () => void;
  onmessage: ((event: MessageEvent<StorageDbRequest>) => void) | null;
};

function rows(db: Database, sql: string): Row[] {
  return db.exec({ sql, rowMode: "object", returnValue: "resultRows" }) as Row[];
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

function createSchema(db: Database) {
  const version = numberValue(scalar(db, "PRAGMA user_version"));
  if (version < 0 || version > DATABASE_SCHEMA_VERSION) {
    throw new Error(`The desktop database uses unsupported schema version ${version}.`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      workspace_id TEXT,
      revision INTEGER NOT NULL CHECK (revision >= 0),
      layout_revision INTEGER NOT NULL CHECK (layout_revision >= 0),
      settings_revision INTEGER NOT NULL CHECK (settings_revision >= 0)
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
      language TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS preferences (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      auto_update INTEGER NOT NULL CHECK (auto_update IN (0, 1))
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
    );
  `);
  if (version < DATABASE_SCHEMA_VERSION) db.exec(`PRAGMA user_version=${DATABASE_SCHEMA_VERSION}`);
}

function readOutbox(db: Database): OutboxRecord[] {
  return rows(db, "SELECT * FROM outbox ORDER BY sequence").map((row) => ({
    operationId: stringValue(row.operation_id),
    sequence: numberValue(row.sequence),
    clientId: stringValue(row.client_id),
    workspaceId: nullableString(row.workspace_id),
    operation: JSON.parse(stringValue(row.operation_json)) as OutboxOperation,
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

function replaceManifestRows(db: Database, manifest: PersistedManifestV12) {
    db.exec({
      sql: `INSERT INTO workspace VALUES (1, 1, ?, ?, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET workspace_id=excluded.workspace_id, revision=excluded.revision,
        layout_revision=excluded.layout_revision, settings_revision=excluded.settings_revision`,
      bind: [manifest.sync.workspaceId, manifest.sync.revision, manifest.sync.layoutRevision, manifest.sync.settingsRevision],
    });
    db.exec({
      sql: `INSERT INTO layout VALUES (1, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET snap_to_grid=excluded.snap_to_grid, wallpaper=excluded.wallpaper`,
      bind: [manifest.snapToGrid, manifest.wallpaper],
    });
    db.exec({
      sql: `INSERT INTO editor_settings VALUES (1, ?, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET auto_save=excluded.auto_save, font_size=excluded.font_size, language=excluded.language`,
      bind: [manifest.editorSettings.autoSave, manifest.editorSettings.fontSize, manifest.editorSettings.language],
    });
    db.exec("DELETE FROM entries");
    const statement = db.prepare(`INSERT INTO entries
      (id, ordinal, kind, name, parent_id, modified_at, position_x, position_y, mime_type, size, entry_revision, content_revision)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    try {
      manifest.entries.forEach((entry, ordinal) => {
        statement.bind([
          entry.id,
          ordinal,
          entry.kind,
          entry.name,
          entry.parentId,
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
}

function replaceManifest(db: Database, manifest: PersistedManifestV12) {
  db.transaction("IMMEDIATE", () => {
    replaceManifestRows(db, manifest);
  });
}

function writePreferences(db: Database, preferences: StoredPreferences) {
  db.exec({
    sql: `INSERT INTO preferences VALUES (1, ?)
      ON CONFLICT(singleton) DO UPDATE SET auto_update=excluded.auto_update`,
    bind: [preferences.autoUpdate],
  });
}

function readManifest(db: Database): PersistedManifestV12 {
  const workspace = rows(db, "SELECT * FROM workspace WHERE singleton=1")[0];
  const layout = rows(db, "SELECT * FROM layout WHERE singleton=1")[0];
  const settings = rows(db, "SELECT * FROM editor_settings WHERE singleton=1")[0];
  if (!workspace || !layout || !settings) throw new Error("The desktop database is not initialized.");

  const entryRevisions: Record<string, number> = {};
  const contentRevisions: Record<string, number> = {};
  const entries: DesktopEntry[] = rows(db, "SELECT * FROM entries ORDER BY ordinal").map((row) => {
    const id = stringValue(row.id);
    if (row.entry_revision !== null) entryRevisions[id] = numberValue(row.entry_revision);
    const common = {
      id,
      name: stringValue(row.name),
      parentId: nullableString(row.parent_id),
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
  };
  const editorSettings: EditorSettings = {
    autoSave: numberValue(settings.auto_save) === 1,
    fontSize: numberValue(settings.font_size),
    language: stringValue(settings.language) as EditorSettings["language"],
  };
  return {
    version: 12,
    entries,
    snapToGrid: numberValue(layout.snap_to_grid) === 1,
    wallpaper: stringValue(layout.wallpaper) as Wallpaper,
    editorSettings,
    sync,
  };
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
  return db;
})();

async function dispatch<M extends StorageDbMethod>(method: M, params: StorageDbRequests[M]): Promise<StorageDbResponses[M]> {
  const db = await database;
  switch (method) {
    case "ping":
      return undefined as StorageDbResponses[M];
    case "status":
      return { existedBeforeOpen, needsBootstrap: scalar(db, "SELECT COUNT(*) FROM workspace") === 0 } as StorageDbResponses[M];
    case "bootstrap": {
      if (scalar(db, "SELECT COUNT(*) FROM workspace") === 0) {
        const input = params as StorageDbRequests["bootstrap"];
        db.transaction("IMMEDIATE", () => {
          replaceManifestRows(db, input.manifest);
          writePreferences(db, input.preferences);
        });
      }
      return { manifest: readManifest(db), preferences: readPreferences(db) } as StorageDbResponses[M];
    }
    case "readManifest":
      return readManifest(db) as StorageDbResponses[M];
    case "replaceManifest":
      replaceManifest(db, (params as StorageDbRequests["replaceManifest"]).manifest);
      return undefined as StorageDbResponses[M];
    case "readPreferences":
      return readPreferences(db) as StorageDbResponses[M];
    case "writePreferences":
      writePreferences(db, (params as StorageDbRequests["writePreferences"]).preferences);
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
        const manifest = parseManifestV12(applyOutboxOperation(current, input.operation));
        const clientId = stringValue(identity.client_id);
        db.exec({
          sql: "INSERT INTO outbox (sequence, operation_id, client_id, workspace_id, operation_json, status, error) VALUES (?, ?, ?, ?, ?, 'pending', NULL)",
          bind: [sequence, input.operationId, clientId, input.workspaceId, JSON.stringify(input.operation)],
        });
        replaceManifestRows(db, manifest);
        const record = readOutbox(db).find((item) => item.operationId === input.operationId)!;
        return { manifest, record };
      }) as StorageDbResponses[M];
    }
    case "readOutbox":
      return readOutbox(db) as StorageDbResponses[M];
    case "bindOutboxWorkspace": {
      const { workspaceId } = params as StorageDbRequests["bindOutboxWorkspace"];
      db.transaction("IMMEDIATE", () => {
        const error = "Pending changes belong to a different server workspace.";
        db.exec({
          sql: "UPDATE outbox SET status='blocked', error=? WHERE workspace_id IS NOT NULL AND workspace_id<>?",
          bind: [error, workspaceId],
        });
        db.exec({ sql: "UPDATE outbox SET workspace_id=? WHERE workspace_id IS NULL", bind: [workspaceId] });
      });
      return undefined as StorageDbResponses[M];
    }
    case "applyRemoteWithOutbox": {
      const input = params as StorageDbRequests["applyRemoteWithOutbox"];
      const remote = parseManifestV12(input.manifest);
      return db.transaction("IMMEDIATE", () => {
        let manifest = remote;
        const blocked: OutboxRecord[] = [];
        for (const record of readOutbox(db)) {
          if (record.operationId === input.acknowledgedOperationId) continue;
          if (record.workspaceId !== null && record.workspaceId !== remote.sync.workspaceId) {
            const error = "Pending changes belong to a different server workspace.";
            db.exec({ sql: "UPDATE outbox SET status='blocked', error=? WHERE operation_id=?", bind: [error, record.operationId] });
            blocked.push({ ...record, status: "blocked", error });
            continue;
          }
          try {
            manifest = parseManifestV12(applyOutboxOperation(manifest, record.operation));
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
  }
}

function readPreferences(db: Database): StoredPreferences {
  const value = scalar(db, "SELECT auto_update FROM preferences WHERE singleton=1");
  return value === undefined ? DEFAULT_PREFERENCES : { autoUpdate: numberValue(value) === 1 };
}

function attach(port: WorkerPort, ready: Promise<void> = Promise.resolve()) {
  port.onmessage = (event) => {
    const request = event.data;
    void ready.then(() => dispatch(request.method, request.params)).then(
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
    void owner.then(() => dispatch(request.method, request.params)).then(
      (result) => workerScope.postMessage({ id: request.id, result }),
      (error: unknown) => workerScope.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) }),
    );
  };
}
