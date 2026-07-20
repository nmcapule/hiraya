import { describe, expect, test } from "bun:test";
import { SyncEngine, type SyncEngineOptions } from "../src/lib/sync";
import type { DesktopSnapshot } from "../src/lib/opfs";
import { desktopSnapshot } from "./fixtures";

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener() {}
  close() {}
}

function remoteOptions(snapshot: DesktopSnapshot, fetchImpl: typeof fetch) {
  return {
    fetch: fetchImpl,
    eventSource: FakeEventSource as unknown as typeof EventSource,
    setInterval: (() => 1) as unknown as typeof globalThis.setInterval,
    clearInterval: (() => undefined) as typeof globalThis.clearInterval,
    storage: {
      loadDesktop: async () => snapshot,
      readDesktopSnapshot: async () => ({ ...snapshot, contents: new Map() }),
      applyRemoteDesktop: async (next: DesktopSnapshot) => next,
    } as unknown as NonNullable<SyncEngineOptions["storage"]>,
  };
}

describe("SyncEngine local lifecycle", () => {
  test("start is idempotent, local mutations publish, and stop permits restart", async () => {
    let snapshot = desktopSnapshot();
    let loads = 0;
    const storage = {
      loadDesktop: async () => { loads += 1; return snapshot; },
      createFolder: async (name: string) => {
        const folder = { kind: "folder" as const, id: "folder-1", name, parentId: null, viewId: "view-1", modifiedAt: 1, position: { x: 0, y: 0 } };
        snapshot = { ...snapshot, entries: [folder] };
        return folder;
      },
      readCurrentDesktop: async () => snapshot,
    } as unknown as NonNullable<SyncEngineOptions["storage"]>;
    const engine = new SyncEngine({ frontendOnly: true, storage });
    const published: DesktopSnapshot[] = [];
    const statuses: string[] = [];
    engine.subscribe((next) => published.push(next), (next) => statuses.push(next));

    const first = engine.start({ x: 100, y: 100 });
    const second = engine.start({ x: 200, y: 200 });
    expect(first).toBe(second);
    await first;
    expect(loads).toBe(1);
    expect(statuses).toEqual(["connecting", "local"]);

    await engine.createFolder("Docs", null, { x: 0, y: 0 }, "view-1");
    expect(published).toHaveLength(1);
    expect(published[0].entries[0].name).toBe("Docs");

    engine.stop();
    await engine.start({ x: 100, y: 100 });
    expect(loads).toBe(2);
  });

  test("silent optimistic resource saves still update command state", async () => {
    let snapshot = desktopSnapshot();
    const storage = {
      loadDesktop: async () => snapshot,
      saveDesktopLayout: async (layout: DesktopSnapshot["layout"]) => { snapshot = { ...snapshot, layout }; },
      readCurrentDesktop: async () => snapshot,
      createFolder: async (_name: string, _parentId: string | null, _position: unknown, viewId: string | null) => ({
        kind: "folder" as const, id: "folder-1", name: "Docs", parentId: null, viewId, modifiedAt: 1, position: { x: 0, y: 0 },
      }),
    } as unknown as NonNullable<SyncEngineOptions["storage"]>;
    const engine = new SyncEngine({ frontendOnly: true, storage });
    await engine.start({ x: 100, y: 100 });
    const layout = { ...snapshot.layout, views: [...snapshot.layout.views, { id: "view-2" }] };

    await engine.saveDesktopLayout(layout);
    const folder = await engine.createFolder("Docs", null, { x: 0, y: 0 }, "view-2");
    expect(folder.viewId).toBe("view-2");
    engine.stop();
  });
});

describe("SyncEngine remote reconciliation", () => {
  test("bootstraps an uninitialized server", async () => {
    const snapshot = desktopSnapshot();
    const requests: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(`${init?.method ?? "GET"} ${String(input)}`);
      if (String(input) === "/api/workspace") {
        return Response.json({ schemaVersion: 1, workspaceId: "workspace-1", initialized: false, revision: 0 });
      }
      return Response.json({
        schemaVersion: 1,
        workspaceId: "workspace-1",
        initialized: true,
        revision: 1,
        entries: [],
        layout: snapshot.layout,
        layoutRevision: 1,
        editorSettings: snapshot.editorSettings,
        settingsRevision: 1,
      });
    }) as typeof fetch;
    const engine = new SyncEngine(remoteOptions(snapshot, fetchImpl));

    const result = await engine.start({ x: 100, y: 100 });
    expect(result.status).toBe("online");
    expect(result.desktop.sync.workspaceId).toBe("workspace-1");
    expect(requests).toEqual(["GET /api/workspace", "POST /api/bootstrap"]);
    engine.stop();
  });

  test("replaces a higher-revision cache when the workspace identity changes", async () => {
    const snapshot = desktopSnapshot();
    snapshot.sync = { ...snapshot.sync, workspaceId: "old-workspace", revision: 50 };
    const fetchImpl = (async () => Response.json({
      schemaVersion: 1,
      workspaceId: "new-workspace",
      initialized: true,
      revision: 1,
      entries: [],
      layout: snapshot.layout,
      layoutRevision: 1,
      editorSettings: snapshot.editorSettings,
      settingsRevision: 1,
    })) as typeof fetch;
    const engine = new SyncEngine(remoteOptions(snapshot, fetchImpl));

    const result = await engine.start({ x: 100, y: 100 });
    expect(result.desktop.sync.workspaceId).toBe("new-workspace");
    expect(result.desktop.sync.revision).toBe(1);
    engine.stop();
  });

  test("does not apply a server response that completes after stop", async () => {
    const snapshot = desktopSnapshot();
    let resolveFetch!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { resolveFetch = resolve; });
    let applications = 0;
    const options = remoteOptions(snapshot, (() => pending) as typeof fetch);
    options.storage = {
      ...options.storage,
      applyRemoteDesktop: async (next: DesktopSnapshot) => { applications += 1; return next; },
    } as NonNullable<SyncEngineOptions["storage"]>;
    const engine = new SyncEngine(options);
    const starting = engine.start({ x: 100, y: 100 });
    await Promise.resolve();
    engine.stop();
    resolveFetch(Response.json({ schemaVersion: 1, workspaceId: "workspace-1", initialized: false, revision: 0 }));

    await expect(starting).rejects.toMatchObject({ name: "AbortError" });
    expect(applications).toBe(0);
  });
});
