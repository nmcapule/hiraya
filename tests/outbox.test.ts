import { describe, expect, test } from "bun:test";
import { applyOutboxOperation } from "../src/lib/outbox";
import { BUILTIN_THEMES } from "../src/lib/themes";
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

describe("theme outbox projection", () => {
  test("upserts, selects, and deletes with fallback without changing revisions", () => {
    const theme = { id: "custom", name: "Custom", definition: BUILTIN_THEMES["warm-paper"].definition };
    const created = applyOutboxOperation(manifest(), { kind: "upsert-theme", theme });
    const selected = applyOutboxOperation(created, { kind: "select-theme", themeId: theme.id });
    const deleted = applyOutboxOperation(selected, { kind: "delete-theme", themeId: theme.id });

    expect(selected.appearance).toEqual({ selectedThemeId: "custom", customThemes: [theme] });
    expect(deleted.appearance).toEqual({ selectedThemeId: "hiraya-dusk", customThemes: [] });
    expect(deleted.sync).toEqual(manifest().sync);
  });

  test("rejects missing selections and treats repeated deletes as satisfied", () => {
    expect(() => applyOutboxOperation(manifest(), { kind: "select-theme", themeId: "missing" })).toThrow("does not exist");
    expect(applyOutboxOperation(manifest(), { kind: "delete-theme", themeId: "missing" })).toEqual(manifest());
  });
});

describe("entry batch outbox projection", () => {
  test("creates mixed trees, moves batches, and recursively deletes batches", () => {
    const folder = { kind: "folder" as const, id: "11111111-1111-4111-8111-111111111111", name: "Copies", parentId: null, modifiedAt: 1, position: { x: 4, y: 5 } };
    const file = { kind: "file" as const, id: "22222222-2222-4222-8222-222222222222", name: "note.txt", parentId: folder.id, modifiedAt: 1, position: { x: 4, y: 5 }, mimeType: "text/plain", size: 3 };
    const created = applyOutboxOperation(manifest(), { kind: "create", entries: [file, folder] });
    expect(created.entries.find((entry) => entry.id === file.id)?.parentId).toBe(folder.id);

    const moved = applyOutboxOperation(created, { kind: "batch-move", entryIds: [file.id], parentId: null });
    expect(moved.entries.find((entry) => entry.id === file.id)?.parentId).toBeNull();

    const deleted = applyOutboxOperation(created, { kind: "batch-delete", entryIds: [folder.id] });
    expect(deleted.entries.some((entry) => entry.id === folder.id || entry.id === file.id)).toBe(false);
  });
});
