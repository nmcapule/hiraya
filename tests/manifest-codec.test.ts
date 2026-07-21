import { describe, expect, test } from "bun:test";
import { decodeManifest, parseManifestV10 } from "../src/lib/manifest-codec";
import { desktopSnapshot } from "./fixtures";

function manifestV10() {
  const snapshot = desktopSnapshot();
  return {
    version: 10 as const,
    entries: snapshot.entries,
    rootOrder: snapshot.layout.rootOrder,
    snapToGrid: snapshot.layout.snapToGrid,
    wallpaper: snapshot.layout.wallpaper,
    editorSettings: snapshot.editorSettings,
    sync: snapshot.sync,
  };
}

describe("OPFS manifest codec", () => {
  test("round-trips the persisted v10 shape", () => {
    const input = manifestV10();
    expect(parseManifestV10(JSON.parse(JSON.stringify(input)))).toEqual(input);
    expect(decodeManifest(input, { x: 100, y: 100 }, () => "unused").migrated).toBe(false);
  });

  test("migrates v9 views deterministically and preserves sync identity", () => {
    const entries = [
      { kind: "folder", id: "tie-2", name: "Tie 2", parentId: null, viewId: "view-2", modifiedAt: 1, position: { x: 8, y: 4 } },
      { kind: "folder", id: "later", name: "Later", parentId: null, viewId: "view-1", modifiedAt: 1, position: { x: 20, y: 1 } },
      { kind: "folder", id: "earlier", name: "Earlier", parentId: null, viewId: "view-1", modifiedAt: 1, position: { x: 10, y: 9 } },
      { kind: "folder", id: "tie-1", name: "Tie 1", parentId: null, viewId: "view-2", modifiedAt: 1, position: { x: 8, y: 4 } },
    ];
    const current = manifestV10();
    const decoded = decodeManifest({
      ...current,
      version: 9,
      entries,
      views: [{ id: "view-1" }, { id: "view-2" }],
      viewColumns: 2,
    }, { x: 100, y: 100 }, () => "unused");
    expect(decoded.migrated).toBe(true);
    expect(decoded.manifest.version).toBe(10);
    expect(decoded.manifest.rootOrder).toEqual(["earlier", "later", "tie-2", "tie-1"]);
    expect(decoded.manifest.entries.some((entry) => "viewId" in entry)).toBe(false);
    expect(decoded.manifest.sync).toEqual(current.sync);
  });

  test("migrates v8 sync state without a workspace identity", () => {
    const current = manifestV10();
    const { workspaceId: _workspaceId, ...sync } = current.sync;
    void _workspaceId;
    const decoded = decodeManifest({ ...current, version: 8, entries: [], views: [{ id: "view" }], viewColumns: 1, sync }, { x: 100, y: 100 }, () => "unused");
    expect(decoded.manifest.sync.workspaceId).toBeNull();
  });

  test("rejects invalid v10 sync and root ordering", () => {
    expect(() => parseManifestV10({ ...manifestV10(), sync: { ...manifestV10().sync, revision: -1 } })).toThrow("revision");
    expect(() => parseManifestV10({ ...manifestV10(), rootOrder: ["missing"] })).toThrow("root order");
  });
});
