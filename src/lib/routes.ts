import type { DesktopEntry, DesktopLayout } from "../types";

export type DesktopRoute = {
  viewId: string;
  explorerFolderId?: string | null;
  fileId?: string;
};

function decodeId(value: string) {
  try {
    const decoded = decodeURIComponent(value);
    return decoded ? decoded : null;
  } catch {
    return null;
  }
}

export function parseDesktopRoute(hash: string): DesktopRoute | null {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] !== "views" || parts.length < 2) return null;
  const viewId = decodeId(parts[1]);
  if (!viewId) return null;

  const route: DesktopRoute = { viewId };
  let index = 2;
  if (parts[index] === "explorer") {
    if (parts[index + 1] === "root") {
      route.explorerFolderId = null;
      index += 2;
    } else if (parts[index + 1] === "folder" && parts[index + 2]) {
      const folderId = decodeId(parts[index + 2]);
      if (!folderId) return null;
      route.explorerFolderId = folderId;
      index += 3;
    } else {
      return null;
    }
  }
  if (parts[index] === "file" && parts[index + 1]) {
    const fileId = decodeId(parts[index + 1]);
    if (!fileId) return null;
    route.fileId = fileId;
    index += 2;
  }
  return index === parts.length ? route : null;
}

export function formatDesktopRoute(route: DesktopRoute) {
  let hash = `#/views/${encodeURIComponent(route.viewId)}`;
  if (route.explorerFolderId === null) hash += "/explorer/root";
  else if (route.explorerFolderId !== undefined) hash += `/explorer/folder/${encodeURIComponent(route.explorerFolderId)}`;
  if (route.fileId) hash += `/file/${encodeURIComponent(route.fileId)}`;
  return hash;
}

export function normalizeDesktopRoute(route: DesktopRoute | null, entries: DesktopEntry[], layout: DesktopLayout) {
  const fallbackViewId = layout.views[0]?.id;
  if (!fallbackViewId) return null;
  const next: DesktopRoute = {
    viewId: route && layout.views.some((view) => view.id === route.viewId) ? route.viewId : fallbackViewId,
  };
  if (route?.explorerFolderId === null) next.explorerFolderId = null;
  else if (route?.explorerFolderId !== undefined && entries.some((entry) => entry.id === route.explorerFolderId && entry.kind === "folder")) {
    next.explorerFolderId = route.explorerFolderId;
  }
  if (route?.fileId && entries.some((entry) => entry.id === route.fileId && entry.kind === "file")) next.fileId = route.fileId;
  return next;
}
