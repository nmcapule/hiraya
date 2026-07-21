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
