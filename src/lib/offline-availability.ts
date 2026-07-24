import type { DesktopEntry, FileEntry } from "../types";
import type { PersistedDesktopState } from "./desktop-state";
import type { OutboxOperation, OutboxRecord } from "./outbox";

export type OfflineAvailabilityStatus = "cached" | "pinned" | "protected" | "partial" | "unavailable" | "updating" | "error";

export type OfflineFileInventory = {
  cached: boolean;
  cachedBytes: number;
  storedBytes: number;
  pending: boolean;
  protected: boolean;
};

export type OfflineStorageInventory = {
  desktopId: string;
  pinIds: string[];
  files: Record<string, OfflineFileInventory>;
  cachedBytes: number;
  protectedBytes: number;
  releasableBytes: number;
  browserStorage: { usage: number; quota: number } | null;
};

export type OfflineEntryAvailability = {
  status: OfflineAvailabilityStatus;
  cached: boolean;
  pinned: boolean;
  directlyPinned: boolean;
  protected: boolean;
  pending: boolean;
  fileCount: number;
  cachedFileCount: number;
  bytes: number;
  downloadBytes: number;
};

export type OfflineAvailabilityModel = {
  entries: Record<string, OfflineEntryAvailability>;
  pinnedFileIds: string[];
};

function entryMap(entries: readonly DesktopEntry[]) {
  return new Map(entries.map((entry) => [entry.id, entry]));
}

function operationReferenceIds(operation: OutboxOperation) {
  if (operation.kind === "create") return operation.entries.map((entry) => entry.id);
  if (operation.kind === "update-entry" || operation.kind === "save-content") return [operation.entry.id];
  if (operation.kind === "delete") return [operation.entryId];
  if (operation.kind === "delete-entries" || operation.kind === "move-entries" || operation.kind === "entry-transfer") return operation.entryIds;
  if (operation.kind === "root-entry-positions") return operation.positions.map((position) => position.entryId);
  if (operation.kind === "layout" && operation.layout.wallpaper.source.startsWith("file:")) return [operation.layout.wallpaper.source.slice(5)];
  return [];
}

export function outboxProtectedFileIds(records: readonly OutboxRecord[], states: readonly Pick<PersistedDesktopState, "entries">[]) {
  const protectedIds = new Set<string>();
  const referencedIds = new Set<string>();
  for (const record of records) {
    if (record.operation.kind === "save-content") protectedIds.add(record.operation.entry.id);
    if (record.operation.kind === "create") for (const entry of record.operation.entries) if (entry.kind === "file") protectedIds.add(entry.id);
    for (const id of operationReferenceIds(record.operation)) referencedIds.add(id);
  }
  for (const state of states) {
    const included = new Set(referencedIds);
    for (let changed = true; changed;) {
      changed = false;
      for (const entry of state.entries) if (entry.parentId && included.has(entry.parentId) && !included.has(entry.id)) { included.add(entry.id); changed = true; }
    }
    for (const entry of state.entries) if (entry.kind === "file" && included.has(entry.id)) protectedIds.add(entry.id);
  }
  return protectedIds;
}

export function dedupeOfflineRoots(entries: readonly DesktopEntry[], ids: readonly string[]) {
  const byId = entryMap(entries);
  const selected = new Set(ids);
  if (!selected.size || selected.size !== ids.length || ids.some((id) => !byId.has(id))) throw new Error("An offline selection contains an entry that no longer exists.");
  return ids.filter((id) => {
    let parentId = byId.get(id)!.parentId;
    while (parentId) {
      if (selected.has(parentId)) return false;
      parentId = byId.get(parentId)?.parentId ?? null;
    }
    return true;
  });
}

export function offlineFilesUnderRoots(entries: readonly DesktopEntry[], rootIds: readonly string[]) {
  const roots = new Set(dedupeOfflineRoots(entries, rootIds));
  const included = new Set(roots);
  for (let changed = true; changed;) {
    changed = false;
    for (const entry of entries) if (entry.parentId && included.has(entry.parentId) && !included.has(entry.id)) {
      included.add(entry.id);
      changed = true;
    }
  }
  return entries.filter((entry): entry is FileEntry => entry.kind === "file" && included.has(entry.id));
}

