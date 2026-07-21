import { DEFAULT_WALLPAPER, type DesktopEntry, type DesktopLayout, type EditorSettings, type FileEntry, type Wallpaper } from "../types";
import { isRecord, parseEditorSettings, parseEntries, parseLayout, readRevision } from "./contracts";

export type DesktopSyncState = {
  workspaceId: string | null;
  revision: number;
  entryRevisions: Record<string, number>;
  contentRevisions: Record<string, number>;
  layoutRevision: number;
  settingsRevision: number;
};

export type PersistedManifestV12 = {
  version: 12;
  entries: DesktopEntry[];
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

export function parseManifestV12(value: unknown): PersistedManifestV12 {
  if (!isRecord(value) || value.version !== 12) throw new Error("The storage index has an unsupported format.");
  const layout = parseLayout(value);
  return {
    version: 12,
    entries: parseEntries(value.entries),
    snapToGrid: layout.snapToGrid,
    wallpaper: layout.wallpaper,
    editorSettings: parseEditorSettings(value.editorSettings),
    sync: parseSyncState(value.sync),
  };
}

function stripLegacyFields(entries: unknown[]): unknown[] {
  return entries.map((candidate) => {
    if (!isRecord(candidate)) return candidate;
    const { viewId: _viewId, ...entry } = candidate;
    void _viewId;
    return entry;
  });
}

export function decodeManifest(value: unknown): { manifest: PersistedManifestV12; migrated: boolean } {
  if (!isRecord(value) || !Number.isInteger(value.version)) throw new Error("The storage index has an unsupported format.");
  const version = value.version as number;
  if (version === 12) return { manifest: parseManifestV12(value), migrated: false };
  if (version < 1 || version > 11) throw new Error("The storage index has an unsupported format.");

  let entries: unknown[];
  if (version === 1 && Array.isArray(value.files)) {
    entries = value.files.map((entry) => ({ ...(entry as FileEntry), kind: "file", parentId: null }));
  } else if (Array.isArray(value.entries)) {
    entries = value.entries.map((entry) => version === 2 && isRecord(entry) ? { ...entry, parentId: entry.parentId ?? null } : entry);
  } else {
    throw new Error("The storage index has an unsupported format.");
  }

  const editorSettings = version <= 3 ? DEFAULT_EDITOR_SETTINGS : version === 4 && isRecord(value.editorSettings)
    ? { ...value.editorSettings, autoSave: true }
    : value.editorSettings;
  const sync = version < 6 ? emptySyncState() : version < 9
    ? { ...(isRecord(value.sync) ? value.sync : {}), workspaceId: null }
    : value.sync;
  return {
    manifest: parseManifestV12({
      version: 12,
      entries: stripLegacyFields(entries),
      snapToGrid: version < 7 ? false : value.snapToGrid,
      wallpaper: version < 8 ? DEFAULT_WALLPAPER : value.wallpaper,
      editorSettings,
      sync,
    }),
    migrated: true,
  };
}

export function manifestLayout(manifest: PersistedManifestV12): DesktopLayout {
  return { snapToGrid: manifest.snapToGrid, wallpaper: manifest.wallpaper };
}
