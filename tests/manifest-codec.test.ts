import { describe, expect, test } from "bun:test";
import { decodeManifest, parseManifestV9 } from "../src/lib/manifest-codec";
import { desktopSnapshot } from "./fixtures";

function manifestV9() {
  const snapshot = desktopSnapshot();
  return {
    version: 9 as const,
    entries: snapshot.entries,
    views: snapshot.layout.views,
    viewColumns: snapshot.layout.columns,
    snapToGrid: snapshot.layout.snapToGrid,
    wallpaper: snapshot.layout.wallpaper,
    editorSettings: snapshot.editorSettings,
    sync: snapshot.sync,
  };
}

describe("OPFS manifest codec", () => {
  test("round-trips the persisted v9 shape", () => {
    const input = manifestV9();
    expect(parseManifestV9(JSON.parse(JSON.stringify(input)))).toEqual(input);
    expect(decodeManifest(input, { x: 100, y: 100 }, () => "unused").migrated).toBe(false);
  });

  test("migrates v8 sync state without a workspace identity", () => {
    const current = manifestV9();
    const { workspaceId: _workspaceId, ...sync } = current.sync;
    void _workspaceId;
    const decoded = decodeManifest({ ...current, version: 8, sync }, { x: 100, y: 100 }, () => "unused");
    expect(decoded.migrated).toBe(true);
    expect(decoded.manifest.version).toBe(9);
    expect(decoded.manifest.sync.workspaceId).toBeNull();
  });

  test("migrates v3 deterministically while preserving entries", () => {
    const file = {
      kind: "file" as const,
      id: "file-1",
      name: "one.txt",
      parentId: null,
      viewId: "view-old",
      modifiedAt: 1,
      position: { x: 4, y: 5 },
      mimeType: "text/plain",
      size: 0,
    };
    const decoded = decodeManifest({ version: 3, entries: [file], views: [{ id: "view-old" }], viewColumns: 1 }, { x: 100, y: 100 }, () => "unused");
    expect(decoded.migrated).toBe(true);
    expect(decoded.manifest.version).toBe(9);
    expect(decoded.manifest.entries).toEqual([file]);
    expect(decoded.manifest.wallpaper).toBe("dusk");
  });

  test("migrates v6 and v7 sync state without a workspace identity", () => {
    const current = manifestV9();
    const { workspaceId: _workspaceId, ...sync } = current.sync;
    void _workspaceId;
    for (const version of [6, 7]) {
      const decoded = decodeManifest({ ...current, version, sync }, { x: 100, y: 100 }, () => "unused");
      expect(decoded.manifest.sync.workspaceId).toBeNull();
    }
  });

  test("rejects invalid v9 sync and entry metadata", () => {
    expect(() => parseManifestV9({ ...manifestV9(), sync: { ...manifestV9().sync, revision: -1 } })).toThrow("revision");
    expect(() => parseManifestV9({ ...manifestV9(), views: [{ id: "bad/id" }] })).toThrow("view ID");
  });
});
