import { DEFAULT_WALLPAPER, type DesktopEntry, type DesktopIdentity, type DesktopLayout, type RootEntryPositionUpdate, type EditorSettings, type FileEntry, type Wallpaper } from "../types";
import { assertWallpaperSource, isValidId, parseDesktopIdentity, parseEditorSettings, parseEntries, parseLayout, parseLocalEntry, parseRootEntryPositions, parseRootEntryPositionUpdates } from "./contracts";
import type { PersistedDesktopState } from "./desktop-state";
import { DEFAULT_THEME_ID, parseCustomTheme, parseThemeState, type CustomTheme } from "./themes";

export type OutboxOperation = ({ schemaVersion: 1 } & (
  | { kind: "create-desktop"; desktop: DesktopIdentity }
  | { kind: "rename-desktop"; desktop: DesktopIdentity }
  | { kind: "delete-desktop"; desktopId: string }
  | { kind: "create"; entries: DesktopEntry[] }
  | { kind: "update-entry"; entry: DesktopEntry }
  | { kind: "delete"; entryId: string }
  | { kind: "delete-entries"; entryIds: string[] }
  | { kind: "move-entries"; entryIds: string[]; parentId: string | null }
  | { kind: "entry-transfer"; entryIds: string[]; destinationDesktopId: string; parentId: string | null }
  | { kind: "save-content"; entry: FileEntry }
  | { kind: "root-entry-positions"; positions: RootEntryPositionUpdate[] }
  | { kind: "layout"; layout: DesktopLayout }
  | { kind: "editor-settings"; settings: EditorSettings }
  | { kind: "select-theme"; themeId: string }
  | { kind: "upsert-theme"; theme: CustomTheme }
  | { kind: "delete-theme"; themeId: string }
));

export type OutboxRecord = {
  operationId: string;
  sequence: number;
  clientId: string;
  catalogId: string | null;
  desktopId: string;
  operation: OutboxOperation;
  status: "pending" | "blocked";
  error: string | null;
};

export function wallpaperAfterEntryRemoval(entries: readonly DesktopEntry[], wallpaper: Wallpaper) {
  return wallpaper.source.startsWith("file:") && !entries.some((entry) => entry.id === wallpaper.source.slice(5))
    ? { ...DEFAULT_WALLPAPER }
    : wallpaper;
}

function resetWallpaperAfterEntryRemoval(state: PersistedDesktopState, entries: DesktopEntry[]): PersistedDesktopState {
  const wallpaper = wallpaperAfterEntryRemoval(entries, state.wallpaper);
  return {
    ...state,
    entries,
    wallpaper,
    sync: wallpaper === state.wallpaper ? state.sync : { ...state.sync, layoutRevision: state.sync.catalogRevision },
  };
}

export function outboxDesktopRetentionIds(records: readonly OutboxRecord[], catalogId: string | null) {
  const retained = new Set<string>();
  for (const record of records) {
    if (record.catalogId !== catalogId) continue;
    retained.add(record.desktopId);
    if (record.operation.kind === "create-desktop" || record.operation.kind === "rename-desktop") retained.add(record.operation.desktop.id);
    if (record.operation.kind === "entry-transfer") retained.add(record.operation.destinationDesktopId);
  }
  return retained;
}

export function desktopPendingOperationProtection(records: readonly OutboxRecord[], desktopId: string) {
  const hasPendingOperation = records.some((record) => record.desktopId === desktopId
    || (record.operation.kind === "create-desktop" || record.operation.kind === "rename-desktop") && record.operation.desktop.id === desktopId
    || record.operation.kind === "delete-desktop" && record.operation.desktopId === desktopId
    || record.operation.kind === "entry-transfer" && record.operation.destinationDesktopId === desktopId);
  return hasPendingOperation ? "This desktop has pending or blocked changes. Reconnect or resolve them before deleting it." : "";
}

