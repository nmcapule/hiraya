import type { DesktopSnapshot } from "../src/lib/opfs";
import { DEFAULT_THEME_STATE } from "../src/lib/themes";

export function desktopSnapshot(): DesktopSnapshot {
  return {
    entries: [],
    layout: { snapToGrid: false, wallpaper: "dusk" },
    editorSettings: { autoSave: true, fontSize: 13, language: "auto" },
    appearance: DEFAULT_THEME_STATE,
    sync: { workspaceId: null, revision: 0, entryRevisions: {}, contentRevisions: {}, layoutRevision: 0, settingsRevision: 0, themeSelectionRevision: 0, themeRevisions: {} },
  };
}

export function remoteWorkspace() {
  return {
    schemaVersion: 5,
    workspaceId: "workspace-1",
    initialized: true,
    revision: 1,
    entries: [{
      kind: "file",
      id: "file-1",
      name: "notes.txt",
      parentId: null,
      modifiedAt: 1,
      position: { x: 10, y: 20 },
      mimeType: "text/plain; charset=utf-8",
      size: 4,
      revision: 1,
      contentRevision: 1,
    }],
    layout: { snapToGrid: false, wallpaper: "dusk" },
    layoutRevision: 1,
    editorSettings: { autoSave: true, fontSize: 13, language: "auto" },
    settingsRevision: 1,
    appearance: { selectedThemeId: "hiraya-dusk", selectionRevision: 1, customThemes: [] },
  };
}
