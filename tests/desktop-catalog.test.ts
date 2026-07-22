import { describe, expect, test } from "bun:test";
import { canAdoptFreshPlaceholder, desktopDeleteProtection, desktopIdForManifest, parseDesktopCatalog, resolveDesktopContext } from "../src/lib/desktop-catalog";
import { desktopSnapshot } from "./fixtures";

function manifest() {
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

describe("desktop catalog", () => {
  test("parses the global revision and default desktop identity", () => {
    expect(parseDesktopCatalog({
      revision: 7,
      defaultDesktopId: "legacy-workspace",
      desktops: [{ id: "legacy-workspace", name: "Desktop", revision: 4 }],
      ignored: true,
    })).toEqual({
      revision: 7,
      defaultDesktopId: "legacy-workspace",
      desktops: [{ id: "legacy-workspace", name: "Desktop", revision: 4 }],
    });
    expect(() => parseDesktopCatalog({ revision: 1, defaultDesktopId: "missing", desktops: [] })).toThrow("does not exist");
    expect(() => parseDesktopCatalog({ revision: 1, defaultDesktopId: "a", desktops: [{ id: "a", name: "A", revision: -1 }] })).toThrow("revision");
  });

  test("uses a valid legacy workspace identity for SQLite migration", () => {
    expect(desktopIdForManifest({ ...manifest(), sync: { ...manifest().sync, workspaceId: "legacy-workspace" } }, "random-id")).toBe("legacy-workspace");
    expect(desktopIdForManifest({ ...manifest(), sync: { ...manifest().sync, workspaceId: "bad/id" } }, "random-id")).toBe("random-id");
    expect(desktopIdForManifest(manifest(), "random-id")).toBe("random-id");
  });

  test("only adopts a marked, sole, empty, unsynchronized placeholder", () => {
    const fresh = { adoptablePlaceholder: true, desktopCount: 1, entryCount: 0, outboxCount: 0, workspaceId: null };
    expect(canAdoptFreshPlaceholder(fresh)).toBe(true);
    expect(canAdoptFreshPlaceholder({ ...fresh, adoptablePlaceholder: false })).toBe(false);
    expect(canAdoptFreshPlaceholder({ ...fresh, entryCount: 1 })).toBe(false);
    expect(canAdoptFreshPlaceholder({ ...fresh, outboxCount: 1 })).toBe(false);
    expect(canAdoptFreshPlaceholder({ ...fresh, desktopCount: 2 })).toBe(false);
    expect(canAdoptFreshPlaceholder({ ...fresh, workspaceId: "workspace" })).toBe(false);
  });

  test("keeps each tab's valid requested desktop ahead of the migration fallback", () => {
    const desktops = [{ id: "one", name: "One" }, { id: "two", name: "Two" }];
    expect(resolveDesktopContext("two", desktops, "one")).toBe("two");
    expect(resolveDesktopContext("missing", desktops, "one")).toBe("one");
    expect(resolveDesktopContext(null, desktops, null)).toBe("one");
  });

  test("protects the backend default desktop independently of last-desktop protection", () => {
    expect(desktopDeleteProtection("default", "default", 3)).toContain("older clients");
    expect(desktopDeleteProtection("only", "different", 1)).toContain("last desktop");
    expect(desktopDeleteProtection("work", "default", 3)).toBe("");
  });
});
