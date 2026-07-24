import { describe, expect, test } from "bun:test";
import { createStorageDbRequest, parseOfflinePinResponse, parseStorageProtocol, validateOfflinePinRequest } from "../src/lib/opfs-db-protocol";
import { STORAGE_PROTOCOL_VERSION } from "../src/lib/storage-worker";
import { APP_STORAGE_SCHEMA_SQL, DATABASE_SCHEMA_VERSION, migrateSchema2To3Sql, migrateSchema3To4Sql, PREFERENCES_SCHEMA_SQL } from "../src/lib/opfs-schema";

describe("storage worker request context", () => {
  test("keeps concurrent tab requests explicitly scoped to their desktops", () => {
    const first = createStorageDbRequest(1, "desktop-a", "readDesktop", { desktopId: "desktop-a" });
    const second = createStorageDbRequest(2, "desktop-b", "readDesktop", { desktopId: "desktop-b" });
    expect(first).toEqual({ id: 1, desktopId: "desktop-a", method: "readDesktop", params: { desktopId: "desktop-a" } });
    expect(second).toEqual({ id: 2, desktopId: "desktop-b", method: "readDesktop", params: { desktopId: "desktop-b" } });
  });
});

describe("local schema 4", () => {
  test("adds app approvals and isolated storage without changing desktop tables", () => {
    expect(DATABASE_SCHEMA_VERSION).toBe(4);
    expect(APP_STORAGE_SCHEMA_SQL).toContain("CREATE TABLE installed_apps");
    expect(APP_STORAGE_SCHEMA_SQL).toContain("CREATE TABLE app_storage");
    expect(APP_STORAGE_SCHEMA_SQL).toContain("ON DELETE CASCADE");
    expect(APP_STORAGE_SCHEMA_SQL).toContain("PRAGMA user_version=3");
    expect(migrateSchema2To3Sql(2)).toMatch(/^BEGIN IMMEDIATE;[\s\S]+COMMIT;$/);
    expect(() => migrateSchema2To3Sql(1)).toThrow("requires version 2");
  });

  test("migrates namespaced preferences once and reserves normalized offline pins", () => {
    expect(PREFERENCES_SCHEMA_SQL).toContain("search_all_desktops");
    expect(PREFERENCES_SCHEMA_SQL).toContain("onboarding_version");
    expect(PREFERENCES_SCHEMA_SQL).toContain("CREATE TABLE offline_pins");
    expect(PREFERENCES_SCHEMA_SQL).toContain("PRAGMA user_version=4");
    expect(migrateSchema3To4Sql(3)).toMatch(/^BEGIN IMMEDIATE;[\s\S]+COMMIT;$/);
    expect(() => migrateSchema3To4Sql(2)).toThrow("requires version 3");
  });

  test("keeps app RPC requests device-local", () => {
    const request = createStorageDbRequest(3, null, "readAppStorage", { appId: "test.editor", key: "theme" });
    expect(request.desktopId).toBeNull();
    expect(request.params).toEqual({ appId: "test.editor", key: "theme" });
  });

  test("uses strict schema-v4 pin requests without another migration", () => {
    const list = createStorageDbRequest(4, "desktop-a", "listOfflinePins", { desktopId: "desktop-a" });
    const update = createStorageDbRequest(5, "desktop-a", "setOfflinePins", { desktopId: "desktop-a", entryIds: ["entry-a"], pinned: true, createdAt: 123 });
    expect(DATABASE_SCHEMA_VERSION).toBe(4);
    expect(list.params).toEqual({ desktopId: "desktop-a" });
    expect(update.params).toEqual({ desktopId: "desktop-a", entryIds: ["entry-a"], pinned: true, createdAt: 123 });
  });

  test("rejects malformed pin requests and cross-desktop responses", () => {
    expect(() => validateOfflinePinRequest("setOfflinePins", { desktopId: "desktop-a", entryIds: ["entry-a", "entry-a"], pinned: true, createdAt: 1 }, "desktop-a")).toThrow("invalid");
    expect(() => validateOfflinePinRequest("setOfflinePins", { desktopId: "desktop-a", entryIds: ["entry-a"], pinned: 1, createdAt: 1 }, "desktop-a")).toThrow("invalid");
    expect(() => validateOfflinePinRequest("listOfflinePins", { desktopId: "desktop-a", extra: true }, "desktop-a")).toThrow("binding");
    expect(() => parseOfflinePinResponse({ desktopId: "desktop-b", entryIds: ["entry-a"] }, "desktop-a")).toThrow("invalid offline-pin response");
    expect(() => parseOfflinePinResponse({ desktopId: "desktop-a", entryIds: ["entry-a", "entry-a"] }, "desktop-a")).toThrow("invalid offline-pin response");
  });

  test("handshakes the named worker protocol", () => {
    expect(STORAGE_PROTOCOL_VERSION).toBe(3);
    expect(parseStorageProtocol({ version: 3 })).toBe(3);
    expect(() => parseStorageProtocol({ version: 2 })).toThrow("outdated");
  });
});
