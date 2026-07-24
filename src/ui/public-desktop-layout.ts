import { clampWindowBounds, type WindowBounds, type WindowViewport } from "./window-manager";
import type { DesktopEntry } from "../types";

export function publicWindowBounds(viewport: WindowViewport): WindowBounds {
  const margin = viewport.width < 700 ? 12 : 28;
  return clampWindowBounds({
    x: Math.min(90, margin),
    y: Math.min(55, margin),
    width: Math.min(920, Math.max(0, viewport.width - margin * 2)),
    height: Math.min(680, Math.max(0, viewport.height - margin * 2)),
  }, viewport, { minWidth: 320, minHeight: 220 });
}

export function publicFolderBackTarget(entries: readonly DesktopEntry[], folderId: string | null) {
  if (!folderId) return undefined;
  return entries.find((entry) => entry.id === folderId && entry.kind === "folder")?.parentId;
}
