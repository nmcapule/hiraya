import type { DesktopEntry } from "../types";
import { isValidId } from "./contracts";
import { clampWindowBounds, type WindowBounds, type WindowViewport } from "../ui/window-manager";

type WindowSessionBase = {
  bounds: WindowBounds;
  minimized: boolean;
  zIndex: number;
};

export type WindowSessionApp = WindowSessionBase & (
  | { kind: "file"; fileId: string }
  | { kind: "explorer"; folderId: string | null }
  | { kind: "settings" }
);

export type WindowSession = { version: 1; apps: WindowSessionApp[] };

export const EMPTY_WINDOW_SESSION: WindowSession = { version: 1, apps: [] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseBounds(value: unknown): WindowBounds {
  if (!isRecord(value) || ![value.x, value.y, value.width, value.height].every((part) => typeof part === "number" && Number.isFinite(part))) {
    throw new Error("The saved window session has invalid bounds.");
  }
  return { x: value.x as number, y: value.y as number, width: value.width as number, height: value.height as number };
}

export function parseWindowSession(value: unknown): WindowSession {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.apps) || value.apps.length > 100) {
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
    if (item.kind === "file" && isValidId(item.fileId)) {
      app = { ...base, kind: "file", fileId: item.fileId };
      id = `file:${item.fileId}`;
    } else if (item.kind === "explorer" && (item.folderId === null || isValidId(item.folderId))) {
      app = { ...base, kind: "explorer", folderId: item.folderId as string | null };
      id = `explorer:${item.folderId ?? "root"}`;
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
  return { version: 1, apps };
}

export function restoreWindowSession(session: WindowSession, entries: DesktopEntry[], viewport: WindowViewport) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return session.apps
    .filter((app) => app.kind === "settings" || app.kind === "explorer" && app.folderId === null || (app.kind === "file" ? byId.get(app.fileId)?.kind === "file" : byId.get(app.folderId!)?.kind === "folder"))
    .sort((left, right) => left.zIndex - right.zIndex)
    .map((app, index): WindowSessionApp => ({
      ...app,
      bounds: clampWindowBounds(app.bounds, viewport, app.kind === "file" ? { minWidth: 420, minHeight: 320 } : { minWidth: 360, minHeight: 280 }),
      zIndex: index + 1,
    }));
}
