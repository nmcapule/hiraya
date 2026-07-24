import type { DesktopEntry } from "../types";
import { clampWindowBounds, type WindowBounds, type WindowViewport } from "../ui/window-manager";
import { projectLogicalPosition, restoreLogicalPosition, type SurfaceSegment } from "../ui/desktop-geometry";
import { builtinAppEntryDependency, builtinAppTargetId, builtinAppWindow, extractBuiltinAppTarget } from "../apps/registry";
import type { BuiltinAppTarget } from "../apps/types";

type WindowSessionBase = {
  bounds: WindowBounds;
  minimized: boolean;
  zIndex: number;
};

export type WindowSessionApp = WindowSessionBase & BuiltinAppTarget;

export type WindowSession = { schemaVersion: 1; apps: WindowSessionApp[] };
export type BrowserHistoryState = { schemaVersion: 1; apps: WindowTarget[] };

export type WindowTarget = BuiltinAppTarget;

export const EMPTY_WINDOW_SESSION: WindowSession = { schemaVersion: 1, apps: [] };

export function createWindowSession(apps: readonly (WindowSessionBase & Record<string, unknown>)[]): WindowSession {
  return {
    schemaVersion: 1,
    apps: apps.flatMap((app): WindowSessionApp[] => {
      const target = extractBuiltinAppTarget(app);
      return target ? [{ bounds: app.bounds, minimized: app.minimized, zIndex: app.zIndex, ...target }] : [];
    }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function windowTargetId(target: WindowTarget) {
  return builtinAppTargetId(target);
}

export function parseWindowTargets(value: unknown): WindowTarget[] {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.apps) || value.apps.length > 100) throw new Error("The browser history has an unsupported format.");
  const ids = new Set<string>();
  return value.apps.map((item): WindowTarget => {
    if (!isRecord(item)) throw new Error("The route history contains an invalid app.");
    const target = extractBuiltinAppTarget(item);
    if (!target) throw new Error("The route history contains an invalid app.");
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
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.apps) || value.apps.length > 100) {
    throw new Error("The saved window session has an unsupported format.");
  }
  const ids = new Set<string>();
  const apps = value.apps.map((item): WindowSessionApp => {
    if (!isRecord(item) || typeof item.minimized !== "boolean" || !Number.isSafeInteger(item.zIndex) || (item.zIndex as number) < 0) {
      throw new Error("The saved window session has invalid app metadata.");
    }
    const base = { bounds: parseBounds(item.bounds), minimized: item.minimized, zIndex: item.zIndex as number };
    const target = extractBuiltinAppTarget(item);
    if (!target) throw new Error("The saved window session contains an invalid app.");
    const app: WindowSessionApp = { ...base, ...target };
    const id = builtinAppTargetId(target);
    if (ids.has(id)) throw new Error("The saved window session contains duplicate apps.");
    ids.add(id);
    return app;
  });
  return { schemaVersion: 1, apps };
}

export function restoreWindowSession(session: WindowSession, entries: DesktopEntry[], _activeSegment: SurfaceSegment, viewport: WindowViewport) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return session.apps
    .filter((app) => {
      const dependency = builtinAppEntryDependency(app);
      if (!dependency) return true;
      const entry = byId.get(dependency.entryId);
      return dependency.kind === "entry" ? Boolean(entry) : entry?.kind === dependency.kind;
    })
    .sort((left, right) => left.zIndex - right.zIndex)
    .map((app, index): WindowSessionApp => {
      const { minWidth, minHeight } = builtinAppWindow(app.kind);
      const projection = projectLogicalPosition(app.bounds, viewport);
      const localBounds = clampWindowBounds({ ...app.bounds, ...projection.local }, viewport, { minWidth, minHeight });
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
