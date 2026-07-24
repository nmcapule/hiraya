import type { DesktopEntry } from "../types";

export type FolderSortKey = "name" | "date" | "type" | "size";
export type SortDirection = "asc" | "desc";

const entryType = (entry: DesktopEntry) => entry.kind === "folder" ? "folder" : entry.mimeType || "file";

export function filterAndSortEntries(
  entries: readonly DesktopEntry[],
  query: string,
  sortKey: FolderSortKey,
  direction: SortDirection,
) {
  const needle = query.trim().toLocaleLowerCase();
  const filtered = needle ? entries.filter((entry) => entry.name.toLocaleLowerCase().includes(needle)) : entries;
  const factor = direction === "asc" ? 1 : -1;

  return [...filtered].sort((left, right) => {
    // Keep folders together while applying the requested direction within each kind.
    if (left.kind !== right.kind) return left.kind === "folder" ? -1 : 1;
    let compared = 0;
    if (sortKey === "name") compared = left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
    if (sortKey === "date") compared = left.modifiedAt - right.modifiedAt;
    if (sortKey === "type") compared = entryType(left).localeCompare(entryType(right), undefined, { sensitivity: "base" });
    if (sortKey === "size") compared = (left.kind === "file" ? left.size : 0) - (right.kind === "file" ? right.size : 0);
    return compared * factor || left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }) || left.id.localeCompare(right.id);
  });
}

export function formatEntrySize(entry: DesktopEntry) {
  if (entry.kind === "folder") return "";
  if (entry.size < 1024) return `${entry.size} ${entry.size === 1 ? "byte" : "bytes"}`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = entry.size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: value < 10 ? 1 : 0 }).format(value)} ${units[unit]}`;
}