export function transferEntriesBetweenDesktopStates(
  source: PersistedDesktopState,
  destination: PersistedDesktopState,
  entryIds: string[],
  parentId: string | null,
  modifiedAt = Date.now(),
) {
  if (source.sync.catalogId !== destination.sync.catalogId) throw new Error("Desktops from different catalogs cannot transfer entries.");
  if (parentId !== null && !destination.entries.some((entry) => entry.id === parentId && entry.kind === "folder")) throw new Error("The destination folder no longer exists.");
  const roots = new Set(entryIds);
  if (!roots.size || roots.size !== entryIds.length || entryIds.some((id) => !source.entries.some((entry) => entry.id === id))) throw new Error("An entry no longer exists.");
  const included = new Set(roots);
  for (let changed = true; changed;) {
    changed = false;
    for (const entry of source.entries) if (entry.parentId && included.has(entry.parentId) && !included.has(entry.id)) {
      included.add(entry.id);
      changed = true;
    }
  }
  const moving = source.entries.filter((entry) => included.has(entry.id)).map((entry) => roots.has(entry.id) ? { ...entry, parentId, modifiedAt } : entry);
  const sourceEntryRevisions = { ...source.sync.entryRevisions };
  const sourceContentRevisions = { ...source.sync.contentRevisions };
  const destinationEntryRevisions = { ...destination.sync.entryRevisions };
  const destinationContentRevisions = { ...destination.sync.contentRevisions };
  for (const entry of moving) {
    destinationEntryRevisions[entry.id] = sourceEntryRevisions[entry.id] ?? 0;
    delete sourceEntryRevisions[entry.id];
    if (entry.kind === "file") {
      destinationContentRevisions[entry.id] = sourceContentRevisions[entry.id] ?? 0;
      delete sourceContentRevisions[entry.id];
    }
  }
  const catalogRevision = Math.max(source.sync.catalogRevision, destination.sync.catalogRevision);
  const nextSource = resetWallpaperAfterEntryRemoval(source, source.entries.filter((entry) => !included.has(entry.id)));
  return {
    source: {
      ...nextSource,
      sync: { ...nextSource.sync, catalogRevision, layoutRevision: nextSource.wallpaper === source.wallpaper ? nextSource.sync.layoutRevision : catalogRevision, entryRevisions: sourceEntryRevisions, contentRevisions: sourceContentRevisions },
    },
    destination: {
      ...destination,
      entries: [...destination.entries, ...moving],
      sync: { ...destination.sync, catalogRevision, entryRevisions: destinationEntryRevisions, contentRevisions: destinationContentRevisions },
    },
    movedEntries: moving,
  };
}

export function normalizeOutboxOperation(operation: OutboxOperation): OutboxOperation {
  if (operation.schemaVersion !== 1) throw new Error("The queued operation uses an unsupported schema version.");
  if (operation.kind === "create") {
    if (!Array.isArray(operation.entries)) throw new Error("The desktop entries have an unsupported format.");
    return { ...operation, entries: operation.entries.map(parseLocalEntry) };
  }
  if (operation.kind === "update-entry") return { ...operation, entry: parseLocalEntry(operation.entry) };
  if (operation.kind === "save-content") {
    const entry = parseLocalEntry(operation.entry);
    if (entry.kind !== "file") throw new Error("Saved content requires a file entry.");
    return { ...operation, entry };
  }
  switch (operation.kind) {
    case "create-desktop":
    case "rename-desktop":
      return { ...operation, desktop: parseDesktopIdentity(operation.desktop, true) };
    case "delete-desktop":
      if (!isValidId(operation.desktopId)) throw new Error("A queued desktop operation has an invalid desktop ID.");
      return operation;
    case "delete":
      if (!isValidId(operation.entryId)) throw new Error("A queued entry operation has an invalid entry ID.");
      return operation;
    case "delete-entries":
    case "move-entries":
      if (!Array.isArray(operation.entryIds) || operation.entryIds.length === 0 || new Set(operation.entryIds).size !== operation.entryIds.length || operation.entryIds.some((id) => !isValidId(id))) throw new Error("A queued entry operation has invalid entry IDs.");
      if (operation.kind === "move-entries" && operation.parentId !== null && !isValidId(operation.parentId)) throw new Error("A queued move has an invalid parent ID.");
      return operation;
    case "entry-transfer":
      if (!isValidId(operation.destinationDesktopId) || !Array.isArray(operation.entryIds) || operation.entryIds.length === 0 || new Set(operation.entryIds).size !== operation.entryIds.length || operation.entryIds.some((id) => !isValidId(id)) || operation.parentId !== null && !isValidId(operation.parentId)) throw new Error("A queued entry transfer has an unsupported format.");
      return operation;
    case "root-entry-positions":
      return { ...operation, positions: parseRootEntryPositions(operation.positions) };
    case "layout":
      return { ...operation, layout: parseLayout(operation.layout) };
    case "editor-settings":
      return { ...operation, settings: parseEditorSettings(operation.settings) };
    case "select-theme":
    case "delete-theme":
      if (!isValidId(operation.themeId)) throw new Error("A queued theme operation has an invalid theme ID.");
      return operation;
    case "upsert-theme":
      return { ...operation, theme: parseCustomTheme(operation.theme) };
    default:
      throw new Error("The queued operation has an unsupported kind.");
  }
}

