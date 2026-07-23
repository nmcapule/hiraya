import { describe, expect, test } from "bun:test";
import { SyncEngine, type SyncEngineOptions } from "../src/lib/sync";
import type { OutboxOperation, OutboxRecord } from "../src/lib/outbox";
import { applyOutboxOperation, transferEntriesBetweenDesktopStates } from "../src/lib/outbox";
import { desktopStateSnapshot, remoteDesktopState } from "./fixtures";

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener() {}
  close() {}
}

class CapturingEventSource extends FakeEventSource {
  static latest: CapturingEventSource | null = null;
  constructor(readonly url: string) {
    super();
    CapturingEventSource.latest = this;
  }
}

function remoteStorage() {
  let current = desktopStateSnapshot();
  let outbox: OutboxRecord[] = [];
  let sequence = 0;
  const cached = new Map<string, File>();
  const stats = { cacheWrites: 0, blockWrites: 0 };
  const storage = {
    loadDesktop: async () => current,
    readDesktopState: async () => current,
    applyRemoteDesktop: async (next: typeof current) => { current = next; return current; },
    bindOutboxCatalog: async () => undefined,
    readCachedFile: async (desktopId: string, catalogId: string, id: string, contentRevision: number) => cached.get(`${desktopId}:${catalogId}:${id}:${contentRevision}`) ?? null,
    cacheRemoteFile: async (desktopId: string, catalogId: string, id: string, contentRevision: number, content: Blob) => {
      const entry = current.entries.find((candidate) => candidate.id === id && candidate.kind === "file");
      if (!entry || current.sync.catalogId !== catalogId || current.sync.contentRevisions[id] !== contentRevision || content.size !== entry.size) return null;
      const file = new File([content], entry.name, { type: entry.mimeType, lastModified: entry.modifiedAt });
      cached.set(`${desktopId}:${catalogId}:${id}:${contentRevision}`, file);
      stats.cacheWrites += 1;
      return file;
    },
    readOutbox: async () => outbox,
    enqueueMutation: async (operation: OutboxOperation) => {
      const state = applyOutboxOperation({ entries: current.entries, snapToGrid: current.layout.snapToGrid, wallpaper: current.layout.wallpaper, editorSettings: current.editorSettings, appearance: current.appearance, sync: current.sync }, operation);
      current = { entries: state.entries, layout: { snapToGrid: state.snapToGrid, wallpaper: state.wallpaper }, editorSettings: state.editorSettings, appearance: state.appearance, sync: state.sync };
      const record: OutboxRecord = { operationId: String(++sequence), sequence, clientId: "client", catalogId: current.sync.catalogId!, desktopId: "desk", operation, status: "pending", error: null };
      outbox.push(record);
      return { desktop: current, record };
    },
    enqueueTransfer: async (_source: string, destinationDesktopId: string, entryIds: string[], parentId: string | null) => {
      const operation: OutboxOperation = { schemaVersion: 1, kind: "entry-transfer", destinationDesktopId, entryIds, parentId };
      const state = applyOutboxOperation({ entries: current.entries, snapToGrid: current.layout.snapToGrid, wallpaper: current.layout.wallpaper, editorSettings: current.editorSettings, appearance: current.appearance, sync: current.sync }, operation);
      current = { ...current, entries: state.entries };
      const record: OutboxRecord = { operationId: String(++sequence), sequence, clientId: "client", catalogId: current.sync.catalogId!, desktopId: "desk", operation, status: "pending", error: null };
      outbox.push(record);
      return { desktop: current, record };
    },
    acknowledgeMutation: async (operationId: string) => { outbox = outbox.filter((record) => record.operationId !== operationId); },
    blockMutation: async (operationId: string, error: string) => {
      stats.blockWrites += 1;
      outbox = outbox.map((record) => record.operationId === operationId ? { ...record, status: "blocked" as const, error } : record);
    },
  } as unknown as NonNullable<SyncEngineOptions["storage"]>;
  return Object.assign(storage, { stats });
}

