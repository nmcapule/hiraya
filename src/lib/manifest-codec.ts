import { DEFAULT_WALLPAPER, type DesktopEntry, type DesktopLayout, type EditorSettings, type FileEntry, type Wallpaper } from "../types";
import { isRecord, parseEditorSettings, parseEntries, parseLayout, readRevision } from "./contracts";
import { DEFAULT_THEME_STATE, parseThemeState, type ThemeState } from "./themes";

export type DesktopSyncState = {
  workspaceId: string | null;
  revision: number;
  entryRevisions: Record<string, number>;
  contentRevisions: Record<string, number>;
  layoutRevision: number;
  settingsRevision: number;
  themeSelectionRevision: number;
  themeRevisions: Record<string, number>;
};

export type PersistedManifestV13 = {
  version: 13;
  entries: DesktopEntry[];
  snapToGrid: boolean;
  wallpaper: Wallpaper;
  editorSettings: EditorSettings;
  appearance: ThemeState;
  sync: DesktopSyncState;
};

export const DEFAULT_EDITOR_SETTINGS: EditorSettings = { autoSave: true, fontSize: 13, language: "auto" };

export function emptySyncState(): DesktopSyncState {
  return { workspaceId: null, revision: 0, entryRevisions: {}, contentRevisions: {}, layoutRevision: 0, settingsRevision: 0, themeSelectionRevision: 0, themeRevisions: {} };
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
    themeSelectionRevision: readRevision(value.themeSelectionRevision),
    themeRevisions: parseRevisionMap(value.themeRevisions),
  };
}

export function parseManifestV13(value: unknown): PersistedManifestV13 {
  if (!isRecord(value) || value.version !== 13) throw new Error("The storage index has an unsupported format.");
  const layout = parseLayout(value);
  return {
    version: 13,
    entries: parseEntries(value.entries),
    snapToGrid: layout.snapToGrid,
    wallpaper: layout.wallpaper,
    editorSettings: parseEditorSettings(value.editorSettings),
    appearance: parseThemeState(value.appearance),
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

export function decodeManifest(value: unknown): { manifest: PersistedManifestV13; migrated: boolean } {
  if (!isRecord(value) || !Number.isInteger(value.version)) throw new Error("The storage index has an unsupported format.");
  const version = value.version as number;
  if (version === 13) return { manifest: parseManifestV13(value), migrated: false };
  if (version < 1 || version > 12) throw new Error("The storage index has an unsupported format.");

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
    manifest: parseManifestV13({
      version: 13,
      entries: stripLegacyFields(entries),
      snapToGrid: version < 7 ? false : value.snapToGrid,
      wallpaper: version < 8 ? DEFAULT_WALLPAPER : value.wallpaper,
      editorSettings,
      appearance: DEFAULT_THEME_STATE,
      sync: { ...(isRecord(sync) ? sync : {}), themeSelectionRevision: 0, themeRevisions: {} },
    }),
    migrated: true,
  };
}

export function manifestLayout(manifest: PersistedManifestV13): DesktopLayout {
  return { snapToGrid: manifest.snapToGrid, wallpaper: manifest.wallpaper };
}