export function applyOutboxOperation(state: PersistedDesktopState, operation: OutboxOperation): PersistedDesktopState {
  operation = normalizeOutboxOperation(operation);
  let entries = state.entries;
  switch (operation.kind) {
    case "create-desktop":
    case "rename-desktop":
    case "delete-desktop":
      return state;
    case "create":
      entries = parseEntries([...entries, ...operation.entries]) as DesktopEntry[];
      break;
    case "update-entry": {
      if (!entries.some((entry) => entry.id === operation.entry.id)) throw new Error("That entry no longer exists.");
      entries = parseEntries(entries.map((entry) => entry.id === operation.entry.id ? operation.entry : entry)) as DesktopEntry[];
      break;
    }
    case "delete": {
      if (!entries.some((entry) => entry.id === operation.entryId)) throw new Error("That entry no longer exists.");
      const removed = new Set([operation.entryId]);
      for (let changed = true; changed;) {
        changed = false;
        for (const entry of entries) if (entry.parentId && removed.has(entry.parentId) && !removed.has(entry.id)) {
          removed.add(entry.id);
          changed = true;
        }
      }
      entries = entries.filter((entry) => !removed.has(entry.id));
      break;
    }
    case "delete-entries": {
      if (operation.entryIds.some((id) => !entries.some((entry) => entry.id === id))) throw new Error("An entry no longer exists.");
      const removed = new Set(operation.entryIds);
      for (let changed = true; changed;) {
        changed = false;
        for (const entry of entries) if (entry.parentId && removed.has(entry.parentId) && !removed.has(entry.id)) {
          removed.add(entry.id);
          changed = true;
        }
      }
      entries = entries.filter((entry) => !removed.has(entry.id));
      break;
    }
    case "entry-transfer": {
      const removed = new Set(operation.entryIds);
      if (!removed.size || operation.entryIds.some((id) => !entries.some((entry) => entry.id === id))) throw new Error("An entry no longer exists.");
      for (let changed = true; changed;) {
        changed = false;
        for (const entry of entries) if (entry.parentId && removed.has(entry.parentId) && !removed.has(entry.id)) { removed.add(entry.id); changed = true; }
      }
      entries = entries.filter((entry) => !removed.has(entry.id));
      const entryRevisions = { ...state.sync.entryRevisions };
      const contentRevisions = { ...state.sync.contentRevisions };
      for (const id of removed) {
        delete entryRevisions[id];
        delete contentRevisions[id];
      }
      const projected = resetWallpaperAfterEntryRemoval(state, entries);
      return { ...projected, sync: { ...projected.sync, entryRevisions, contentRevisions } };
    }
    case "move-entries": {
      const moving = new Set(operation.entryIds);
      if (moving.size !== operation.entryIds.length || operation.entryIds.some((id) => !entries.some((entry) => entry.id === id))) throw new Error("An entry no longer exists.");
      entries = parseEntries(entries.map((entry) => moving.has(entry.id) ? { ...entry, parentId: operation.parentId, modifiedAt: Date.now() } : entry)) as DesktopEntry[];
      break;
    }
    case "save-content":
      if (!entries.some((entry) => entry.id === operation.entry.id && entry.kind === "file")) throw new Error("That file no longer exists.");
      entries = parseEntries(entries.map((entry) => entry.id === operation.entry.id ? operation.entry : entry)) as DesktopEntry[];
      break;
    case "root-entry-positions": {
      const positions = parseRootEntryPositionUpdates(operation.positions, entries);
      const byId = new Map(positions.map((item) => [item.entryId, item.position]));
      entries = entries.map((entry) => byId.has(entry.id) ? { ...entry, position: byId.get(entry.id)! } : entry);
      break;
    }
    case "layout": {
      const layout = parseLayout(operation.layout);
      assertWallpaperSource(entries, layout.wallpaper);
      return { ...state, snapToGrid: layout.snapToGrid, wallpaper: layout.wallpaper };
    }
    case "editor-settings":
      return { ...state, editorSettings: parseEditorSettings(operation.settings) };
    case "select-theme":
      return { ...state, appearance: parseThemeState({ ...state.appearance, selectedThemeId: operation.themeId }) };
    case "upsert-theme": {
      const theme = parseCustomTheme(operation.theme);
      const exists = state.appearance.customThemes.some((item) => item.id === theme.id);
      const customThemes = exists
        ? state.appearance.customThemes.map((item) => item.id === theme.id ? theme : item)
        : [...state.appearance.customThemes, theme];
      return { ...state, appearance: parseThemeState({ ...state.appearance, customThemes }) };
    }
    case "delete-theme": {
      if (!state.appearance.customThemes.some((theme) => theme.id === operation.themeId)) return state;
      const customThemes = state.appearance.customThemes.filter((theme) => theme.id !== operation.themeId);
      const selectedThemeId = state.appearance.selectedThemeId === operation.themeId ? DEFAULT_THEME_ID : state.appearance.selectedThemeId;
      return { ...state, appearance: parseThemeState({ selectedThemeId, customThemes }) };
    }
  }
  return resetWallpaperAfterEntryRemoval(state, entries);
}