describe("canonical synchronization", () => {
  test("converges a fresh browser on the server-created first desktop", async () => {
    const local: Array<{ id: string; name: string }> = [];
    const storage = {
      listDesktops: async () => ({ desktops: local, activeDesktopId: null }),
      ensureDesktop: async (desktop: { id: string; name: string }) => { if (!local.some(({ id }) => id === desktop.id)) local.push(desktop); return desktop; },
      bindOutboxCatalog: async () => undefined,
      readOutbox: async () => [],
    } as unknown as NonNullable<SyncEngineOptions["storage"]>;
    const engine = new SyncEngine({ storage, fetch: (async (input) => {
      expect(String(input)).toBe("/api/catalog");
      return Response.json({ schemaVersion: 1, catalogId: "catalog", catalogRevision: 1, desktops: [{ id: "desk", name: "Desktop" }] });
    }) as typeof fetch });

    expect(await engine.listDesktops()).toEqual({ schemaVersion: 1, catalogId: "catalog", catalogRevision: 1, activeDesktopId: "desk", desktops: [{ id: "desk", name: "Desktop" }] });
  });

  test("updates the catalog and falls back when the active desktop is deleted remotely", async () => {
    const local = [{ id: "one", name: "One" }, { id: "two", name: "Two" }];
    let catalogRead = 0;
    const storage = {
      listDesktops: async () => ({ desktops: local, activeDesktopId: "one" }),
      ensureDesktop: async (desktop: { id: string; name: string }) => desktop,
      bindOutboxCatalog: async () => undefined,
      readOutbox: async () => [],
    } as unknown as NonNullable<SyncEngineOptions["storage"]>;
    const engine = new SyncEngine({ storage, fetch: (async () => {
      catalogRead += 1;
      return Response.json({ schemaVersion: 1, catalogId: "catalog", catalogRevision: catalogRead, desktops: catalogRead === 1 ? local : [local[1]] });
    }) as typeof fetch });

    expect((await engine.listDesktops()).activeDesktopId).toBe("one");
    expect(await engine.refreshCatalog()).toMatchObject({ activeDesktopId: "two", desktops: [{ id: "two", name: "Two" }] });
  });

  function deletionStorage(initialRecords: OutboxRecord[]) {
    const records = [...initialRecords];
    const deleted: string[] = [];
    const current = { ...desktopStateSnapshot(), sync: { ...desktopStateSnapshot().sync, catalogId: "catalog", catalogRevision: 1 } };
    const storage = {
      loadDesktop: async () => current,
      readOutbox: async () => records,
      deleteDesktop: async (desktopId: string) => { deleted.push(desktopId); },
      enqueueMutation: async (operation: OutboxOperation) => {
        const record: OutboxRecord = { operationId: `operation-${records.length + 1}`, sequence: records.length + 1, clientId: "client", catalogId: "catalog", desktopId: "retained", operation, status: "pending", error: null };
        records.push(record);
        return { desktop: current, record };
      },
    } as unknown as NonNullable<SyncEngineOptions["storage"]>;
    return { storage, deleted, records: () => records };
  }

  test("blocks deletion of both sides of an offline entry transfer", async () => {
    const transfer: OutboxRecord = { operationId: "transfer", sequence: 1, clientId: "client", catalogId: "catalog", desktopId: "desktop-a", operation: { schemaVersion: 1, kind: "entry-transfer", entryIds: ["file"], destinationDesktopId: "desktop-b", parentId: null }, status: "pending", error: null };
    const harness = deletionStorage([transfer]);
    const engine = new SyncEngine({ storage: harness.storage, fetch: (async () => { throw new TypeError("offline"); }) as typeof fetch, eventSource: FakeEventSource as unknown as typeof EventSource });
    await engine.start("retained", { x: 0, y: 0 });
    await expect(engine.deleteDesktop("desktop-a")).rejects.toThrow("pending or blocked changes");
    await expect(engine.deleteDesktop("desktop-b")).rejects.toThrow("pending or blocked changes");
    expect(harness.deleted).toEqual([]);
    await engine.stop();
  });

  test("blocks deletion of a desktop with a pending edit", async () => {
    const edit: OutboxRecord = { operationId: "edit", sequence: 1, clientId: "client", catalogId: "catalog", desktopId: "desktop-a", operation: { schemaVersion: 1, kind: "layout", layout: { snapToGrid: true, wallpaper: "dusk" } }, status: "pending", error: null };
    const harness = deletionStorage([edit]);
    const engine = new SyncEngine({ storage: harness.storage, fetch: (async () => { throw new TypeError("offline"); }) as typeof fetch, eventSource: FakeEventSource as unknown as typeof EventSource });
    await engine.start("retained", { x: 0, y: 0 });
    await expect(engine.deleteDesktop("desktop-a")).rejects.toThrow("pending or blocked changes");
    expect(harness.deleted).toEqual([]);
    await engine.stop();
  });

  test("optimistically deletes a clean desktop and owns the delete on a retained desktop", async () => {
    const harness = deletionStorage([]);
    const engine = new SyncEngine({ storage: harness.storage, fetch: (async () => { throw new TypeError("offline"); }) as typeof fetch, eventSource: FakeEventSource as unknown as typeof EventSource });
    await engine.start("retained", { x: 0, y: 0 });
    await engine.deleteDesktop("clean");
    expect(harness.deleted).toEqual(["clean"]);
    expect(harness.records()).toEqual([expect.objectContaining({ desktopId: "retained", operation: { schemaVersion: 1, kind: "delete-desktop", desktopId: "clean" } })]);
    await engine.stop();
  });

  const staleCases: Array<{ name: string; desktopId: string; operation: OutboxOperation }> = [
    { name: "create-desktop", desktopId: "old-owner", operation: { schemaVersion: 1, kind: "create-desktop", desktop: { id: "old-created", name: "Old created" } } },
    { name: "delete-desktop", desktopId: "old-owner", operation: { schemaVersion: 1, kind: "delete-desktop", desktopId: "old-deleted" } },
    { name: "entry-transfer", desktopId: "old-source", operation: { schemaVersion: 1, kind: "entry-transfer", entryIds: ["old-entry"], destinationDesktopId: "old-destination", parentId: null } },
    { name: "nonactive desktop mutation", desktopId: "old-nonactive", operation: { schemaVersion: 1, kind: "layout", layout: { snapToGrid: true, wallpaper: "dusk" } } },
  ];

  for (const stale of staleCases) test(`blocks stale ${stale.name} before replay and catalog retention`, async () => {
    const remote = remoteDesktopState();
    remote.catalogId = "new-catalog";
    const local = [
      { id: "desk", name: "Desktop" },
      { id: stale.desktopId, name: "Old owner" },
      ...(stale.operation.kind === "create-desktop" ? [stale.operation.desktop] : []),
      ...(stale.operation.kind === "entry-transfer" ? [{ id: stale.operation.destinationDesktopId, name: "Old destination" }] : []),
    ];
    let records: OutboxRecord[] = [{ operationId: "stale-1", sequence: 1, clientId: "client", catalogId: "old-catalog", desktopId: stale.desktopId, operation: stale.operation, status: "pending", error: null }];
    const requests: string[] = [];
    const storage = {
      listDesktops: async () => ({ desktops: local, activeDesktopId: stale.desktopId }),
      ensureDesktop: async (desktop: { id: string; name: string }) => desktop,
      bindOutboxCatalog: async (catalogId: string) => { records = records.map((record) => record.catalogId !== null && record.catalogId !== catalogId ? { ...record, status: "blocked" as const, error: "Pending changes belong to a different catalog." } : { ...record, catalogId }); },
      readOutbox: async () => records,
      loadDesktop: async () => desktopStateSnapshot(),
      applyRemoteDesktop: async (next: ReturnType<typeof desktopStateSnapshot>) => next,
      blockMutation: async () => undefined,
    } as unknown as NonNullable<SyncEngineOptions["storage"]>;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = `${init?.method ?? "GET"} ${String(input)}`;
      requests.push(request);
      if (String(input) === "/api/catalog") return Response.json({ schemaVersion: 1, catalogId: "new-catalog", catalogRevision: 2, desktops: [{ id: "desk", name: "Desktop" }] });
      if (String(input) === "/api/desktops/desk") return Response.json(remote);
      throw new Error(`A stale operation was sent: ${request}`);
    }) as typeof fetch;
    const engine = new SyncEngine({ storage, fetch: fetchImpl, eventSource: FakeEventSource as unknown as typeof EventSource });

    const catalog = await engine.listDesktops();
    expect(catalog.desktops).toEqual([{ id: "desk", name: "Desktop" }]);
    expect(records[0]).toMatchObject({ status: "blocked", catalogId: "old-catalog" });
    const started = await engine.start("desk", { x: 0, y: 0 });
    expect(started.status).toBe("blocked");
    expect(requests.every((request) => request.startsWith("GET "))).toBe(true);
    await engine.stop();
  });

  test("creates a durable first-run offline desktop and replays its creation after reconnect", async () => {
    let online = false;
    let remoteExists = false;
    let local: Array<{ id: string; name: string }> = [];
    let activeDesktopId: string | null = null;
    let current = desktopStateSnapshot();
    let records: OutboxRecord[] = [];
    const requests: string[] = [];
    const storage = {
      listDesktops: async () => ({ desktops: local, activeDesktopId }),
      createOfflineDesktop: async (name: string) => {
        const desktop = { id: "offline-desk", name };
        local = [desktop];
        activeDesktopId = desktop.id;
        const operation: OutboxOperation = { schemaVersion: 1, kind: "create-desktop", desktop };
        const record: OutboxRecord = { operationId: "offline-create", sequence: 1, clientId: "client", catalogId: null, desktopId: desktop.id, operation, status: "pending", error: null };
        records = [record];
        return { desktop, record };
      },
      ensureDesktop: async (desktop: { id: string; name: string }) => { if (!local.some(({ id }) => id === desktop.id)) local.push(desktop); return desktop; },
      bindOutboxCatalog: async (catalogId: string) => { records = records.map((record) => record.catalogId === null ? { ...record, catalogId } : record); },
      readOutbox: async () => records,
      loadDesktop: async () => current,
      applyRemoteDesktop: async (next: typeof current) => { current = next; return current; },
      acknowledgeMutation: async (operationId: string) => { records = records.filter((record) => record.operationId !== operationId); },
      blockMutation: async () => undefined,
    } as unknown as NonNullable<SyncEngineOptions["storage"]>;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = `${init?.method ?? "GET"} ${String(input)}`;
      requests.push(request);
      if (!online) throw new TypeError("offline");
      if (String(input) === "/api/catalog") return Response.json({ schemaVersion: 1, catalogId: "catalog", catalogRevision: 1, desktops: [{ id: "server-desk", name: "Desktop" }] });
      if (String(input) === "/api/desktops/offline-desk" && !remoteExists) return Response.json({ error: "desktop not found" }, { status: 404 });
      if (String(input) === "/api/desktops" && init?.method === "POST") { remoteExists = true; return Response.json({ ...remoteDesktopState(), catalogId: "catalog", id: "offline-desk", name: "Offline desktop" }, { status: 201 }); }
      if (String(input) === "/api/desktops/offline-desk") return Response.json({ ...remoteDesktopState(), catalogId: "catalog", id: "offline-desk", name: "Offline desktop", catalogRevision: 2 });
      throw new Error(`Unexpected request: ${request}`);
    }) as typeof fetch;
    const engine = new SyncEngine({ storage, fetch: fetchImpl, eventSource: FakeEventSource as unknown as typeof EventSource });

    const offline = await engine.listDesktops();
    expect(offline).toMatchObject({ activeDesktopId: "offline-desk", catalogId: null, desktops: [{ id: "offline-desk", name: "Offline desktop" }] });
    expect(records[0]).toMatchObject({ catalogId: null, operation: { kind: "create-desktop" } });

    online = true;
    const reconnected = await engine.listDesktops();
    expect(reconnected.desktops.map(({ id }) => id)).toEqual(["server-desk", "offline-desk"]);
    expect(records[0].catalogId).toBe("catalog");
    const started = await engine.start("offline-desk", { x: 0, y: 0 });
    expect(started.status).toBe("online");
    expect(remoteExists).toBe(true);
    expect(records).toEqual([]);
    expect(requests).toContain("POST /api/desktops");
    await engine.stop();
  });

  test("uses scoped desktop, content, and root-entry-position APIs", async () => {
    const remote = remoteDesktopState();
    const requests: string[] = [];
    let reads = 0;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(`${init?.method ?? "GET"} ${String(input)}`);
      if (String(input) === "/api/desktops/desk") return Response.json({ ...remote, catalogRevision: ++reads });
      if (String(input) === "/api/desktops/desk/entries/file-1/content") return new Response("note", { headers: { "X-Hiraya-Revision": "1" } });
      if (String(input) === "/api/desktops/desk/root-entry-positions") return Response.json({});
      throw new Error(`Unexpected request: ${String(input)}`);
    }) as typeof fetch;
    const engine = new SyncEngine({ storage: remoteStorage(), fetch: fetchImpl, eventSource: FakeEventSource as unknown as typeof EventSource, setInterval: (() => 1) as never, clearInterval: (() => undefined) as never });
    await engine.start("desk", { x: 100, y: 100 });
    await engine.updateRootEntryPositions([{ entryId: "file-1", position: { x: 20, y: 30 } }]);
    expect(requests).toContain("GET /api/desktops/desk");
    expect(requests).toContain("PUT /api/desktops/desk/root-entry-positions");
    await engine.stop();
  });

  test("pauses replay on 401 without blocking its outbox record", async () => {
    const remote = remoteDesktopState();
    const storage = remoteStorage();
    let unauthorized = 0;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/desktops/desk" && !init?.method) return Response.json(remote);
      if (String(input) === "/api/desktops/desk/root-entry-positions") return new Response(null, { status: 401 });
      throw new Error(`Unexpected request: ${String(input)}`);
    }) as typeof fetch;
    const engine = new SyncEngine({ storage, fetch: fetchImpl, eventSource: FakeEventSource as unknown as typeof EventSource, onUnauthorized: () => { unauthorized += 1; } });
    await engine.start("desk", { x: 0, y: 0 });
    await expect(engine.updateRootEntryPositions([{ entryId: "file-1", position: { x: 5, y: 6 } }])).rejects.toThrow("session has expired");
    expect(await engine.getOutboxStatus()).toMatchObject({ pending: 1, blocked: 0 });
    expect(storage.stats.blockWrites).toBe(0);
    expect(unauthorized).toBe(1);
    await engine.stop();
  });

  test("probes authenticated sync health after an EventSource error", async () => {
    const requests: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      requests.push(String(input));
      if (String(input) === "/api/desktops/desk") return Response.json(remoteDesktopState());
      if (String(input) === "/api/sync/health") return Response.json({ catalogId: "catalog", catalogRevision: 1 });
      throw new Error(`Unexpected request: ${String(input)}`);
    }) as typeof fetch;
    const engine = new SyncEngine({ storage: remoteStorage(), fetch: fetchImpl, eventSource: CapturingEventSource as unknown as typeof EventSource, setInterval: (() => 1) as never, clearInterval: (() => undefined) as never });
    await engine.start("desk", { x: 0, y: 0 });
    CapturingEventSource.latest?.onerror?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requests).toContain("/api/sync/health");
    await engine.stop();
  });

  test("reconciles metadata without blobs and caches one validated content revision", async () => {
    const remote = remoteDesktopState();
    const storage = remoteStorage();
    let contentRequests = 0;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input) === "/api/desktops/desk") return Response.json(remote);
      if (String(input) === "/api/desktops/desk/entries/file-1/content") {
        contentRequests += 1;
        return new Response("note", { headers: { "X-Hiraya-Revision": "1" } });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    }) as typeof fetch;
    const engine = new SyncEngine({ storage, fetch: fetchImpl, eventSource: FakeEventSource as unknown as typeof EventSource });
    const started = await engine.start("desk", { x: 0, y: 0 });
    expect(started.desktop.entries).toHaveLength(1);
    expect(contentRequests).toBe(0);
    expect(await (await engine.readFile("file-1")).text()).toBe("note");
    expect(await (await engine.readFile("file-1")).text()).toBe("note");
    expect(contentRequests).toBe(1);
    expect(storage.stats.cacheWrites).toBe(1);
    await engine.stop();
  });

  test("does not cache content returned for a different revision", async () => {
    const storage = remoteStorage();
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input) === "/api/desktops/desk") return Response.json(remoteDesktopState());
      if (String(input) === "/api/desktops/desk/entries/file-1/content") return new Response("note", { headers: { "X-Hiraya-Revision": "2" } });
      throw new Error(`Unexpected request: ${String(input)}`);
    }) as typeof fetch;
    const engine = new SyncEngine({ storage, fetch: fetchImpl, eventSource: FakeEventSource as unknown as typeof EventSource });
    await engine.start("desk", { x: 0, y: 0 });
    await expect(engine.readFile("file-1")).rejects.toThrow("changed while it was loading");
    expect(storage.stats.cacheWrites).toBe(0);
    await engine.stop();
  });

  test("uses the global entry-transfer endpoint", async () => {
    const remote = remoteDesktopState();
    const storage = remoteStorage();
    let body: unknown;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/desktops/desk") return Response.json(remote);
      if (String(input) === "/api/entry-transfers") { body = JSON.parse(String(init?.body)); return Response.json({}); }
      throw new Error(`Unexpected request: ${String(input)}`);
    }) as typeof fetch;
    const engine = new SyncEngine({ storage, fetch: fetchImpl, eventSource: FakeEventSource as unknown as typeof EventSource });
    await engine.start("desk", { x: 0, y: 0 });
    await engine.transferEntries("other", ["file-1"], null);
    expect(body).toEqual({ sourceDesktopId: "desk", destinationDesktopId: "other", entryIds: ["file-1"], parentId: null });
    await engine.stop();
  });

  test("reads an optimistic transfer offline after switching desktops and replays it while the destination is active", async () => {
    const file = remoteDesktopState().entries[0];
    const localFile = { ...file };
    delete (localFile as Partial<typeof file>).revision;
    delete (localFile as Partial<typeof file>).contentRevision;
    const base = desktopStateSnapshot();
    const source = { ...base, entries: [localFile], sync: { ...base.sync, catalogId: "catalog", catalogRevision: 5, entryRevisions: { [file.id]: 4 }, contentRevisions: { [file.id]: 3 } } };
    const destination = { ...base, sync: { ...base.sync, catalogId: "catalog", catalogRevision: 5 } };
    const states = new Map([["source", source], ["destination", destination]]);
    let selected = "source";
    let online = false;
    let records: OutboxRecord[] = [];
    const requests: string[] = [];
    const sharedBlob = new File(["note"], file.name, { type: file.mimeType, lastModified: file.modifiedAt });
    const storage = {
      loadDesktop: async () => states.get(selected)!,
      readDesktopState: async (desktopId: string) => states.get(desktopId)!,
      enqueueTransfer: async (sourceDesktopId: string, destinationDesktopId: string, entryIds: string[], parentId: string | null) => {
        const transferred = transferEntriesBetweenDesktopStates(states.get(sourceDesktopId)!, states.get(destinationDesktopId)!, entryIds, parentId, 10);
        states.set(sourceDesktopId, transferred.source);
        states.set(destinationDesktopId, transferred.destination);
        const operation: OutboxOperation = { schemaVersion: 1, kind: "entry-transfer", entryIds, destinationDesktopId, parentId };
        const record: OutboxRecord = { operationId: "transfer", sequence: 1, clientId: "client", catalogId: "catalog", desktopId: sourceDesktopId, operation, status: "pending", error: null };
        records = [record];
        return { desktop: transferred.source, record };
      },
      readOutbox: async () => records,
      bindOutboxCatalog: async () => undefined,
      readCachedFile: async (_desktopId: string, catalogId: string, id: string, revision: number) => catalogId === "catalog" && id === file.id && revision === 3 ? sharedBlob : null,
      applyRemoteDesktop: async (next: ReturnType<typeof desktopStateSnapshot>, _contents: Map<string, Blob>, _acknowledged?: string, desktopId = selected) => { states.set(desktopId, next); return next; },
      acknowledgeMutation: async () => { records = []; },
      blockMutation: async () => undefined,
    } as unknown as NonNullable<SyncEngineOptions["storage"]>;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = `${init?.method ?? "GET"} ${String(input)}`;
      requests.push(request);
      if (!online) throw new TypeError("offline");
      if (String(input) === "/api/desktops/destination") return Response.json({ ...remoteDesktopState(), id: "destination", catalogId: "catalog", catalogRevision: 6 });
      if (String(input) === "/api/entry-transfers") return Response.json({ schemaVersion: 1, catalogId: "catalog", catalogRevision: 6 });
      if (String(input) === "/api/desktops/source") return Response.json({ ...remoteDesktopState(), id: "source", catalogId: "catalog", catalogRevision: 6, entries: [] });
      throw new Error(`Unexpected request: ${request}`);
    }) as typeof fetch;

    const sourceEngine = new SyncEngine({ storage, fetch: fetchImpl, eventSource: FakeEventSource as unknown as typeof EventSource });
    await sourceEngine.start("source", { x: 0, y: 0 });
    await sourceEngine.transferEntries("destination", [file.id], null);
    await sourceEngine.stop();

    selected = "destination";
    const destinationOffline = new SyncEngine({ storage, fetch: fetchImpl, eventSource: FakeEventSource as unknown as typeof EventSource });
    await destinationOffline.start("destination", { x: 0, y: 0 });
    expect(await (await destinationOffline.readFile(file.id)).text()).toBe("note");
    expect(states.get("destination")!.sync).toMatchObject({ entryRevisions: { [file.id]: 4 }, contentRevisions: { [file.id]: 3 } });
    await destinationOffline.stop();

    online = true;
    const destinationOnline = new SyncEngine({ storage, fetch: fetchImpl, eventSource: FakeEventSource as unknown as typeof EventSource });
    const started = await destinationOnline.start("destination", { x: 0, y: 0 });
    expect(started.status).toBe("online");
    expect(requests).toContain("POST /api/entry-transfers");
    expect(requests).toContain("GET /api/desktops/source");
    expect(records).toEqual([]);
    await destinationOnline.stop();
  });
});
