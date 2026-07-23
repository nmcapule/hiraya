import type { DesktopEntry, DesktopLayout, EditorSettings, Wallpaper } from "../types";
import { assertWallpaperSource, isRecord, parseEditorSettings, parseEntries, parseLayout, readRevision } from "./contracts";
import { parseThemeState, type ThemeState } from "./themes";

export type DesktopSyncState = {
  catalogId: string | null;
  catalogRevision: number;
  entryRevisions: Record<string, number>;
  contentRevisions: Record<string, number>;
  layoutRevision: number;
  settingsRevision: number;
  themeSelectionRevision: number;
  themeRevisions: Record<string, number>;
};

export type PersistedDesktopState = {
  entries: DesktopEntry[];
  snapToGrid: boolean;
  wallpaper: Wallpaper;
  editorSettings: EditorSettings;
  appearance: ThemeState;
  sync: DesktopSyncState;
};

export const DEFAULT_EDITOR_SETTINGS: EditorSettings = { autoSave: true, autoFormat: false, fontSize: 13, language: "auto", lineWrap: true };

export function emptySyncState(): DesktopSyncState {
  return { catalogId: null, catalogRevision: 0, entryRevisions: {}, contentRevisions: {}, layoutRevision: 0, settingsRevision: 0, themeSelectionRevision: 0, themeRevisions: {} };
}

function parseRevisionMap(value: unknown) {
  if (!isRecord(value)) throw new Error("The desktop sync state has an unsupported format.");
  return Object.fromEntries(Object.entries(value).map(([id, revision]) => [id, readRevision(revision)]));
}

function parseSyncState(value: unknown): DesktopSyncState {
  if (!isRecord(value)) throw new Error("The desktop sync state has an unsupported format.");
  return {
    catalogId: value.catalogId === null ? null : (() => {
      if (typeof value.catalogId !== "string" || !value.catalogId) throw new Error("The desktop sync state has an unsupported format.");
      return value.catalogId;
    })(),
    catalogRevision: readRevision(value.catalogRevision),
    entryRevisions: parseRevisionMap(value.entryRevisions),
    contentRevisions: parseRevisionMap(value.contentRevisions),
    layoutRevision: readRevision(value.layoutRevision),
    settingsRevision: readRevision(value.settingsRevision),
    themeSelectionRevision: readRevision(value.themeSelectionRevision),
    themeRevisions: parseRevisionMap(value.themeRevisions),
  };
}

export function parseDesktopState(value: unknown): PersistedDesktopState {
  if (!isRecord(value)) throw new Error("The desktop state has an unsupported format.");
  const entries = parseEntries(value.entries);
  const layout = parseLayout(value, true);
  assertWallpaperSource(entries, layout.wallpaper);
  return {
    entries,
    snapToGrid: layout.snapToGrid,
    wallpaper: layout.wallpaper,
    editorSettings: parseEditorSettings(value.editorSettings),
    appearance: parseThemeState(value.appearance),
    sync: parseSyncState(value.sync),
  };
}

export function desktopStateLayout(state: PersistedDesktopState): DesktopLayout {
  return { snapToGrid: state.snapToGrid, wallpaper: state.wallpaper };
}
