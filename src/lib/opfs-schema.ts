export const DATABASE_SCHEMA_VERSION = 3;

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
