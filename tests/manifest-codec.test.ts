import { describe, expect, test } from "bun:test";
import { decodeManifest, parseManifestV13 } from "../src/lib/manifest-codec";
import { desktopSnapshot } from "./fixtures";

function manifestV13() {
  const snapshot = desktopSnapshot();
  return {
    version: 13 as const,
    entries: snapshot.entries,
    snapToGrid: snapshot.layout.snapToGrid,
    wallpaper: snapshot.layout.wallpaper,
    editorSettings: snapshot.editorSettings,
    appearance: snapshot.appearance,
    sync: snapshot.sync,
  };
}

describe("OPFS manifest codec", () => {
  test("round-trips the persisted v13 shape", () => {
    const input = manifestV13();
    expect(parseManifestV13(JSON.parse(JSON.stringify(input)))).toEqual(input);
    expect(decodeManifest(input).migrated).toBe(false);
  });

  test("migrates v11 without ordering metadata and preserves signed coordinates", () => {
    const current = manifestV13();
    const decoded = decodeManifest({
      ...current,
      version: 11,
      entries: [{ kind: "folder", id: "a", name: "A", parentId: null, modifiedAt: 1, position: { x: -250, y: 90 } }],
      rootOrder: ["a"],
      workspaceBreaks: [{ entryId: "a", maxCapacity: 1 }],
    });
    expect(decoded.migrated).toBe(true);
    expect(decoded.manifest.version).toBe(13);
    expect(decoded.manifest.entries[0].position).toEqual({ x: -250, y: 90 });
    expect("rootOrder" in decoded.manifest).toBe(false);
    expect("workspaceBreaks" in decoded.manifest).toBe(false);
  });

  test("migrates the original file-only manifest into current relational input", () => {
    const decoded = decodeManifest({
      version: 1,
      files: [{ id: "legacy-file", name: "legacy.txt", mimeType: "text/plain", size: 3, modifiedAt: 1, position: { x: -20, y: 40 } }],
    });
    expect(decoded.manifest.entries).toEqual([{
      kind: "file",
      id: "legacy-file",
      name: "legacy.txt",
      parentId: null,
      mimeType: "text/plain",
      size: 3,
      modifiedAt: 1,
      position: { x: -20, y: 40 },
    }]);
    expect(decoded.manifest.appearance).toEqual({ selectedThemeId: "hiraya-dusk", customThemes: [] });
    expect(decoded.manifest.sync).toEqual({ workspaceId: null, revision: 0, entryRevisions: {}, contentRevisions: {}, layoutRevision: 0, settingsRevision: 0, themeSelectionRevision: 0, themeRevisions: {} });
  });

  test("migrates old view manifests without viewport-based coordinate rewriting", () => {
    const current = manifestV13();
    const decoded = decodeManifest({
      ...current,
      version: 9,
      entries: [{ kind: "folder", id: "a", name: "A", parentId: null, viewId: "view-2", modifiedAt: 1, position: { x: 240, y: -12 } }],
      views: [{ id: "view-1" }, { id: "view-2" }],
    });
    expect(decoded.manifest.entries[0].position).toEqual({ x: 240, y: -12 });
    expect("viewId" in decoded.manifest.entries[0]).toBe(false);
    expect(decoded.manifest.sync).toEqual(current.sync);
  });

  test("migrates v8 sync state without a workspace identity", () => {
    const current = manifestV13();
    const { workspaceId: _workspaceId, ...sync } = current.sync;
    void _workspaceId;
    const decoded = decodeManifest({ ...current, version: 8, sync });
    expect(decoded.manifest.sync.workspaceId).toBeNull();
  });

  test("rejects invalid v13 sync and non-finite positions", () => {
    expect(() => parseManifestV13({ ...manifestV13(), sync: { ...manifestV13().sync, revision: -1 } })).toThrow("revision");
    expect(() => parseManifestV13({ ...manifestV13(), entries: [{ kind: "folder", id: "a", name: "A", parentId: null, modifiedAt: 1, position: { x: Number.NaN, y: 0 } }] })).toThrow("position");
  });
});