export function buildOfflineAvailability(
  entries: readonly DesktopEntry[],
  inventory: OfflineStorageInventory,
  activity: { updatingIds?: ReadonlySet<string>; errors?: ReadonlyMap<string, string> } = {},
): OfflineAvailabilityModel {
  const byId = entryMap(entries);
  const directPins = new Set(inventory.pinIds.filter((id) => byId.has(id)));
  const pinnedIds = new Set(directPins);
  for (let changed = true; changed;) {
    changed = false;
    for (const entry of entries) if (entry.parentId && pinnedIds.has(entry.parentId) && !pinnedIds.has(entry.id)) {
      pinnedIds.add(entry.id);
      changed = true;
    }
  }
  const pinnedFileIds = entries.filter((entry) => entry.kind === "file" && pinnedIds.has(entry.id)).map((entry) => entry.id);
  const children = new Map<string, DesktopEntry[]>();
  for (const entry of entries) if (entry.parentId) children.set(entry.parentId, [...children.get(entry.parentId) ?? [], entry]);
  const result: Record<string, OfflineEntryAvailability> = {};

  const visit = (entry: DesktopEntry): OfflineEntryAvailability => {
    if (entry.kind === "file") {
      const stored = inventory.files[entry.id] ?? { cached: false, cachedBytes: 0, storedBytes: 0, pending: false, protected: false };
      const pinned = pinnedIds.has(entry.id);
      const status: OfflineAvailabilityStatus = activity.errors?.has(entry.id) ? "error"
        : activity.updatingIds?.has(entry.id) ? "updating"
          : stored.protected ? "protected"
            : pinned ? "pinned"
              : stored.cached ? "cached" : "unavailable";
      return result[entry.id] = {
        status, cached: stored.cached, pinned, directlyPinned: directPins.has(entry.id), protected: stored.protected,
        pending: stored.pending, fileCount: 1, cachedFileCount: stored.cached ? 1 : 0, bytes: entry.size,
        downloadBytes: stored.cached || stored.protected ? 0 : entry.size,
      };
    }
    const descendants = (children.get(entry.id) ?? []).map(visit);
    const fileCount = descendants.reduce((total, child) => total + child.fileCount, 0);
    const cachedFileCount = descendants.reduce((total, child) => total + child.cachedFileCount, 0);
    const pinned = pinnedIds.has(entry.id);
    const protectedContent = descendants.some((child) => child.protected);
    const pending = descendants.some((child) => child.pending);
    const hasError = descendants.some((child) => child.status === "error");
    const updating = descendants.some((child) => child.status === "updating");
    const status: OfflineAvailabilityStatus = hasError ? "error" : updating ? "updating" : protectedContent ? "protected"
      : pinned ? "pinned" : cachedFileCount > 0 && cachedFileCount < fileCount ? "partial" : fileCount > 0 && cachedFileCount === fileCount ? "cached" : "unavailable";
    return result[entry.id] = {
      status, cached: fileCount > 0 && cachedFileCount === fileCount, pinned, directlyPinned: directPins.has(entry.id),
      protected: protectedContent, pending, fileCount, cachedFileCount,
      bytes: descendants.reduce((total, child) => total + child.bytes, 0),
      downloadBytes: descendants.reduce((total, child) => total + child.downloadBytes, 0),
    };
  };
  for (const entry of entries) if (entry.parentId === null) visit(entry);
  return { entries: result, pinnedFileIds };
}

export function offlineStatusLabel(value: OfflineEntryAvailability) {
  if (value.status === "updating") return "Updating offline copy";
  if (value.status === "error") return "Offline download failed";
  if (value.status === "protected") return value.pending ? "Protected pending content" : "Authoritative local content";
  if (value.status === "pinned") return value.cached ? "Pinned and available offline" : "Pinned, waiting to download";
  if (value.status === "partial") return `${value.cachedFileCount} of ${value.fileCount} files available offline`;
  if (value.status === "cached") return "Downloaded for offline use";
  return "Not available offline";
}
