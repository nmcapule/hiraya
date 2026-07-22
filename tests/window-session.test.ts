import { describe, expect, test } from "bun:test";
import type { DesktopEntry } from "../src/types";
import { parseWindowSession, restoreWindowSession } from "../src/lib/window-session";

const entries: DesktopEntry[] = [
  { id: "folder", name: "Folder", kind: "folder", parentId: null, modifiedAt: 1, position: { x: 0, y: 0 } },
  { id: "file", name: "File.txt", kind: "file", parentId: "folder", modifiedAt: 1, position: { x: 0, y: 0 }, mimeType: "text/plain", size: 1 },
];

describe("window sessions", () => {
  test("parses supported app targets", () => {
    const session = {
      version: 1,
      apps: [
        { kind: "settings", bounds: { x: 1, y: 2, width: 500, height: 400 }, minimized: false, zIndex: 3 },
        { kind: "explorer", folderId: null, bounds: { x: 2, y: 3, width: 500, height: 400 }, minimized: true, zIndex: 1 },
        { kind: "file", fileId: "file", bounds: { x: 3, y: 4, width: 500, height: 400 }, minimized: false, zIndex: 2 },
      ],
    };
    expect(parseWindowSession(session)).toEqual(session);
  });

  test("rejects duplicate targets and invalid geometry", () => {
    const app = { kind: "settings", bounds: { x: 0, y: 0, width: 500, height: 400 }, minimized: false, zIndex: 1 };
    expect(() => parseWindowSession({ version: 1, apps: [app, app] })).toThrow("duplicate apps");
    expect(() => parseWindowSession({ version: 1, apps: [{ ...app, bounds: { ...app.bounds, width: Number.NaN } }] })).toThrow("invalid bounds");
  });

  test("filters stale targets, clamps bounds, and normalizes stacking", () => {
    const restored = restoreWindowSession(parseWindowSession({
      version: 1,
      apps: [
        { kind: "file", fileId: "missing", bounds: { x: 0, y: 0, width: 500, height: 400 }, minimized: false, zIndex: 1 },
        { kind: "file", fileId: "file", bounds: { x: -20, y: 900, width: 100, height: 100 }, minimized: true, zIndex: 8 },
        { kind: "explorer", folderId: "folder", bounds: { x: 10, y: 20, width: 500, height: 400 }, minimized: false, zIndex: 3 },
      ],
    }), entries, { width: 800, height: 600 });

    expect(restored).toEqual([
      { kind: "explorer", folderId: "folder", bounds: { x: 10, y: 20, width: 500, height: 400 }, minimized: false, zIndex: 1 },
      { kind: "file", fileId: "file", bounds: { x: 0, y: 280, width: 420, height: 320 }, minimized: true, zIndex: 2 },
    ]);
  });
});
