import type { DesktopEntry, DesktopLayout, DesktopPositionUpdate, EditorSettings, FileEntry } from "../types";
import { parseEditorSettings, parseEntries, parseLayout, parseRootDesktopPositions } from "./contracts";
import type { PersistedManifestV12 } from "./manifest-codec";

export type OutboxOperation =
  | { kind: "create"; entries: DesktopEntry[] }
  | { kind: "update-entry"; entry: DesktopEntry }
  | { kind: "delete"; entryId: string }
  | { kind: "save-content"; entry: FileEntry }
  | { kind: "desktop-positions"; positions: DesktopPositionUpdate[] }
  | { kind: "layout"; layout: DesktopLayout }
  | { kind: "editor-settings"; settings: EditorSettings };

export type OutboxRecord = {
  operationId: string;
  sequence: number;
  clientId: string;
  workspaceId: string | null;
  operation: OutboxOperation;
  status: "pending" | "blocked";
  error: string | null;
};

export function applyOutboxOperation(manifest: PersistedManifestV12, operation: OutboxOperation): PersistedManifestV12 {
  let entries = manifest.entries;
  switch (operation.kind) {
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
  }
  return { ...manifest, entries };
}
