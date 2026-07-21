import type { DesktopEntry, FolderEntry } from "../types";

export type WorkspaceIndex = {
  byId: ReadonlyMap<string, DesktopEntry>;
  children: ReadonlyMap<string | null, readonly DesktopEntry[]>;
  folders: readonly FolderEntry[];
  roots: readonly DesktopEntry[];
  ancestors: (entryId: string) => FolderEntry[];
  descendants: (entryId: string) => DesktopEntry[];
};

export function createWorkspaceIndex(entries: readonly DesktopEntry[]): WorkspaceIndex {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const children = new Map<string | null, DesktopEntry[]>();
  const folders: FolderEntry[] = [];
  const roots: DesktopEntry[] = [];

  for (const entry of entries) {
    const siblings = children.get(entry.parentId) ?? [];
    siblings.push(entry);
    children.set(entry.parentId, siblings);
    if (entry.kind === "folder") folders.push(entry);
    if (entry.parentId !== null) continue;
    roots.push(entry);
  }

  function ancestors(entryId: string) {
    const result: FolderEntry[] = [];
    const visited = new Set<string>([entryId]);
    let parentId = byId.get(entryId)?.parentId ?? null;
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      const parent = byId.get(parentId);
      if (!parent || parent.kind !== "folder") break;
      result.unshift(parent);
      parentId = parent.parentId;
    }
    return result;
  }

  function descendants(entryId: string) {
    const result: DesktopEntry[] = [];
    const visited = new Set<string>([entryId]);
    const pending = [...(children.get(entryId) ?? [])];
    while (pending.length) {
      const entry = pending.shift()!;
      if (visited.has(entry.id)) continue;
      visited.add(entry.id);
      result.push(entry);
      pending.push(...(children.get(entry.id) ?? []));
    }
    return result;
  }

  return { byId, children, folders, roots, ancestors, descendants };
}
