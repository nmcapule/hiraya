import type { DesktopEntry } from "../types";
import { isValidId } from "./contracts";
import { namesMatch } from "./entry-validation";

export type DesktopRoute = {
  desktopId?: string;
  column: number;
  row: number;
  explorerFolderId?: string | null;
  fileId?: string;
  settings?: true;
};

function decodeId(value: string) {
  try {
    const decoded = decodeURIComponent(value);
    return isValidId(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function parseSuffix(parts: string[], route: DesktopRoute, startIndex: number) {
  const next = { ...route };
  let index = startIndex;
  if (parts[index] === "explorer") {
    if (parts[index + 1] === "root") {
      next.explorerFolderId = null;
      index += 2;
    } else if (parts[index + 1] === "folder" && parts[index + 2]) {
      const folderId = decodeId(parts[index + 2]);
      if (!folderId) return null;
      next.explorerFolderId = folderId;
      index += 3;
    } else {
      return null;
    }
  }
  if (parts[index] === "file" && parts[index + 1]) {
    const fileId = decodeId(parts[index + 1]);
    if (!fileId) return null;
    next.fileId = fileId;
    index += 2;
  }
  if (parts[index] === "settings") {
    if (next.explorerFolderId !== undefined || next.fileId) return null;
    next.settings = true;
    index += 1;
  }
  return index === parts.length ? next : null;
}

export function parseDesktopRoute(hash: string): DesktopRoute | null {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts.length < 2) return null;

  if (parts[0] === "desktops" && decodeId(parts[1]) && parts[2] === "workspaces" && /^-?\d+$/.test(parts[3] ?? "") && /^-?\d+$/.test(parts[4] ?? "")) {
    const column = Number(parts[3]);
    const row = Number(parts[4]);
    if (!Number.isSafeInteger(column) || !Number.isSafeInteger(row)) return null;
    return parseSuffix(parts, { desktopId: decodeId(parts[1])!, column, row }, 5);
  }

  if (parts[0] === "workspaces" && /^-?\d+$/.test(parts[1]) && /^-?\d+$/.test(parts[2] ?? "")) {
    const column = Number(parts[1]);
    const row = Number(parts[2]);
    if (!Number.isSafeInteger(column) || !Number.isSafeInteger(row)) return null;
    return parseSuffix(parts, { column, row }, 3);
  }

  // Version 11 used a dense page index. Preserve old links at the closest
  // representable surface location without restoring persisted page identity.
  if (parts[0] === "workspaces" && /^\d+$/.test(parts[1])) {
    const column = Number(parts[1]);
    if (!Number.isSafeInteger(column)) return null;
    return parseSuffix(parts, { column, row: 0 }, 2);
  }

  // Legacy view links no longer map to persisted pages, but their targets remain useful.
  if (parts[0] === "views" && decodeId(parts[1])) return parseSuffix(parts, { column: 0, row: 0 }, 2);
  return null;
}

export function formatDesktopRoute(route: DesktopRoute) {
  let hash = route.desktopId
    ? `#/desktops/${encodeURIComponent(route.desktopId)}/workspaces/${route.column}/${route.row}`
    : `#/workspaces/${route.column}/${route.row}`;
  if (route.settings) return `${hash}/settings`;
  if (route.explorerFolderId === null) hash += "/explorer/root";
  else if (route.explorerFolderId !== undefined) hash += `/explorer/folder/${encodeURIComponent(route.explorerFolderId)}`;
  if (route.fileId) hash += `/file/${encodeURIComponent(route.fileId)}`;
  return hash;
}

export function normalizeDesktopRoute(route: DesktopRoute | null, entries: DesktopEntry[], desktopId?: string): DesktopRoute {
  const column = route && Number.isSafeInteger(route.column) ? route.column : 0;
  const row = route && Number.isSafeInteger(route.row) ? route.row : 0;
  const next: DesktopRoute = { ...(desktopId ? { desktopId } : route?.desktopId ? { desktopId: route.desktopId } : {}), column, row };
  if (route?.settings) return { ...next, settings: true };
  if (route?.explorerFolderId === null) next.explorerFolderId = null;
  else if (route?.explorerFolderId !== undefined && entries.some((entry) => entry.id === route.explorerFolderId && entry.kind === "folder")) {
    next.explorerFolderId = route.explorerFolderId;
  }
  if (route?.fileId && entries.some((entry) => entry.id === route.fileId && entry.kind === "file")) next.fileId = route.fileId;
  return next;
}

export function resolveOpenFilePath(entries: DesktopEntry[], path: string) {
  const segments = path.split("/");
  if (!path || segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("\\") || [...segment].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  }))) {
    throw new Error(`“${path}” is not a valid file path.`);
  }

  let parentId: string | null = null;
  let resolved: DesktopEntry | undefined;
  for (const [index, segment] of segments.entries()) {
    resolved = entries.find((entry) => entry.parentId === parentId && namesMatch(entry.name, segment));
    if (!resolved || index < segments.length - 1 && resolved.kind !== "folder") {
      throw new Error(`No file exists at “${path}”.`);
    }
    parentId = resolved.id;
  }
  if (resolved?.kind !== "file") throw new Error(`No file exists at “${path}”.`);
  return resolved;
}
