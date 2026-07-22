import type { DesktopEntry, DesktopIdentity, DesktopLayout, DesktopPositionUpdate, EditorSettings, FileEntry } from "../types";
import { parseEditorSettings, parseEntries, parseLayout, parseRootDesktopPositions } from "./contracts";
import type { PersistedManifestV13 } from "./manifest-codec";
import { DEFAULT_THEME_ID, parseCustomTheme, parseThemeState, type CustomTheme } from "./themes";

export type OutboxOperation =
  | { kind: "create-desktop"; desktop: DesktopIdentity }
  | { kind: "rename-desktop"; desktop: DesktopIdentity }
  | { kind: "delete-desktop"; desktopId: string }
  | { kind: "create"; entries: DesktopEntry[] }
  | { kind: "update-entry"; entry: DesktopEntry }
  | { kind: "delete"; entryId: string }
  | { kind: "batch-delete"; entryIds: string[] }
  | { kind: "batch-move"; entryIds: string[]; parentId: string | null }
  | { kind: "transfer"; entryIds: string[]; destinationDesktopId: string; parentId: string | null }
  | { kind: "save-content"; entry: FileEntry }
  | { kind: "desktop-positions"; positions: DesktopPositionUpdate[] }
  | { kind: "layout"; layout: DesktopLayout }
  | { kind: "editor-settings"; settings: EditorSettings }
  | { kind: "select-theme"; themeId: string }
  | { kind: "upsert-theme"; theme: CustomTheme }
  | { kind: "delete-theme"; themeId: string };

export type OutboxRecord = {
  operationId: string;
  sequence: number;
  clientId: string;
  workspaceId: string | null;
  desktopId?: string;
  operation: OutboxOperation;
  status: "pending" | "blocked";
  error: string | null;
};

export function outboxDesktopRetentionIds(records: readonly OutboxRecord[]) {
  const retained = new Set<string>();
  for (const record of records) {
    if (record.desktopId) retained.add(record.desktopId);
    if (record.operation.kind === "create-desktop" || record.operation.kind === "rename-desktop") retained.add(record.operation.desktop.id);
    if (record.operation.kind === "transfer") retained.add(record.operation.destinationDesktopId);
  }
  return retained;
}

export function normalizeOutboxOperation(operation: OutboxOperation): OutboxOperation {
  if (operation.kind === "create") return { ...operation, entries: parseEntries(operation.entries) as DesktopEntry[] };
  if (operation.kind === "update-entry") return { ...operation, entry: parseEntries([operation.entry])[0] as DesktopEntry };
  if (operation.kind === "save-content") {
    const entry = parseEntries([operation.entry])[0];
    if (entry.kind !== "file") throw new Error("Saved content requires a file entry.");
    return { ...operation, entry };
  }
  return operation;
}

export function applyOutboxOperation(manifest: PersistedManifestV13, operation: OutboxOperation): PersistedManifestV13 {
  let entries = manifest.entries;
  switch (operation.kind) {
    case "create-desktop":
    case "rename-desktop":
    case "delete-desktop":
      return manifest;
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
    case "batch-delete": {
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
    case "transfer": {
      const removed = new Set(operation.entryIds);
      if (!removed.size || operation.entryIds.some((id) => !entries.some((entry) => entry.id === id))) throw new Error("An entry no longer exists.");
      for (let changed = true; changed;) {
        changed = false;
        for (const entry of entries) if (entry.parentId && removed.has(entry.parentId) && !removed.has(entry.id)) { removed.add(entry.id); changed = true; }
      }
      entries = entries.filter((entry) => !removed.has(entry.id));
      break;
    }
    case "batch-move": {
      const moving = new Set(operation.entryIds);
      if (moving.size !== operation.entryIds.length || operation.entryIds.some((id) => !entries.some((entry) => entry.id === id))) throw new Error("An entry no longer exists.");
      entries = parseEntries(entries.map((entry) => moving.has(entry.id) ? { ...entry, parentId: operation.parentId, modifiedAt: Date.now() } : entry)) as DesktopEntry[];
      break;
    }
    case "save-content":
      if (!entries.some((entry) => entry.id === operation.entry.id && entry.kind === "file")) throw new Error("That file no longer exists.");
      entries = entries.map((entry) => entry.id === operation.entry.id ? operation.entry : entry);
      break;
    case "desktop-positions": {
      const positions = parseRootDesktopPositions(operation.positions, entries);
      const byId = new Map(positions.map((item) => [item.entryId, item.position]));
      entries = entries.map((entry) => byId.has(entry.id) ? { ...entry, position: byId.get(entry.id)! } : entry);
      break;
    }
    case "layout": {
      const layout = parseLayout(operation.layout);
      return { ...manifest, snapToGrid: layout.snapToGrid, wallpaper: layout.wallpaper };
    }
    case "editor-settings":
      return { ...manifest, editorSettings: parseEditorSettings(operation.settings) };
    case "select-theme":
      return { ...manifest, appearance: parseThemeState({ ...manifest.appearance, selectedThemeId: operation.themeId }) };
    case "upsert-theme": {
      const theme = parseCustomTheme(operation.theme);
      const exists = manifest.appearance.customThemes.some((item) => item.id === theme.id);
      const customThemes = exists
        ? manifest.appearance.customThemes.map((item) => item.id === theme.id ? theme : item)
        : [...manifest.appearance.customThemes, theme];
      return { ...manifest, appearance: parseThemeState({ ...manifest.appearance, customThemes }) };
    }
    case "delete-theme": {
      if (!manifest.appearance.customThemes.some((theme) => theme.id === operation.themeId)) return manifest;
      const customThemes = manifest.appearance.customThemes.filter((theme) => theme.id !== operation.themeId);
      const selectedThemeId = manifest.appearance.selectedThemeId === operation.themeId ? DEFAULT_THEME_ID : manifest.appearance.selectedThemeId;
      return { ...manifest, appearance: parseThemeState({ selectedThemeId, customThemes }) };
    }
  }
  return { ...manifest, entries };
}
