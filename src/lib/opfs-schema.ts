export const DATABASE_SCHEMA_VERSION = 4;

export const APP_STORAGE_SCHEMA_SQL = `
  CREATE TABLE installed_apps (
    app_id TEXT PRIMARY KEY,
    package_entry_id TEXT NOT NULL,
    digest TEXT NOT NULL CHECK (length(digest) = 64),
    version TEXT NOT NULL,
    manifest_json TEXT NOT NULL,
    approved_at INTEGER NOT NULL CHECK (approved_at >= 0)
  );
  CREATE TABLE app_storage (
    app_id TEXT NOT NULL REFERENCES installed_apps(app_id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value_json TEXT NOT NULL,
    bytes INTEGER NOT NULL CHECK (bytes >= 0),
    PRIMARY KEY (app_id, key)
  );
  PRAGMA user_version=3;
`;

export function migrateSchema2To3Sql(version: number): string {
  if (version !== 2) throw new Error(`Schema 3 migration requires version 2, received ${version}.`);
  return `BEGIN IMMEDIATE; ${APP_STORAGE_SCHEMA_SQL} COMMIT;`;
}

export const PREFERENCES_SCHEMA_SQL = `
  ALTER TABLE preferences ADD COLUMN search_all_desktops INTEGER NOT NULL DEFAULT 0 CHECK (search_all_desktops IN (0, 1));
  ALTER TABLE preferences ADD COLUMN onboarding_version INTEGER NOT NULL DEFAULT 0 CHECK (onboarding_version >= 0);
  CREATE TABLE offline_pins (
    desktop_id TEXT NOT NULL REFERENCES desktops(id) ON DELETE CASCADE,
    entry_id TEXT NOT NULL,
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    PRIMARY KEY (desktop_id, entry_id)
  );
  PRAGMA user_version=4;
`;

export function migrateSchema3To4Sql(version: number): string {
  if (version !== 3) throw new Error(`Schema 4 migration requires version 3, received ${version}.`);
  return `BEGIN IMMEDIATE; ${PREFERENCES_SCHEMA_SQL} COMMIT;`;
}
