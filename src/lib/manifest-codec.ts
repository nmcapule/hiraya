import { DEFAULT_WALLPAPER, type DesktopEntry, type DesktopLayout, type DesktopView, type EditorSettings, type EntryPosition, type FileEntry, type Wallpaper } from "../types";
import { isRecord, parseEditorSettings, parseEntries, parseLayout, readRevision } from "./contracts";

export type DesktopSyncState = {
  workspaceId: string | null;
  revision: number;
  entryRevisions: Record<string, number>;
  contentRevisions: Record<string, number>;
  layoutRevision: number;
  settingsRevision: number;
};

export type PersistedManifestV9 = {
  version: 9;
  entries: DesktopEntry[];
  views: DesktopView[];
  viewColumns: number;
  snapToGrid: boolean;
  wallpaper: Wallpaper;
  editorSettings: EditorSettings;
  sync: DesktopSyncState;
};

export const DEFAULT_EDITOR_SETTINGS: EditorSettings = { autoSave: true, fontSize: 13, language: "auto" };

export function emptySyncState(): DesktopSyncState {
  return { workspaceId: null, revision: 0, entryRevisions: {}, contentRevisions: {}, layoutRevision: 0, settingsRevision: 0 };
}

function parseRevisionMap(value: unknown) {
  if (!isRecord(value)) throw new Error("The desktop sync state has an unsupported format.");
  return Object.fromEntries(Object.entries(value).map(([id, revision]) => [id, readRevision(revision)]));
}

function parseSyncState(value: unknown): DesktopSyncState {
  if (!isRecord(value)) throw new Error("The desktop sync state has an unsupported format.");
  return {
    workspaceId: value.workspaceId === null ? null : (() => {
      if (typeof value.workspaceId !== "string" || !value.workspaceId) throw new Error("The desktop sync state has an unsupported format.");
      return value.workspaceId;
    })(),
    revision: readRevision(value.revision),
    entryRevisions: parseRevisionMap(value.entryRevisions),
    contentRevisions: parseRevisionMap(value.contentRevisions),
    layoutRevision: readRevision(value.layoutRevision),
    settingsRevision: readRevision(value.settingsRevision),
  };
}

export function parseManifestV9(value: unknown): PersistedManifestV9 {
  if (!isRecord(value) || value.version !== 9 || !Array.isArray(value.views)) throw new Error("The storage index has an unsupported format.");
  const layout = parseLayout({ views: value.views, columns: value.viewColumns, snapToGrid: value.snapToGrid, wallpaper: value.wallpaper });
  return {
    version: 9,
    entries: parseEntries(value.entries, layout),
    views: layout.views,
    viewColumns: layout.columns,
    snapToGrid: layout.snapToGrid,
    wallpaper: layout.wallpaper,
    editorSettings: parseEditorSettings(value.editorSettings),
    sync: parseSyncState(value.sync),
  };
}

function migrateEntries(entries: unknown[], viewport: EntryPosition, createId: () => string): PersistedManifestV9 {
  const width = Math.max(1, viewport.x);
  const height = Math.max(1, viewport.y);
  const typed = entries as Array<Omit<DesktopEntry, "viewId">>;
  const rootEntries = typed.filter((entry) => entry.parentId === null);
  const columns = Math.max(1, ...rootEntries.map((entry) => Math.floor(entry.position.x / width) + 1));
  const rows = Math.max(1, ...rootEntries.map((entry) => Math.floor(entry.position.y / height) + 1));
  const views = Array.from({ length: columns * rows }, () => ({ id: createId() }));
  return parseManifestV9({
    version: 9,
    viewColumns: columns,
    views,
    snapToGrid: false,
    wallpaper: DEFAULT_WALLPAPER,
    editorSettings: DEFAULT_EDITOR_SETTINGS,
    sync: emptySyncState(),
    entries: typed.map((entry) => {
      if (entry.parentId !== null) return { ...entry, viewId: null };
      const column = Math.floor(entry.position.x / width);
      const row = Math.floor(entry.position.y / height);
      return { ...entry, viewId: views[row * columns + column].id, position: { x: entry.position.x % width, y: entry.position.y % height } };
    }),
  });
}

export function decodeManifest(value: unknown, viewport: EntryPosition, createId: () => string): { manifest: PersistedManifestV9; migrated: boolean } {
  if (!isRecord(value) || !Number.isInteger(value.version)) throw new Error("The storage index has an unsupported format.");
  const version = value.version as number;
  if (version === 9) return { manifest: parseManifestV9(value), migrated: false };
  if (version === 8) {
    return {
      manifest: parseManifestV9({ ...value, version: 9, sync: { ...(isRecord(value.sync) ? value.sync : {}), workspaceId: null } }),
      migrated: true,
    };
  }
  if (version === 1 && Array.isArray(value.files)) {
    const entries = value.files.map((entry) => ({ ...(entry as Omit<FileEntry, "kind" | "parentId" | "viewId">), kind: "file" as const, parentId: null }));
    return { manifest: migrateEntries(entries, viewport, createId), migrated: true };
  }
  if (version === 2 && Array.isArray(value.entries)) return { manifest: migrateEntries(value.entries, viewport, createId), migrated: true };
  if (version < 3 || version > 7 || !Array.isArray(value.entries) || !Array.isArray(value.views)) throw new Error("The storage index has an unsupported format.");
  const legacy = value as Record<string, unknown>;
  const editorSettings = version === 3 ? DEFAULT_EDITOR_SETTINGS : version === 4 && isRecord(legacy.editorSettings)
    ? { ...legacy.editorSettings, autoSave: true }
    : legacy.editorSettings;
  return {
    manifest: parseManifestV9({
      version: 9,
      entries: legacy.entries,
      views: legacy.views,
      viewColumns: legacy.viewColumns,
      snapToGrid: version < 7 ? false : legacy.snapToGrid,
      wallpaper: DEFAULT_WALLPAPER,
      editorSettings,
      sync: version < 6 ? emptySyncState() : { ...(isRecord(legacy.sync) ? legacy.sync : {}), workspaceId: null },
    }),
    migrated: true,
  };
}

export function manifestLayout(manifest: PersistedManifestV9): DesktopLayout {
  return { views: manifest.views, columns: manifest.viewColumns, snapToGrid: manifest.snapToGrid, wallpaper: manifest.wallpaper };
}
