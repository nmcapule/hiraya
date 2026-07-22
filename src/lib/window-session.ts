import type { DesktopEntry } from "../types";
import { isValidId } from "./contracts";
import { clampWindowBounds, type WindowBounds, type WindowViewport } from "../ui/window-manager";
import { projectLogicalPosition, restoreLogicalPosition, type SurfaceSegment } from "../ui/desktop-geometry";

type WindowSessionBase = {
  bounds: WindowBounds;
  minimized: boolean;
  zIndex: number;
};

export type WindowSessionApp = WindowSessionBase & (
  | { kind: "file"; fileId: string; editMode?: boolean }
  | { kind: "explorer"; folderId: string | null }
  | { kind: "properties"; entryId: string }
  | { kind: "settings" }
);

export type WindowSession = { version: 1 | 2 | 3 | 4; apps: WindowSessionApp[] };

export type WindowTarget =
  | { kind: "file"; fileId: string; editMode?: boolean }
  | { kind: "explorer"; folderId: string | null }
  | { kind: "properties"; entryId: string }
  | { kind: "settings" };

export const EMPTY_WINDOW_SESSION: WindowSession = { version: 4, apps: [] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function windowTargetId(target: WindowTarget) {
  if (target.kind === "file") return `file:${target.fileId}`;
  if (target.kind === "explorer") return `explorer:${target.folderId ?? "root"}`;
  if (target.kind === "properties") return `properties:${target.entryId}`;
  return "settings";
}

export function parseWindowTargets(value: unknown): WindowTarget[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error("The route history has an unsupported app list.");
  const ids = new Set<string>();
  return value.map((item): WindowTarget => {
    if (!isRecord(item)) throw new Error("The route history contains an invalid app.");
    let target: WindowTarget;
    if (item.kind === "file" && isValidId(item.fileId) && (item.editMode === undefined || typeof item.editMode === "boolean")) target = { kind: "file", fileId: item.fileId, ...(item.editMode ? { editMode: true } : {}) };
    else if (item.kind === "explorer" && (item.folderId === null || isValidId(item.folderId))) target = { kind: "explorer", folderId: item.folderId as string | null };
    else if (item.kind === "properties" && isValidId(item.entryId)) target = { kind: "properties", entryId: item.entryId };
    else if (item.kind === "settings") target = { kind: "settings" };
    else throw new Error("The route history contains an invalid app.");
    const id = windowTargetId(target);
    if (ids.has(id)) throw new Error("The route history contains duplicate apps.");
    ids.add(id);
    return target;
  });
}

function parseBounds(value: unknown): WindowBounds {
  if (!isRecord(value) || ![value.x, value.y, value.width, value.height].every((part) => typeof part === "number" && Number.isFinite(part))) {
    throw new Error("The saved window session has invalid bounds.");
  }
  return { x: value.x as number, y: value.y as number, width: value.width as number, height: value.height as number };
}

export function parseWindowSession(value: unknown): WindowSession {
  if (!isRecord(value) || value.version !== 1 && value.version !== 2 && value.version !== 3 && value.version !== 4 || !Array.isArray(value.apps) || value.apps.length > 100) {
    throw new Error("The saved window session has an unsupported format.");
  }
  const ids = new Set<string>();
  const apps = value.apps.map((item): WindowSessionApp => {
    if (!isRecord(item) || typeof item.minimized !== "boolean" || !Number.isSafeInteger(item.zIndex) || (item.zIndex as number) < 0) {
      throw new Error("The saved window session has invalid app metadata.");
    }
    const base = { bounds: parseBounds(item.bounds), minimized: item.minimized, zIndex: item.zIndex as number };
    let app: WindowSessionApp;
    let id: string;
    if (item.kind === "file" && isValidId(item.fileId) && (item.editMode === undefined || typeof item.editMode === "boolean")) {
      app = { ...base, kind: "file", fileId: item.fileId, ...(item.editMode ? { editMode: true } : {}) };
      id = `file:${item.fileId}`;
    } else if (item.kind === "explorer" && (item.folderId === null || isValidId(item.folderId))) {
      app = { ...base, kind: "explorer", folderId: item.folderId as string | null };
      id = `explorer:${item.folderId ?? "root"}`;
    } else if (item.kind === "properties" && isValidId(item.entryId)) {
      app = { ...base, kind: "properties", entryId: item.entryId };
      id = `properties:${item.entryId}`;
    } else if (item.kind === "settings") {
      app = { ...base, kind: "settings" };
      id = "settings";
    } else {
      throw new Error("The saved window session contains an invalid app.");
    }
    if (ids.has(id)) throw new Error("The saved window session contains duplicate apps.");
    ids.add(id);
    return app;
  });
  return { version: value.version, apps };
}

export function restoreWindowSession(session: WindowSession, entries: DesktopEntry[], activeSegment: SurfaceSegment, viewport: WindowViewport) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return session.apps
    .filter((app) => app.kind === "settings" || app.kind === "explorer" && app.folderId === null || app.kind === "properties" ? app.kind === "properties" && byId.has(app.entryId) : app.kind === "file" ? byId.get(app.fileId)?.kind === "file" : byId.get(app.folderId!)?.kind === "folder")
    .sort((left, right) => left.zIndex - right.zIndex)
    .map((app, index): WindowSessionApp => {
      const minimumSize = app.kind === "file" ? { minWidth: 420, minHeight: 320 } : { minWidth: 360, minHeight: 280 };
      const projection = session.version === 1
        ? { segment: activeSegment, local: { x: app.bounds.x, y: app.bounds.y } }
        : projectLogicalPosition(app.bounds, viewport);
      const localBounds = clampWindowBounds({ ...app.bounds, ...projection.local }, viewport, minimumSize);
      return {
        ...app,
        bounds: {
          ...localBounds,
          ...restoreLogicalPosition(localBounds, projection.segment, viewport),
        },
        zIndex: index + 1,
      };
    });
}
