import { describe, expect, test } from "bun:test";
import { createWindowSession, parseWindowSession, parseWindowTargets, restoreWindowSession } from "../src/lib/window-session";
import type { DesktopEntry } from "../src/types";

describe("window and browser sessions", () => {
  test("omits ephemeral sandbox apps from strict v1 sessions", () => {
    const bounds = { x: 0, y: 0, width: 500, height: 400 };
    expect(createWindowSession([
      { kind: "settings", bounds, minimized: false, zIndex: 1 },
      { kind: "sandbox", packageId: "dev.hiraya.test", bounds, minimized: false, zIndex: 2 },
    ])).toEqual({ schemaVersion: 1, apps: [{ kind: "settings", bounds, minimized: false, zIndex: 1 }] });
  });
  test("requires window session schema version 1", () => {
    const value = { schemaVersion: 1, apps: [{ kind: "settings", bounds: { x: 0, y: 0, width: 500, height: 400 }, minimized: false, zIndex: 1 }] };
    expect(parseWindowSession(value)).toEqual(value);
    expect(() => parseWindowSession({ ...value, version: 4, schemaVersion: undefined })).toThrow("unsupported format");
  });

  test("requires browser history schema version 1", () => {
    expect(parseWindowTargets({ schemaVersion: 1, apps: [{ kind: "explorer", folderId: null }] })).toEqual([{ kind: "explorer", folderId: null }]);
    expect(() => parseWindowTargets([{ kind: "explorer", folderId: null }])).toThrow("unsupported format");
  });

  test("parses and normalizes every persisted built-in target", () => {
    expect(parseWindowTargets({ schemaVersion: 1, apps: [
      { kind: "file", fileId: "file", editMode: false, ignored: true },
      { kind: "explorer", folderId: "folder" },
      { kind: "properties", entryId: "entry" },
      { kind: "settings", ignored: true },
    ] })).toEqual([
      { kind: "file", fileId: "file" },
      { kind: "explorer", folderId: "folder" },
      { kind: "properties", entryId: "entry" },
      { kind: "settings" },
    ]);
  });

  test("rejects unregistered and malformed targets in history and sessions", () => {
    expect(() => parseWindowTargets({ schemaVersion: 1, apps: [{ kind: "trash" }] })).toThrow("invalid app");
    expect(() => parseWindowTargets({ schemaVersion: 1, apps: [{ kind: "file", fileId: "file", editMode: "true" }] })).toThrow("invalid app");
    expect(() => parseWindowSession({ schemaVersion: 1, apps: [{ kind: "explorer", folderId: undefined, bounds: { x: 0, y: 0, width: 500, height: 400 }, minimized: false, zIndex: 1 }] })).toThrow("invalid app");
  });

  test("restores properties windows for current files and folders and filters stale targets", () => {
    const entries: DesktopEntry[] = [
      { kind: "folder", id: "folder", name: "Folder", parentId: null, createdAt: 1, modifiedAt: 1, position: { x: 0, y: 0 } },
      { kind: "file", id: "file", name: "File.txt", parentId: "folder", createdAt: 1, modifiedAt: 1, position: { x: 0, y: 0 }, mimeType: "text/plain", size: 1 },
    ];
    const bounds = { x: 10, y: 20, width: 420, height: 320 };
    const session = parseWindowSession({ schemaVersion: 1, apps: [
      { kind: "properties", entryId: "folder", bounds, minimized: false, zIndex: 3 },
      { kind: "properties", entryId: "file", bounds, minimized: false, zIndex: 2 },
      { kind: "properties", entryId: "missing", bounds, minimized: false, zIndex: 1 },
    ] });
    expect(restoreWindowSession(session, entries, { column: 0, row: 0 }, { width: 1000, height: 700 }).map((app) => app.kind === "properties" ? app.entryId : app.kind)).toEqual(["file", "folder"]);
  });

  test("rejects duplicate window and history targets", () => {
    const app = { kind: "settings", bounds: { x: 0, y: 0, width: 500, height: 400 }, minimized: false, zIndex: 1 };
    expect(() => parseWindowSession({ schemaVersion: 1, apps: [app, app] })).toThrow("duplicate apps");
    expect(() => parseWindowTargets({ schemaVersion: 1, apps: [{ kind: "settings" }, { kind: "settings" }] })).toThrow("duplicate apps");
  });

  test("uses registry minimum sizes while restoring", () => {
    const bounds = { x: 0, y: 0, width: 1, height: 1 };
    const session = parseWindowSession({ schemaVersion: 1, apps: [
      { kind: "properties", entryId: "folder", bounds, minimized: false, zIndex: 1 },
      { kind: "explorer", folderId: null, bounds, minimized: false, zIndex: 2 },
    ] });
    const entries: DesktopEntry[] = [{ kind: "folder", id: "folder", name: "Folder", parentId: null, createdAt: 1, modifiedAt: 1, position: { x: 0, y: 0 } }];
    const restored = restoreWindowSession(session, entries, { column: 0, row: 0 }, { width: 1000, height: 700 });
    expect(restored.map((app) => ({ kind: app.kind, width: app.bounds.width, height: app.bounds.height }))).toEqual([
      { kind: "properties", width: 360, height: 320 },
      { kind: "explorer", width: 360, height: 280 },
    ]);
  });
});
