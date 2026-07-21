import type { DesktopEntry } from "../types";
import { isValidId } from "./contracts";

export type DesktopRoute = {
  pageIndex: number;
  explorerFolderId?: string | null;
  fileId?: string;
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
  return index === parts.length ? next : null;
}

export function parseDesktopRoute(hash: string): DesktopRoute | null {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts.length < 2) return null;

  if (parts[0] === "workspaces" && /^\d+$/.test(parts[1])) {
    const pageIndex = Number(parts[1]);
    if (!Number.isSafeInteger(pageIndex)) return null;
    return parseSuffix(parts, { pageIndex }, 2);
  }

  // Legacy view links no longer map to persisted pages, but their targets remain useful.
  if (parts[0] === "views" && decodeId(parts[1])) return parseSuffix(parts, { pageIndex: 0 }, 2);
  return null;
}

export function formatDesktopRoute(route: DesktopRoute) {
  let hash = `#/workspaces/${route.pageIndex}`;
  if (route.explorerFolderId === null) hash += "/explorer/root";
  else if (route.explorerFolderId !== undefined) hash += `/explorer/folder/${encodeURIComponent(route.explorerFolderId)}`;
  if (route.fileId) hash += `/file/${encodeURIComponent(route.fileId)}`;
  return hash;
}

export function normalizeDesktopRoute(route: DesktopRoute | null, entries: DesktopEntry[], pageCount: number) {
  const normalizedPageCount = Number.isFinite(pageCount) ? Math.max(1, Math.trunc(pageCount)) : 1;
  const requestedPage = route && Number.isFinite(route.pageIndex) ? Math.trunc(route.pageIndex) : 0;
  const next: DesktopRoute = { pageIndex: Math.min(Math.max(requestedPage, 0), normalizedPageCount - 1) };
  if (route?.explorerFolderId === null) next.explorerFolderId = null;
  else if (route?.explorerFolderId !== undefined && entries.some((entry) => entry.id === route.explorerFolderId && entry.kind === "folder")) {
    next.explorerFolderId = route.explorerFolderId;
  }
  if (route?.fileId && entries.some((entry) => entry.id === route.fileId && entry.kind === "file")) next.fileId = route.fileId;
  return next;
}
