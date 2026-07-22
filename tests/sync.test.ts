import { describe, expect, test } from "bun:test";
import { SyncEngine, type SyncEngineOptions } from "../src/lib/sync";
import type { DesktopSnapshot } from "../src/lib/opfs";
import { desktopSnapshot, remoteWorkspace } from "./fixtures";
import { applyOutboxOperation, type OutboxRecord } from "../src/lib/outbox";
import { BUILTIN_THEMES } from "../src/lib/themes";

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener() {}
  close() {}
}

function remoteOptions(snapshot: DesktopSnapshot, fetchImpl: typeof fetch) {
  let current = snapshot;
  let sequence = 0;
  let outbox: OutboxRecord[] = [];
  return {
    fetch: fetchImpl,
    eventSource: FakeEventSource as unknown as typeof EventSource,
    setInterval: (() => 1) as unknown as typeof globalThis.setInterval,
    clearInterval: (() => undefined) as typeof globalThis.clearInterval,
    storage: {
      loadDesktop: async () => current,
      readDesktopSnapshot: async () => ({ ...current, contents: new Map() }),
      applyRemoteDesktop: async (next: DesktopSnapshot, _contents: Map<string, Blob>, acknowledgedOperationId?: string) => {
        let manifest = { version: 13 as const, entries: next.entries, snapToGrid: next.layout.snapToGrid, wallpaper: next.layout.wallpaper, editorSettings: next.editorSettings, appearance: next.appearance, sync: next.sync };
        for (const record of outbox) if (record.operationId !== acknowledgedOperationId) manifest = applyOutboxOperation(manifest, record.operation);
        current = { entries: manifest.entries, layout: { snapToGrid: manifest.snapToGrid, wallpaper: manifest.wallpaper }, editorSettings: manifest.editorSettings, appearance: manifest.appearance, sync: manifest.sync };
        return current;
      },
      enqueueMutation: async (operation: OutboxRecord["operation"]) => {
        sequence += 1;
        const record: OutboxRecord = { operationId: sequence.toString().padStart(16, "0"), sequence, clientId: "client-1", workspaceId: current.sync.workspaceId, operation, status: "pending", error: null };
        outbox.push(record);
        const manifest = applyOutboxOperation({ version: 13, entries: current.entries, snapToGrid: current.layout.snapToGrid, wallpaper: current.layout.wallpaper, editorSettings: current.editorSettings, appearance: current.appearance, sync: current.sync }, operation);
        current = { entries: manifest.entries, layout: { snapToGrid: manifest.snapToGrid, wallpaper: manifest.wallpaper }, editorSettings: manifest.editorSettings, appearance: manifest.appearance, sync: manifest.sync };
        return { desktop: current, record };
      },
      readOutbox: async () => outbox,
      bindOutboxWorkspace: async (workspaceId: string) => { outbox = outbox.map((record) => ({ ...record, workspaceId: record.workspaceId ?? workspaceId })); },
      acknowledgeMutation: async (operationId: string) => { outbox = outbox.filter((record) => record.operationId !== operationId); },
      blockMutation: async (operationId: string, error: string) => { outbox = outbox.map((record) => record.operationId === operationId ? { ...record, status: "blocked", error } : record); },
      readPendingContent: async () => new Blob(),
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
        const folder = { kind: "folder" as const, id: "folder-1", name, parentId: null, modifiedAt: 1, position: { x: 0, y: 0 } };
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

    await engine.createFolder("Docs", null, { x: 0, y: 0 });
    expect(published).toHaveLength(2);
    expect(published[1].entries[0].name).toBe("Docs");

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
      createFolder: async () => ({
        kind: "folder" as const, id: "folder-1", name: "Docs", parentId: null, modifiedAt: 1, position: { x: 0, y: 0 },
      }),
    } as unknown as NonNullable<SyncEngineOptions["storage"]>;
    const engine = new SyncEngine({ frontendOnly: true, storage });
    await engine.start({ x: 100, y: 100 });
    const layout = { ...snapshot.layout };

    await engine.saveDesktopLayout(layout);
    const folder = await engine.createFolder("Docs", null, { x: 0, y: 0 });
    expect(folder.id).toBe("folder-1");
    engine.stop();
  });

  test("updates all desktop positions through one local storage operation", async () => {
    let snapshot = desktopSnapshot();
    const entry = { kind: "folder" as const, id: "a", name: "A", parentId: null, modifiedAt: 1, position: { x: 0, y: 0 } };
    snapshot = { ...snapshot, entries: [entry] };
    let calls = 0;
    const storage = {
      loadDesktop: async () => snapshot,
      updateDesktopPositions: async (positions: Array<{ entryId: string; position: { x: number; y: number } }>) => {
        calls += 1;
        const moved = { ...entry, position: positions[0].position };
        snapshot = { ...snapshot, entries: [moved] };
        expect(positions[0].entryId).toBe("a");
        return [moved];
      },
      readCurrentDesktop: async () => snapshot,
    } as unknown as NonNullable<SyncEngineOptions["storage"]>;
    const engine = new SyncEngine({ frontendOnly: true, storage });
    await engine.start({ x: 100, y: 100 });
    const moved = await engine.updateDesktopPositions([{ entryId: "a", position: { x: -40, y: 60 } }]);

    expect(calls).toBe(1);
    expect(moved[0].position).toEqual({ x: -40, y: 60 });
    engine.stop();
  });

  test("lists local activity and notifies only after an accepted local mutation", async () => {
    let snapshot = desktopSnapshot();
    const page = { activities: [{ revision: 1, timestamp: 10, action: "create", source: "frontend", summary: "Created folder", details: ["Folder: Docs"] }], nextBefore: null };
    const storage = {
      loadDesktop: async () => snapshot,
      listActivity: async () => page,
      createFolder: async () => {
        const folder = { kind: "folder" as const, id: "folder-1", name: "Docs", parentId: null, modifiedAt: 1, position: { x: 0, y: 0 } };
        snapshot = { ...snapshot, entries: [folder] };
        return folder;
      },
      readCurrentDesktop: async () => snapshot,
    } as unknown as NonNullable<SyncEngineOptions["storage"]>;
    const engine = new SyncEngine({ frontendOnly: true, storage });
    let changes = 0;
    const unsubscribe = engine.subscribeActivityChanges(() => { changes += 1; });
    await engine.start({ x: 100, y: 100 });

    expect(await engine.listActivity({ q: "Docs", limit: 10 })).toEqual(page);
    expect(changes).toBe(0);
    await engine.createFolder("Docs", null, { x: 0, y: 0 });
    expect(changes).toBe(1);
    unsubscribe();
    engine.stop();
  });
});

