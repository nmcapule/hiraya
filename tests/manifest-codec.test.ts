import { describe, expect, test } from "bun:test";
import { decodeManifest, parseManifestV11, removeRootsFromLayout } from "../src/lib/manifest-codec";
import { desktopSnapshot } from "./fixtures";

function manifestV11() {
  const snapshot = desktopSnapshot();
  return {
    version: 11 as const,
    entries: snapshot.entries,
    rootOrder: snapshot.layout.rootOrder,
    workspaceBreaks: snapshot.layout.workspaceBreaks,
    snapToGrid: snapshot.layout.snapToGrid,
    wallpaper: snapshot.layout.wallpaper,
    editorSettings: snapshot.editorSettings,
    sync: snapshot.sync,
  };
}

describe("OPFS manifest codec", () => {
  test("round-trips the persisted v11 shape", () => {
    const input = manifestV11();
    expect(parseManifestV11(JSON.parse(JSON.stringify(input)))).toEqual(input);
    expect(decodeManifest(input, { x: 100, y: 100 }, () => "unused").migrated).toBe(false);
  });

  test("migrates v9 views deterministically and preserves sync identity", () => {
    const entries = [
      { kind: "folder", id: "tie-2", name: "Tie 2", parentId: null, viewId: "view-2", modifiedAt: 1, position: { x: 8, y: 4 } },
      { kind: "folder", id: "later", name: "Later", parentId: null, viewId: "view-1", modifiedAt: 1, position: { x: 20, y: 1 } },
      { kind: "folder", id: "earlier", name: "Earlier", parentId: null, viewId: "view-1", modifiedAt: 1, position: { x: 10, y: 9 } },
      { kind: "folder", id: "tie-1", name: "Tie 1", parentId: null, viewId: "view-2", modifiedAt: 1, position: { x: 8, y: 4 } },
    ];
    const current = manifestV11();
    const decoded = decodeManifest({
      ...current,
      version: 9,
      entries,
      views: [{ id: "view-1" }, { id: "view-2" }],
      viewColumns: 2,
    }, { x: 100, y: 100 }, () => "unused");
    expect(decoded.migrated).toBe(true);
    expect(decoded.manifest.version).toBe(11);
    expect(decoded.manifest.workspaceBreaks).toEqual([]);
    expect(decoded.manifest.rootOrder).toEqual(["earlier", "later", "tie-2", "tie-1"]);
    expect(decoded.manifest.entries.some((entry) => "viewId" in entry)).toBe(false);
    expect(decoded.manifest.sync).toEqual(current.sync);
  });

  test("migrates v8 sync state without a workspace identity", () => {
    const current = manifestV11();
    const { workspaceId: _workspaceId, ...sync } = current.sync;
    void _workspaceId;
    const decoded = decodeManifest({ ...current, version: 8, entries: [], views: [{ id: "view" }], viewColumns: 1, sync }, { x: 100, y: 100 }, () => "unused");
    expect(decoded.manifest.sync.workspaceId).toBeNull();
  });

  test("migrates v10 with no workspace breaks", () => {
    const current = manifestV11();
    const { workspaceBreaks: _workspaceBreaks, ...legacy } = current;
    void _workspaceBreaks;
    const decoded = decodeManifest({ ...legacy, version: 10 }, { x: 100, y: 100 }, () => "unused");
    expect(decoded.migrated).toBe(true);
    expect(decoded.manifest).toEqual(current);
  });

  test("rejects invalid v11 sync, root ordering, and breaks", () => {
    expect(() => parseManifestV11({ ...manifestV11(), sync: { ...manifestV11().sync, revision: -1 } })).toThrow("revision");
    expect(() => parseManifestV11({ ...manifestV11(), rootOrder: ["missing"] })).toThrow("root order");
    expect(() => parseManifestV11({ ...manifestV11(), workspaceBreaks: [{ entryId: "missing", maxCapacity: 2 }] })).toThrow("reference a root");
  });

  test("promotes removed workspace boundaries only within their logical group", () => {
    const layout = {
      rootOrder: ["a", "b", "c", "d", "e"],
      workspaceBreaks: [{ entryId: "b", maxCapacity: 2 }, { entryId: "d", maxCapacity: 7 }],
      snapToGrid: false,
      wallpaper: "dusk" as const,
    };
    expect(removeRootsFromLayout(layout, new Set(["b"]))).toEqual({
      ...layout,
      rootOrder: ["a", "c", "d", "e"],
      workspaceBreaks: [{ entryId: "c", maxCapacity: 2 }, { entryId: "d", maxCapacity: 7 }],
    });
    expect(removeRootsFromLayout(layout, new Set(["b", "c", "d"]))).toEqual({
      ...layout,
      rootOrder: ["a", "e"],
      workspaceBreaks: [{ entryId: "e", maxCapacity: 7 }],
    });
    expect(removeRootsFromLayout(layout, new Set(["d", "e"])).workspaceBreaks).toEqual([{ entryId: "b", maxCapacity: 2 }]);
  });
});
