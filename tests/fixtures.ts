import type { DesktopSnapshot } from "../src/lib/opfs";

export function desktopSnapshot(): DesktopSnapshot {
  return {
    entries: [],
    layout: { views: [{ id: "view-1" }], columns: 1, snapToGrid: false, wallpaper: "dusk" },
    editorSettings: { autoSave: true, fontSize: 13, language: "auto" },
    sync: { workspaceId: null, revision: 0, entryRevisions: {}, contentRevisions: {}, layoutRevision: 0, settingsRevision: 0 },
  };
}

export function remoteWorkspace() {
  return {
    schemaVersion: 1,
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
      viewId: "view-1",
      mimeType: "text/plain; charset=utf-8",
      size: 4,
      revision: 1,
      contentRevision: 1,
    }],
    layout: { views: [{ id: "view-1" }], columns: 1, snapToGrid: false, wallpaper: "dusk" },
    layoutRevision: 1,
    editorSettings: { autoSave: true, fontSize: 13, language: "auto" },
    settingsRevision: 1,
  };
}
