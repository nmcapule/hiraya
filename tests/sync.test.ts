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
  const cached = new Map<string, File>();
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
      readCachedFile: async (_desktopId: string, workspaceId: string, id: string, contentRevision: number) => cached.get(`${workspaceId}:${id}:${contentRevision}`) ?? null,
      cacheRemoteFile: async (_desktopId: string, workspaceId: string, id: string, contentRevision: number, content: Blob) => {
        const entry = current.entries.find((candidate) => candidate.id === id && candidate.kind === "file");
        if (!entry || current.sync.workspaceId !== workspaceId || current.sync.contentRevisions[id] !== contentRevision) return null;
        const file = new File([content], entry.name, { type: entry.mimeType, lastModified: entry.modifiedAt });
        cached.set(`${workspaceId}:${id}:${contentRevision}`, file);
        return file;
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
  test("adopts a fresh local placeholder into the remote default catalog identity", async () => {
    let registry = { desktops: [{ id: "local-placeholder", name: "Desktop" }], activeDesktopId: "local-placeholder" as string | null };
    const ensured: string[] = [];
    const storage = {
      listDesktops: async () => registry,
      adoptFreshDesktop: async (desktopId: string, target: { id: string; name: string }) => {
        expect(desktopId).toBe("local-placeholder");
        registry = { desktops: [{ id: target.id, name: target.name }], activeDesktopId: target.id };
        return true;
      },
      ensureDesktop: async (desktop: { id: string }) => { ensured.push(desktop.id); return desktop; },
      readOutbox: async () => [],
    } as unknown as NonNullable<SyncEngineOptions["storage"]>;
    const fetchImpl = (async () => Response.json({
      revision: 9,
      defaultDesktopId: "server-default",
      desktops: [{ id: "server-default", name: "Desktop", revision: 3 }],
    })) as typeof fetch;
    const engine = new SyncEngine({ storage, fetch: fetchImpl });

    expect(await engine.listDesktops()).toEqual({
      desktops: [{ id: "server-default", name: "Desktop", revision: 3 }],
      activeDesktopId: "server-default",
      defaultDesktopId: "server-default",
    });
    expect(ensured).toEqual(["server-default"]);
  });

  test("does not expose a refused local placeholder without a pending create", async () => {
    const registry = { desktops: [{ id: "offline-work", name: "Offline work" }], activeDesktopId: "offline-work" };
    const storage = {
      listDesktops: async () => registry,
      adoptFreshDesktop: async () => false,
      ensureDesktop: async (desktop: { id: string }) => desktop,
      readOutbox: async () => [],
    } as unknown as NonNullable<SyncEngineOptions["storage"]>;
    const engine = new SyncEngine({ storage, fetch: (async () => Response.json({
      revision: 2,
      defaultDesktopId: "server-default",
      desktops: [{ id: "server-default", name: "Server", revision: 1 }],
    })) as typeof fetch });

    expect((await engine.listDesktops()).desktops).toEqual([{ id: "server-default", name: "Server", revision: 1 }]);
    expect(registry.desktops).toEqual([{ id: "offline-work", name: "Offline work" }]);
  });

  test("keeps an offline local desktop visible while its create is pending", async () => {
    const pendingDesktop = { id: "offline-work", name: "Offline work" };
    const registry = { desktops: [pendingDesktop], activeDesktopId: pendingDesktop.id };
    const storage = {
      listDesktops: async () => registry,
      adoptFreshDesktop: async () => false,
      ensureDesktop: async (desktop: { id: string }) => desktop,
      readOutbox: async () => [{
        operationId: "0000000000000001", sequence: 1, clientId: "client", workspaceId: null, desktopId: pendingDesktop.id,
        operation: { kind: "create-desktop", desktop: pendingDesktop }, status: "pending", error: null,
      }],
    } as unknown as NonNullable<SyncEngineOptions["storage"]>;
    const engine = new SyncEngine({ storage, fetch: (async () => Response.json({
      revision: 2,
      defaultDesktopId: "server-default",
      desktops: [{ id: "server-default", name: "Server", revision: 1 }],
    })) as typeof fetch });

    expect((await engine.listDesktops()).desktops).toEqual([
      { id: "server-default", name: "Server", revision: 1 },
      pendingDesktop,
    ]);
  });

  test("catalog retention prevents pruning desktops with pending edits, transfers, or blocked work", async () => {
    const localDesktops = [
      { id: "pending-edit", name: "Pending edit" },
      { id: "transfer-source", name: "Transfer source" },
      { id: "transfer-destination", name: "Transfer destination" },
      { id: "blocked-edit", name: "Blocked edit" },
      { id: "stale", name: "Stale" },
    ];
    const record = (desktopId: string, operation: OutboxRecord["operation"], status: OutboxRecord["status"]): OutboxRecord => ({
      operationId: `${desktopId}-${status}`, sequence: 1, clientId: "client", workspaceId: "workspace", desktopId, operation, status,
      error: status === "blocked" ? "conflict" : null,
    });
    const storage = {
      listDesktops: async () => ({ desktops: localDesktops, activeDesktopId: "pending-edit" }),
      ensureDesktop: async (desktop: { id: string }) => desktop,
      readOutbox: async () => [
        record("pending-edit", { kind: "layout", layout: { snapToGrid: true, wallpaper: "dusk" } }, "pending"),
        record("transfer-source", { kind: "transfer", entryIds: ["tree"], destinationDesktopId: "transfer-destination", parentId: null }, "pending"),
        record("blocked-edit", { kind: "editor-settings", settings: desktopSnapshot().editorSettings }, "blocked"),
      ],
    } as unknown as NonNullable<SyncEngineOptions["storage"]>;
    const engine = new SyncEngine({ storage, fetch: (async () => Response.json({
      revision: 4,
      defaultDesktopId: "server-default",
      desktops: [{ id: "server-default", name: "Server", revision: 4 }],
    })) as typeof fetch });

    const catalog = await engine.listDesktops();
    expect(catalog.desktops.map((desktop) => desktop.id)).toEqual([
      "server-default", "pending-edit", "transfer-source", "transfer-destination", "blocked-edit",
    ]);
    expect(catalog.desktops.some((desktop) => desktop.id === "stale")).toBe(false);
    expect(catalog.activeDesktopId).toBe("pending-edit");
  });

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

  test("awaitable stop drains queued storage work before resolving", async () => {
    let snapshot = desktopSnapshot();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const storage = {
      loadDesktop: async () => snapshot,
      createFolder: async () => {
        await pending;
        const folder = { kind: "folder" as const, id: "folder", name: "Folder", parentId: null, modifiedAt: 1, position: { x: 0, y: 0 } };
        snapshot = { ...snapshot, entries: [folder] };
        return folder;
      },
      readCurrentDesktop: async () => snapshot,
    } as unknown as NonNullable<SyncEngineOptions["storage"]>;
    const engine = new SyncEngine({ frontendOnly: true, storage });
    await engine.start("one", { x: 100, y: 100 });
    const mutation = engine.createFolder("Folder", null, { x: 0, y: 0 });
    let stopped = false;
    const stopping = engine.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await Promise.all([mutation, stopping]);
    expect(stopped).toBe(true);
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
  test("uses the desktop-scoped workspace, content, and positions contract", async () => {
    const snapshot = desktopSnapshot();
    const first = remoteWorkspace();
    const second = remoteWorkspace();
    second.revision = 2;
    second.entries[0].revision = 2;
    second.entries[0].position = { x: 40, y: 50 };
    let reads = 0;
    const requests: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = `${init?.method ?? "GET"} ${String(input)}`;
      requests.push(request);
      if (String(input) === "/api/desktops/desk-1") return Response.json(++reads === 1 ? first : second);
      if (String(input) === "/api/desktops/desk-1/files/file-1/content") return new Response("note", { headers: { "X-Hiraya-Revision": "1" } });
      if (String(input) === "/api/desktops/desk-1/positions") return Response.json({});
      throw new Error(`Unexpected request: ${request}`);
    }) as typeof fetch;
    const engine = new SyncEngine(remoteOptions(snapshot, fetchImpl));
    await engine.start("desk-1", { x: 100, y: 100 });
    await engine.readFile("file-1");
    await engine.updateDesktopPositions([{ entryId: "file-1", position: { x: 40, y: 50 } }]);

    expect(requests).toContain("GET /api/desktops/desk-1");
    expect(requests).toContain("GET /api/desktops/desk-1/files/file-1/content");
    expect(requests).toContain("PUT /api/desktops/desk-1/positions");
    engine.stop();
  });

  test("publishes metadata without content and hydrates one revision only once", async () => {
    const snapshot = desktopSnapshot();
    const workspace = remoteWorkspace();
    let contentRequests = 0;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input) === "/api/workspace") return Response.json(workspace);
      if (String(input) === "/api/files/file-1/content") {
        contentRequests += 1;
        await pending;
        return new Response("note", { headers: { "Content-Type": "text/plain", "X-Hiraya-Revision": "1" } });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    }) as typeof fetch;
    const engine = new SyncEngine(remoteOptions(snapshot, fetchImpl));

    const started = await engine.start({ x: 100, y: 100 });
    expect(started.desktop.entries).toHaveLength(1);
    expect(contentRequests).toBe(0);

    const first = engine.readFile("file-1");
    const concurrent = engine.readFile("file-1");
    await Promise.resolve();
    expect(contentRequests).toBe(1);
    release();
    expect(await (await first).text()).toBe("note");
    expect(await (await concurrent).text()).toBe("note");
    expect(await (await engine.readFile("file-1")).text()).toBe("note");
    expect(contentRequests).toBe(1);
    await engine.stop();
  });

  test("reports an offline cache miss without requesting content", async () => {
    const snapshot = desktopSnapshot();
    let requests = 0;
    const options = remoteOptions(snapshot, (async (input) => {
      requests += 1;
      if (String(input) === "/api/workspace") return Response.json(remoteWorkspace());
      throw new Error("offline");
    }) as typeof fetch);
    const engine = new SyncEngine(options);
    await engine.start({ x: 100, y: 100 });
    const beforeMiss = requests;
    (engine as unknown as { status: string }).status = "offline";

    await expect(engine.readFile("file-1")).rejects.toThrow("not available offline");
    expect(requests).toBe(beforeMiss);
    await engine.stop();
  });

  test("replays an atomic cross-desktop move through the global endpoint", async () => {
    const local = desktopSnapshot();
    const folder = { kind: "folder" as const, id: "tree", name: "Tree", parentId: null, modifiedAt: 1, position: { x: 0, y: 0 } };
    const remote = {
      schemaVersion: 5,
      workspaceId: "workspace-1",
      initialized: true as const,
      revision: 1,
      entries: [{ ...folder, revision: 1, contentRevision: 0 }],
      layout: local.layout,
      layoutRevision: 1,
      editorSettings: local.editorSettings,
      settingsRevision: 1,
      appearance: { selectedThemeId: "hiraya-dusk", selectionRevision: 1, customThemes: [] },
    };
    let current = local;
    let records: OutboxRecord[] = [];
    let moveBody: unknown;
    let workspaceReads = 0;
    const storage = {
      loadDesktop: async () => current,
      applyRemoteDesktop: async (next: DesktopSnapshot) => { current = next; return next; },
      bindOutboxWorkspace: async () => undefined,
      readOutbox: async () => records,
      enqueueTransfer: async () => {
        const operation = { kind: "transfer" as const, entryIds: ["tree"], destinationDesktopId: "destination", parentId: null };
        const record: OutboxRecord = { operationId: "0000000000000001", sequence: 1, clientId: "client", workspaceId: "workspace-1", desktopId: "source", operation, status: "pending", error: null };
        records = [record];
        current = { ...current, entries: [] };
        return { desktop: current, record };
      },
      acknowledgeMutation: async () => { records = []; },
      blockMutation: async () => undefined,
    } as unknown as NonNullable<SyncEngineOptions["storage"]>;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/desktops/source") {
        workspaceReads += 1;
        return Response.json(workspaceReads === 1 ? remote : { ...remote, revision: 2, entries: [] });
      }
      if (String(input) === "/api/desktop-moves") {
        moveBody = JSON.parse(String(init?.body));
        return Response.json({ revision: 2 });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    }) as typeof fetch;
    const engine = new SyncEngine({ storage, fetch: fetchImpl, eventSource: FakeEventSource as unknown as typeof EventSource });
    await engine.start("source", { x: 100, y: 100 });
    await engine.transferEntries("destination", ["tree"], null);

    expect(moveBody).toEqual({ sourceDesktopId: "source", destinationDesktopId: "destination", entryIds: ["tree"], parentId: null });
    expect(records).toEqual([]);
    engine.stop();
  });

  test("replays an offline source record while another desktop is active", async () => {
    const empty = desktopSnapshot();
    const folder = { kind: "folder" as const, id: "offline-folder", name: "Offline", parentId: null, createdAt: 10, modifiedAt: 1, position: { x: 0, y: 0 } };
    const operation = { kind: "create" as const, entries: [folder] };
    let records: OutboxRecord[] = [{ operationId: "0000000000000001", sequence: 1, clientId: "client", workspaceId: "workspace-1", desktopId: "source", operation, status: "pending", error: null }];
    const requests: string[] = [];
    const workspace = (revision: number, entries: unknown[] = []) => ({
      schemaVersion: 5, workspaceId: "workspace-1", initialized: true, revision, entries,
      layout: empty.layout, layoutRevision: revision, editorSettings: empty.editorSettings, settingsRevision: revision,
      appearance: { selectedThemeId: "hiraya-dusk", selectionRevision: revision, customThemes: [] },
    });
    const storage = {
      loadDesktop: async () => empty,
      applyRemoteDesktop: async (next: DesktopSnapshot) => next,
      readDesktopState: async () => empty,
      bindOutboxWorkspace: async () => undefined,
      readOutbox: async () => records,
      acknowledgeMutation: async () => { records = []; },
      blockMutation: async () => undefined,
    } as unknown as NonNullable<SyncEngineOptions["storage"]>;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = `${init?.method ?? "GET"} ${String(input)}`;
      requests.push(request);
      if (String(input) === "/api/desktops/active") return Response.json(workspace(1));
      if (String(input) === "/api/desktops/source" && !init?.method) return Response.json(workspace(2, [{ ...folder, revision: 2, contentRevision: 0 }]));
      if (String(input) === "/api/desktops/source/entries") {
        const body = init?.body as FormData;
        expect(JSON.parse(String(body.get("entry")))).not.toHaveProperty("createdAt");
        return Response.json({ revision: 2, entry: folder });
      }
      throw new Error(`Unexpected request: ${request}`);
    }) as typeof fetch;
    const engine = new SyncEngine({ storage, fetch: fetchImpl, eventSource: FakeEventSource as unknown as typeof EventSource });
    await engine.start("active", { x: 100, y: 100 });

    expect(requests).toContain("POST /api/desktops/source/entries");
    expect(requests).toContain("GET /api/desktops/source");
    expect(records).toEqual([]);
    engine.stop();
  });

  test("creates an offline active desktop before replaying its scoped file edits", async () => {
    const activeDesktopId = "offline-desktop";
    const file = { kind: "file" as const, id: "offline-file", name: "note.txt", parentId: null, modifiedAt: 2, position: { x: 0, y: 0 }, mimeType: "text/plain", size: 0 };
    const editedFile = { ...file, modifiedAt: 3, size: 4 };
    const base = desktopSnapshot();
    let current: DesktopSnapshot = { ...base, entries: [editedFile] };
    const desktop = { id: activeDesktopId, name: "Offline desktop" };
    let records: OutboxRecord[] = [
      { operationId: "0000000000000001", sequence: 1, clientId: "client", workspaceId: "workspace-1", desktopId: "source", operation: { kind: "create-desktop", desktop }, status: "pending", error: null },
      { operationId: "0000000000000002", sequence: 2, clientId: "client", workspaceId: null, desktopId: activeDesktopId, operation: { kind: "create", entries: [file] }, status: "pending", error: null },
      { operationId: "0000000000000003", sequence: 3, clientId: "client", workspaceId: null, desktopId: activeDesktopId, operation: { kind: "save-content", entry: editedFile }, status: "pending", error: null },
    ];
    let remoteExists = false;
    let remoteRevision = 1;
    let remoteEntries: typeof file[] = [];
    let remoteContent = "";
    const requests: string[] = [];
    const workspace = (entries: typeof file[] = []) => ({
      schemaVersion: 5, workspaceId: "workspace-1", initialized: true, revision: remoteRevision,
      entries: entries.map((entry) => ({ ...entry, revision: remoteRevision, contentRevision: remoteRevision })),
      layout: base.layout, layoutRevision: remoteRevision, editorSettings: base.editorSettings, settingsRevision: remoteRevision,
      appearance: { selectedThemeId: "hiraya-dusk", selectionRevision: remoteRevision, customThemes: [] },
    });
    const storage = {
      loadDesktop: async () => current,
      listDesktops: async () => ({ desktops: [{ id: "source", name: "Source" }, desktop], activeDesktopId }),
      ensureDesktop: async (value: { id: string }) => value,
      adoptFreshDesktop: async () => false,
      readOutbox: async () => records,
      readDesktopState: async () => base,
      bindOutboxWorkspace: async () => undefined,
      readPendingContent: async (operationId: string) => new Blob([operationId.endsWith("3") ? "edit" : ""], { type: "text/plain" }),
      applyRemoteDesktop: async (next: DesktopSnapshot, _contents: Map<string, Blob>, acknowledgedOperationId?: string, desktopId?: string) => {
        if (desktopId !== activeDesktopId) return next;
        let manifest = { version: 13 as const, entries: next.entries, snapToGrid: next.layout.snapToGrid, wallpaper: next.layout.wallpaper, editorSettings: next.editorSettings, appearance: next.appearance, sync: next.sync };
        for (const record of records) if (record.operationId !== acknowledgedOperationId && record.desktopId === activeDesktopId) manifest = applyOutboxOperation(manifest, record.operation);
        current = { entries: manifest.entries, layout: { snapToGrid: manifest.snapToGrid, wallpaper: manifest.wallpaper }, editorSettings: manifest.editorSettings, appearance: manifest.appearance, sync: manifest.sync };
        return current;
      },
      acknowledgeMutation: async (operationId: string) => { records = records.filter((record) => record.operationId !== operationId); },
      blockMutation: async (operationId: string, error: string) => { records = records.map((record) => record.operationId === operationId ? { ...record, status: "blocked", error } : record); },
    } as unknown as NonNullable<SyncEngineOptions["storage"]>;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push(`${method} ${url}`);
      if (url === "/api/desktops" && method === "GET") {
        return Response.json({ revision: remoteRevision, defaultDesktopId: "source", desktops: [
          { id: "source", name: "Source", revision: remoteRevision },
          ...(remoteExists ? [{ id: activeDesktopId, name: desktop.name, revision: remoteRevision }] : []),
        ] });
      }
      if (url === "/api/desktops" && method === "POST") {
        remoteExists = true;
        remoteRevision = 2;
        return Response.json(workspace());
      }
      if (url === `/api/desktops/${activeDesktopId}` && !remoteExists) return Response.json({ error: "desktop not found" }, { status: 404 });
      if (url === "/api/desktops/source") return Response.json(workspace());
      if (url === `/api/desktops/${activeDesktopId}`) return Response.json(workspace(remoteEntries));
      if (url === `/api/desktops/${activeDesktopId}/entries`) {
        remoteRevision = 3;
        remoteEntries = [file];
        return Response.json({ revision: remoteRevision, entry: file });
      }
      if (url === `/api/desktops/${activeDesktopId}/files/${file.id}/content` && method === "PUT") {
        remoteRevision = 4;
        remoteEntries = [editedFile];
        remoteContent = await new Response(init?.body).text();
        return Response.json({ revision: remoteRevision, entry: editedFile });
      }
      if (url === `/api/desktops/${activeDesktopId}/files/${file.id}/content`) return new Response(remoteContent, { headers: { "Content-Type": "text/plain" } });
      throw new Error(`Unexpected request: ${method} ${url}`);
    }) as typeof fetch;
    const engine = new SyncEngine({ storage, fetch: fetchImpl, eventSource: FakeEventSource as unknown as typeof EventSource });

    const result = await engine.start(activeDesktopId, { x: 100, y: 100 });
    const createIndex = requests.indexOf("POST /api/desktops");
    const entryIndex = requests.indexOf(`POST /api/desktops/${activeDesktopId}/entries`);
    const editIndex = requests.indexOf(`PUT /api/desktops/${activeDesktopId}/files/${file.id}/content`);
    expect(createIndex).toBeGreaterThan(-1);
    expect(entryIndex).toBeGreaterThan(createIndex);
    expect(editIndex).toBeGreaterThan(entryIndex);
    expect(records).toEqual([]);
    expect(result.desktop.entries).toContainEqual({ ...editedFile, createdAt: null });
    expect(result.desktop.sync.revision).toBe(4);
    engine.stop();
  });

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
    snapshot.entries = [{ kind: "folder", id: "local-folder", name: "Local", parentId: null, createdAt: 123, modifiedAt: 123, position: { x: 0, y: 0 } }];
    const requests: string[] = [];
    let bootstrapAppearance: unknown;
    let bootstrapEntries: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(`${init?.method ?? "GET"} ${String(input)}`);
      if (String(input) === "/api/workspace") {
        return Response.json({ schemaVersion: 5, workspaceId: "workspace-1", initialized: false, revision: 0 });
      }
      const workspaceInput = JSON.parse(String((init?.body as FormData).get("workspace"))) as { appearance: unknown; entries: Array<Record<string, unknown>> };
      bootstrapAppearance = workspaceInput.appearance;
      bootstrapEntries = workspaceInput.entries;
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
    expect(bootstrapEntries[0]).not.toHaveProperty("createdAt");
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
