import { DEFAULT_WALLPAPER, type DesktopEntry, type DesktopLayout, type EditorSettings, type EntryPosition, type FileEntry, type Wallpaper } from "../types";
import { assertValidId, isRecord, parseEditorSettings, parseEntries, parseLayout, readRevision } from "./contracts";

export type DesktopSyncState = {
  workspaceId: string | null;
  revision: number;
  entryRevisions: Record<string, number>;
  contentRevisions: Record<string, number>;
  layoutRevision: number;
  settingsRevision: number;
};

export type PersistedManifestV10 = {
  version: 10;
  entries: DesktopEntry[];
  rootOrder: string[];
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

export function parseManifestV10(value: unknown): PersistedManifestV10 {
  if (!isRecord(value) || value.version !== 10) throw new Error("The storage index has an unsupported format.");
  const layout = parseLayout({ rootOrder: value.rootOrder, snapToGrid: value.snapToGrid, wallpaper: value.wallpaper });
  return {
    version: 10,
    entries: parseEntries(value.entries, layout),
    rootOrder: layout.rootOrder,
    snapToGrid: layout.snapToGrid,
    wallpaper: layout.wallpaper,
    editorSettings: parseEditorSettings(value.editorSettings),
    sync: parseSyncState(value.sync),
  };
}

type LegacyView = { id: string };

function legacyRootOrder(entries: DesktopEntry[], views: LegacyView[]) {
  const viewIndexes = new Map<string, number>();
  for (const [index, view] of views.entries()) {
    if (!isRecord(view)) throw new Error("The desktop layout has an invalid view.");
    assertValidId(view.id, "The desktop layout has an invalid view ID.");
    if (viewIndexes.has(view.id)) throw new Error("The desktop layout contains duplicate view IDs.");
    viewIndexes.set(view.id, index);
  }
  for (const entry of entries) {
    const viewId = (entry as DesktopEntry & { viewId?: unknown }).viewId;
    if (entry.parentId === null && (typeof viewId !== "string" || !viewIndexes.has(viewId))) throw new Error("A root entry refers to a missing view.");
    if (entry.parentId !== null && viewId !== null && viewId !== undefined) throw new Error("Nested entries cannot belong to a view.");
  }
  return entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.parentId === null)
    .sort((a, b) => {
      const aView = viewIndexes.get((a.entry as DesktopEntry & { viewId?: string | null }).viewId ?? "") ?? views.length;
      const bView = viewIndexes.get((b.entry as DesktopEntry & { viewId?: string | null }).viewId ?? "") ?? views.length;
      return aView - bView || a.entry.position.x - b.entry.position.x || a.entry.position.y - b.entry.position.y || a.index - b.index;
    })
    .map(({ entry }) => entry.id);
}

function stripViewIds(entries: unknown[]): DesktopEntry[] {
  return entries.map((candidate) => {
    if (!isRecord(candidate)) return candidate as DesktopEntry;
    const { viewId: _viewId, ...entry } = candidate;
    void _viewId;
    return entry as DesktopEntry;
  });
}

function migratePositionedEntries(entries: unknown[], viewport: EntryPosition, createId: () => string) {
  const width = Math.max(1, viewport.x);
  const height = Math.max(1, viewport.y);
  const typed = entries as Array<Omit<DesktopEntry, "parentId"> & { parentId?: string | null }>;
  const roots = typed.filter((entry) => (entry.parentId ?? null) === null);
  const columns = Math.max(1, ...roots.map((entry) => Math.floor(entry.position.x / width) + 1));
  const rows = Math.max(1, ...roots.map((entry) => Math.floor(entry.position.y / height) + 1));
  const views = Array.from({ length: columns * rows }, () => ({ id: createId() }));
  const migrated = typed.map((entry) => {
    const parentId = entry.parentId ?? null;
    if (parentId !== null) return { ...entry, parentId, viewId: null };
    const column = Math.floor(entry.position.x / width);
    const row = Math.floor(entry.position.y / height);
    return { ...entry, parentId, viewId: views[row * columns + column].id, position: { x: entry.position.x % width, y: entry.position.y % height } };
  });
  return { entries: migrated, views };
}

export function decodeManifest(value: unknown, viewport: EntryPosition, createId: () => string): { manifest: PersistedManifestV10; migrated: boolean } {
  if (!isRecord(value) || !Number.isInteger(value.version)) throw new Error("The storage index has an unsupported format.");
  const version = value.version as number;
  if (version === 10) return { manifest: parseManifestV10(value), migrated: false };
  if (version < 1 || version > 9) throw new Error("The storage index has an unsupported format.");

  let entries: unknown[];
  let views: LegacyView[];
  if (version === 1 && Array.isArray(value.files)) {
    const migrated = migratePositionedEntries(value.files.map((entry) => ({ ...(entry as FileEntry), kind: "file", parentId: null })), viewport, createId);
    entries = migrated.entries;
    views = migrated.views;
  } else if (version === 2 && Array.isArray(value.entries)) {
    const migrated = migratePositionedEntries(value.entries, viewport, createId);
    entries = migrated.entries;
    views = migrated.views;
  } else {
    if (!Array.isArray(value.entries) || !Array.isArray(value.views)) throw new Error("The storage index has an unsupported format.");
    entries = value.entries;
    views = value.views as LegacyView[];
  }

  const editorSettings = version <= 3 ? DEFAULT_EDITOR_SETTINGS : version === 4 && isRecord(value.editorSettings)
    ? { ...value.editorSettings, autoSave: true }
    : value.editorSettings;
  const sync = version < 6 ? emptySyncState() : version < 9
    ? { ...(isRecord(value.sync) ? value.sync : {}), workspaceId: null }
    : value.sync;
  const plainEntries = stripViewIds(entries);
  return {
    manifest: parseManifestV10({
      version: 10,
      entries: plainEntries,
      rootOrder: legacyRootOrder(entries as DesktopEntry[], views),
      snapToGrid: version < 7 ? false : value.snapToGrid,
      wallpaper: version < 8 ? DEFAULT_WALLPAPER : value.wallpaper,
      editorSettings,
      sync,
    }),
    migrated: true,
  };
}

export function manifestLayout(manifest: PersistedManifestV10): DesktopLayout {
  return { rootOrder: manifest.rootOrder, snapToGrid: manifest.snapToGrid, wallpaper: manifest.wallpaper };
}