describe("SyncEngine remote reconciliation", () => {
  test("fetches and validates server-owned activity without reading local history", async () => {
    const snapshot = desktopSnapshot();
    const options = remoteOptions(snapshot, (async (input) => {
      const url = String(input);
      if (url === "/api/workspace") return Response.json(remoteWorkspace());
      if (url === "/api/files/file-1/content") return new Response("note");
      if (url === "/api/activity?q=notes&before=9&limit=4") return Response.json({
        activities: [{ revision: 8, timestamp: 20, action: "content", source: "api", summary: "Edited file", details: ["File: notes.txt"] }],
        nextBefore: null,
      });
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch);
    options.storage = { ...options.storage, listActivity: async () => { throw new Error("local history must not be read"); } } as NonNullable<SyncEngineOptions["storage"]>;
    const engine = new SyncEngine(options);
    await engine.start({ x: 100, y: 100 });

    expect(await engine.listActivity({ q: "notes", before: 9, limit: 4 })).toEqual({
      activities: [{ revision: 8, timestamp: 20, action: "content", source: "api", summary: "Edited file", details: ["File: notes.txt"] }],
      nextBefore: null,
    });
    engine.stop();
  });

  test("publishes the cache while initial server reconciliation is pending", async () => {
    const snapshot = desktopSnapshot();
    let resolveFetch!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { resolveFetch = resolve; });
    const engine = new SyncEngine(remoteOptions(snapshot, (() => pending) as typeof fetch));
    const published: DesktopSnapshot[] = [];
    const statuses: string[] = [];
    let startSettled = false;
    engine.subscribe((next) => published.push(next), (next) => statuses.push(next));

    const starting = engine.start({ x: 100, y: 100 }).finally(() => { startSettled = true; });
    await new Promise<void>((resolve) => {
      const check = () => published.length > 0 ? resolve() : queueMicrotask(check);
      check();
    });

    expect(published).toEqual([snapshot]);
    expect(statuses).toEqual(["connecting"]);
    expect(startSettled).toBe(false);

    resolveFetch(Response.json({ schemaVersion: 5, workspaceId: "workspace-1", initialized: false, revision: 0 }));
    await starting;
    engine.stop();
  });

  test("stays connecting until the remote snapshot is fully applied", async () => {
    const snapshot = desktopSnapshot();
    let resolveApply!: (snapshot: DesktopSnapshot) => void;
    let applyStarted!: () => void;
    const applying = new Promise<void>((resolve) => { applyStarted = resolve; });
    const options = remoteOptions(snapshot, (async (input) => {
      if (String(input) === "/api/workspace") return Response.json(remoteWorkspace());
      return new Response("note", { headers: { "Content-Type": "text/plain" } });
    }) as typeof fetch);
    options.storage = {
      ...options.storage,
      applyRemoteDesktop: () => {
        applyStarted();
        return new Promise<DesktopSnapshot>((resolve) => { resolveApply = resolve; });
      },
    } as NonNullable<SyncEngineOptions["storage"]>;
    const engine = new SyncEngine(options);
    const statuses: string[] = [];
    engine.subscribe(() => undefined, (next) => statuses.push(next));

    const starting = engine.start({ x: 100, y: 100 });
    await applying;
    expect(statuses).toEqual(["connecting"]);

    const expected = desktopSnapshot();
    expected.sync = { ...expected.sync, workspaceId: "workspace-1", revision: 1 };
    resolveApply(expected);
    const result = await starting;
    expect(result.status).toBe("online");
    expect(statuses).toEqual(["connecting", "online"]);
    engine.stop();
  });

  test("keeps the cached desktop available when initial refresh fails", async () => {
    const snapshot = desktopSnapshot();
    const engine = new SyncEngine(remoteOptions(snapshot, (async () => { throw new Error("offline"); }) as typeof fetch));
    const published: DesktopSnapshot[] = [];
    engine.subscribe((next) => published.push(next), () => undefined);

    const result = await engine.start({ x: 100, y: 100 });

    expect(result.desktop).toBe(snapshot);
    expect(result.status).toBe("offline");
    expect(published).toEqual([snapshot]);
    engine.stop();
  });

  test("bootstraps an uninitialized server", async () => {
    const snapshot = desktopSnapshot();
    const requests: string[] = [];
    let bootstrapAppearance: unknown;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(`${init?.method ?? "GET"} ${String(input)}`);
      if (String(input) === "/api/workspace") {
        return Response.json({ schemaVersion: 5, workspaceId: "workspace-1", initialized: false, revision: 0 });
      }
      const workspaceInput = JSON.parse(String((init?.body as FormData).get("workspace"))) as { appearance: unknown };
      bootstrapAppearance = workspaceInput.appearance;
      return Response.json({
        schemaVersion: 5,
        workspaceId: "workspace-1",
        initialized: true,
        revision: 1,
        entries: [],
        layout: snapshot.layout,
        layoutRevision: 1,
        editorSettings: snapshot.editorSettings,
        settingsRevision: 1,
        appearance: { selectedThemeId: "hiraya-dusk", selectionRevision: 1, customThemes: [] },
      });
    }) as typeof fetch;
    const engine = new SyncEngine(remoteOptions(snapshot, fetchImpl));

    const result = await engine.start({ x: 100, y: 100 });
    expect(result.status).toBe("online");
    expect(result.desktop.sync.workspaceId).toBe("workspace-1");
    expect(requests).toEqual(["GET /api/workspace", "POST /api/bootstrap"]);
    expect(bootstrapAppearance).toEqual(snapshot.appearance);
    engine.stop();
  });

  test("persists custom theme operations through dedicated endpoints", async () => {
    const snapshot = desktopSnapshot();
    let server = remoteWorkspace();
    let workspaceReads = 0;
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/workspace") {
        workspaceReads += 1;
        return Response.json(server);
      }
      if (url === "/api/files/file-1/content") return new Response("note");
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ url, method: init?.method ?? "GET", body });
      server = structuredClone(server);
      server.revision += 1;
      if (url === "/api/themes/custom" && init?.method === "PUT") {
        server.appearance.customThemes = [{ ...body, revision: server.revision }];
      } else if (url === "/api/theme-selection") {
        server.appearance.selectedThemeId = (body as { themeId: string }).themeId;
        server.appearance.selectionRevision = server.revision;
      } else if (url === "/api/themes/custom" && init?.method === "DELETE") {
        server.appearance.customThemes = [];
        server.appearance.selectedThemeId = "hiraya-dusk";
        server.appearance.selectionRevision = server.revision;
      }
      return Response.json({});
    }) as typeof fetch;
    const engine = new SyncEngine(remoteOptions(snapshot, fetchImpl));
    await engine.start({ x: 100, y: 100 });
    const theme = { id: "custom", name: "Custom", definition: BUILTIN_THEMES["warm-paper"].definition };

    await engine.saveCustomTheme(theme);
    await engine.selectTheme(theme.id);
    const appearance = await engine.deleteCustomTheme(theme.id);

    expect(requests.map(({ url, method }) => `${method} ${url}`)).toEqual([
      "PUT /api/themes/custom",
      "PUT /api/theme-selection",
      "DELETE /api/themes/custom",
    ]);
    expect(requests[0].body).toEqual(theme);
    expect(requests[1].body).toEqual({ themeId: "custom" });
    expect(appearance).toEqual({ selectedThemeId: "hiraya-dusk", customThemes: [] });
    expect(workspaceReads).toBe(4);
    engine.stop();
  });

  test("replaces a higher-revision cache when the workspace identity changes", async () => {
    const snapshot = desktopSnapshot();
    snapshot.sync = { ...snapshot.sync, workspaceId: "old-workspace", revision: 50 };
    const fetchImpl = (async () => Response.json({
      schemaVersion: 5,
      workspaceId: "new-workspace",
      initialized: true,
      revision: 1,
      entries: [],
      layout: snapshot.layout,
      layoutRevision: 1,
      editorSettings: snapshot.editorSettings,
      settingsRevision: 1,
      appearance: { selectedThemeId: "hiraya-dusk", selectionRevision: 1, customThemes: [] },
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
    resolveFetch(Response.json({ schemaVersion: 5, workspaceId: "workspace-1", initialized: false, revision: 0 }));

    await expect(starting).rejects.toMatchObject({ name: "AbortError" });
    expect(applications).toBe(0);
  });

  test("uses the atomic desktop positions endpoint and reconciles its result", async () => {
    const snapshot = desktopSnapshot();
    const initial = remoteWorkspace();
    const next = remoteWorkspace();
    next.revision = 2;
    next.entries[0].revision = 2;
    next.entries[0].position = { x: -80, y: 90 };
    let workspaceReads = 0;
    let placementBody: unknown;
    let placementHeaders: Headers | undefined;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/workspace") {
        workspaceReads += 1;
        return Response.json(workspaceReads === 1 ? initial : next);
      }
      if (url === "/api/files/file-1/content") return new Response("note");
      if (url === "/api/desktop-positions") {
        placementBody = JSON.parse(String(init?.body));
        placementHeaders = new Headers(init?.headers);
        return Response.json({});
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    const engine = new SyncEngine(remoteOptions(snapshot, fetchImpl));
    await engine.start({ x: 100, y: 100 });

    const moved = await engine.updateDesktopPositions([{ entryId: "file-1", position: { x: -80, y: 90 } }]);

    expect(placementBody).toEqual([{ entryId: "file-1", position: { x: -80, y: 90 } }]);
    expect(placementHeaders?.get("X-Hiraya-Client-ID")).toBe("client-1");
    expect(placementHeaders?.get("X-Hiraya-Operation-ID")).toBe("0000000000000001");
    expect(moved[0].position).toEqual({ x: -80, y: 90 });
    expect(workspaceReads).toBe(2);
    engine.stop();
  });

  test("reports activity while remote work is queued", async () => {
    const snapshot = desktopSnapshot();
    const initial = remoteWorkspace();
    const next = remoteWorkspace();
    next.revision = 2;
    next.entries[0].revision = 2;
    next.entries[0].position = { x: 20, y: 30 };
    let workspaceReads = 0;
    let resolveMutation!: (response: Response) => void;
    let mutationStarted!: () => void;
    const started = new Promise<void>((resolve) => { mutationStarted = resolve; });
    const mutation = new Promise<Response>((resolve) => { resolveMutation = resolve; });
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/workspace") {
        workspaceReads += 1;
        return Response.json(workspaceReads === 1 ? initial : next);
      }
      if (url === "/api/files/file-1/content") return new Response("note");
      if (url === "/api/entries/file-1") {
        mutationStarted();
        return mutation;
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    const engine = new SyncEngine(remoteOptions(snapshot, fetchImpl));
    const activities: boolean[] = [];
    const statuses: string[] = [];
    engine.subscribe(() => undefined, (status) => statuses.push(status), (syncing) => activities.push(syncing));
    await engine.start({ x: 100, y: 100 });

    const moving = engine.updateEntryPosition("file-1", { x: 20, y: 30 });
    await started;
    expect(activities).toEqual([false, true]);
    expect(statuses.at(-1)).toBe("online");

    resolveMutation(Response.json({}));
    await moving;
    expect(activities).toEqual([false, true, false]);
    expect(statuses.at(-1)).toBe("online");
    engine.stop();
  });

  test("accepts and durably projects a mutation while offline", async () => {
    const snapshot = desktopSnapshot();
    const engine = new SyncEngine(remoteOptions(snapshot, (async () => { throw new Error("offline"); }) as typeof fetch));
    const published: DesktopSnapshot[] = [];
    engine.subscribe((next) => published.push(next), () => undefined);
    const started = await engine.start({ x: 100, y: 100 });

    const folder = await engine.createFolder("Offline", null, { x: 3, y: 4 });

    expect(started.status).toBe("offline");
    expect(folder.name).toBe("Offline");
    expect(published.at(-1)?.entries).toContainEqual(folder);
    expect(await engine.getOutboxStatus()).toMatchObject({ pending: 1, blocked: 0 });
    engine.stop();
  });

  test("blocks a permanent conflict without dropping the optimistic operation", async () => {
    const snapshot = desktopSnapshot();
    const initial = remoteWorkspace();
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/workspace") return Response.json(initial);
      if (url === "/api/files/file-1/content") return new Response("note");
      if (url === "/api/entries") return Response.json({ error: "That name is already in use." }, { status: 409 });
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    const engine = new SyncEngine(remoteOptions(snapshot, fetchImpl));
    await engine.start({ x: 100, y: 100 });

    await expect(engine.createFolder("Conflict", null, { x: 0, y: 0 })).rejects.toThrow("That name is already in use.");

    const status = await engine.getOutboxStatus();
    expect(status).toMatchObject({ pending: 0, blocked: 1 });
    expect(status.records[0].operation.kind).toBe("create");
    engine.stop();
  });
});
