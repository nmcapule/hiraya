import { describe, expect, test } from "bun:test";
import { SyncEngine, type SyncEngineOptions } from "../src/lib/sync";
import type { OutboxOperation, OutboxRecord } from "../src/lib/outbox";
import { applyOutboxOperation, transferEntriesBetweenDesktopStates } from "../src/lib/outbox";
import { desktopStateSnapshot, remoteDesktopIdentity, remoteDesktopState } from "./fixtures";

const catalogQuota = { storageBytes: { used: 12, limit: 100 }, desktops: { used: 1, limit: 10 }, entries: { used: 2, limit: 5000 } };

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
  const pins = new Set<string>();
  const pending = new Map<string, Map<string, Blob>>();
  const stats = { cacheWrites: 0, blockWrites: 0, remoteApplications: [] as Array<{ acknowledgedOperationId?: string; force: boolean; useAcknowledgedContent: boolean }> };
  const storage = {
    loadDesktop: async () => current,
    readDesktopState: async () => current,
    applyRemoteDesktop: async (next: typeof current, _contents: Map<string, Blob>, acknowledgedOperationId?: string, _desktopId?: string, force = false, useAcknowledgedContent = true) => {
      stats.remoteApplications.push({ acknowledgedOperationId, force, useAcknowledgedContent });
      current = next;
      return current;
    },
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
    removeCachedFile: async (desktopId: string, catalogId: string, id: string, contentRevision: number) => cached.delete(`${desktopId}:${catalogId}:${id}:${contentRevision}`),
    loadOfflineInventory: async (desktopId: string) => ({
      desktopId,
      pinIds: [...pins],
      files: Object.fromEntries(current.entries.filter((entry) => entry.kind === "file").map((entry) => {
        const revision = current.sync.contentRevisions[entry.id];
        const available = cached.has(`${desktopId}:${current.sync.catalogId}:${entry.id}:${revision}`);
        return [entry.id, { cached: available, cachedBytes: available ? entry.size : 0, storedBytes: available ? entry.size : 0, pending: false, protected: false }];
      })),
      cachedBytes: [...cached.values()].reduce((total, file) => total + file.size, 0),
      protectedBytes: 0,
      releasableBytes: [...cached.values()].reduce((total, file) => total + file.size, 0),
      browserStorage: null,
    }),
    setOfflinePins: async (_desktopId: string, entryIds: string[], pinned: boolean) => {
      for (const id of entryIds) if (pinned) pins.add(id); else pins.delete(id);
      return [...pins];
    },
    releaseOfflineCopies: async () => {
      const releasedBytes = [...cached.values()].reduce((total, file) => total + file.size, 0);
      const releasedFiles = cached.size;
      cached.clear();
      return { releasedBytes, releasedFiles, skippedFiles: 0 };
    },
    readOutbox: async () => outbox,
    enqueueMutation: async (operation: OutboxOperation, contents = new Map<string, Blob>()) => {
      const state = applyOutboxOperation({ entries: current.entries, snapToGrid: current.layout.snapToGrid, wallpaper: current.layout.wallpaper, editorSettings: current.editorSettings, appearance: current.appearance, sync: current.sync }, operation);
      current = { entries: state.entries, layout: { snapToGrid: state.snapToGrid, wallpaper: state.wallpaper }, editorSettings: state.editorSettings, appearance: state.appearance, sync: state.sync };
      const record: OutboxRecord = { operationId: String(++sequence), sequence, clientId: "client", catalogId: current.sync.catalogId!, desktopId: "desk", operation, status: "pending", error: null };
      outbox.push(record);
      pending.set(record.operationId, contents);
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
    acknowledgeMutation: async (operationId: string) => { outbox = outbox.filter((record) => record.operationId !== operationId); pending.delete(operationId); },
    readPendingContent: async (operationId: string, entryId: string) => pending.get(operationId)?.get(entryId) ?? (() => { throw new Error("missing pending content"); })(),
    blockMutation: async (operationId: string, error: string) => {
      stats.blockWrites += 1;
      outbox = outbox.map((record) => record.operationId === operationId ? { ...record, status: "blocked" as const, error } : record);
    },
  } as unknown as NonNullable<SyncEngineOptions["storage"]>;
  return Object.assign(storage, { stats });
}

describe("canonical synchronization", () => {
  test("projects a complete imported hierarchy as one offline create operation", async () => {
    const storage = remoteStorage();
    const engine = new SyncEngine({ storage, fetch: (async () => { throw new TypeError("offline"); }) as typeof fetch, eventSource: FakeEventSource as unknown as typeof EventSource });
    await engine.start("desk", { x: 0, y: 0 });
    const entries = [
      { kind: "folder" as const, id: "import-root", name: "Imported", parentId: null, createdAt: 1, modifiedAt: 1, position: { x: 10, y: 20 } },
      { kind: "folder" as const, id: "import-empty", name: "Empty", parentId: "import-root", createdAt: 1, modifiedAt: 1, position: { x: 8, y: 8 } },
      { kind: "file" as const, id: "import-file", name: "note.txt", parentId: "import-root", createdAt: 1, modifiedAt: 1, position: { x: 8, y: 96 }, mimeType: "text/plain", size: 4 },
    ];

    expect(await engine.createEntries(entries, new Map([["import-file", new Blob(["note"], { type: "text/plain" })]]))).toEqual(entries);
    const records = await storage.readOutbox();
    expect(records).toHaveLength(1);
    expect(records[0].operation).toEqual({ schemaVersion: 1, kind: "create", entries });
    expect(await storage.readPendingContent(records[0].operationId, "import-file").then((content) => content.text())).toBe("note");
    await engine.stop();
  });

  test("saves binary content with MIME and revision options while preserving text saves", async () => {
    const file = { kind: "file" as const, id: "binary", name: "binary.dat", parentId: null, createdAt: 1, modifiedAt: 1, position: { x: 0, y: 0 }, mimeType: "application/octet-stream", size: 0 };
    let current = { ...desktopStateSnapshot(), entries: [file], sync: { ...desktopStateSnapshot().sync, contentRevisions: { binary: 4 } } };
    const writes: Array<{ bytes: number[]; mimeType?: string; expectedContentRevision?: number }> = [];
    const storage = {
      loadDesktop: async () => current,
      readCurrentDesktop: async () => current,
      saveFile: async (_id: string, content: Blob, options: { mimeType?: string; expectedContentRevision?: number } = {}) => {
        if (options.expectedContentRevision !== undefined && options.expectedContentRevision !== current.sync.contentRevisions.binary) throw new Error("revision conflict");
        writes.push({ bytes: [...new Uint8Array(await content.arrayBuffer())], ...options });
        const saved = { ...file, size: content.size, mimeType: options.mimeType ?? file.mimeType };
        current = { ...current, entries: [saved] };
        return saved;
      },
      saveTextFile: async (id: string, content: string) => storage.saveFile(id, new Blob([content], { type: file.mimeType })),
    } as unknown as NonNullable<SyncEngineOptions["storage"]>;
    const engine = new SyncEngine({ frontendOnly: true, storage });
    await engine.start("desk", { x: 0, y: 0 });

    await engine.saveFile("binary", new Blob([new Uint8Array([0, 128, 255])]), { mimeType: "image/png", expectedContentRevision: 4 });
    await engine.saveTextFile("binary", "ok");

    expect(writes[0]).toEqual({ bytes: [0, 128, 255], mimeType: "image/png", expectedContentRevision: 4 });
    expect(new TextDecoder().decode(new Uint8Array(writes[1].bytes))).toBe("ok");
    await engine.stop();
  });

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
      return Response.json({ schemaVersion: 1, catalogId: "catalog", catalogRevision: 1, desktops: [remoteDesktopIdentity()], quota: catalogQuota });
    }) as typeof fetch });

    expect(await engine.listDesktops()).toEqual({ schemaVersion: 1, catalogId: "catalog", catalogRevision: 1, activeDesktopId: "desk", desktops: [remoteDesktopIdentity()], quota: catalogQuota });
  });

  test("recovers when concurrent first-run initialization creates the local desktop", async () => {
    const local = [remoteDesktopIdentity("desk", "Desktop")];
    let reads = 0;
    const storage = {
      listDesktops: async () => ({ desktops: reads++ === 0 ? [] : local, activeDesktopId: reads === 1 ? null : "desk" }),
      createDesktop: async () => { throw new Error("A desktop with that name already exists."); },
    } as unknown as NonNullable<SyncEngineOptions["storage"]>;
    const engine = new SyncEngine({ frontendOnly: true, storage });

    expect(await engine.listDesktops()).toMatchObject({ activeDesktopId: "desk", desktops: local });
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
      const desktops = (catalogRead === 1 ? local : [local[1]]).map((desktop) => remoteDesktopIdentity(desktop.id, desktop.name));
      return Response.json({ schemaVersion: 1, catalogId: "catalog", catalogRevision: catalogRead, desktops, quota: { ...catalogQuota, desktops: { used: desktops.length, limit: 10 } } });
    }) as typeof fetch });

    expect((await engine.listDesktops()).activeDesktopId).toBe("one");
    expect(await engine.refreshCatalog()).toMatchObject({ activeDesktopId: "two", desktops: [{ id: "two", name: "Two" }] });
  });

  test("retains the last authoritative quota snapshot while offline", async () => {
    const local = [{ id: "desk", name: "Desktop" }];
    let online = true;
    const storage = {
      listDesktops: async () => ({ desktops: local, activeDesktopId: "desk" }),
      ensureDesktop: async (desktop: { id: string; name: string }) => desktop,
      bindOutboxCatalog: async () => undefined,
      readOutbox: async () => [],
    } as unknown as NonNullable<SyncEngineOptions["storage"]>;
    const engine = new SyncEngine({ storage, fetch: (async () => {
      if (!online) throw new TypeError("offline");
      return Response.json({ schemaVersion: 1, catalogId: "catalog", catalogRevision: 1, desktops: local.map((desktop) => remoteDesktopIdentity(desktop.id, desktop.name)), quota: catalogQuota });
    }) as typeof fetch });

    expect((await engine.listDesktops()).quota).toEqual(catalogQuota);
    online = false;
    expect(await engine.listDesktops()).toMatchObject({ catalogId: null, quota: catalogQuota });
  });

  test("does not attach a new catalog quota to an older local projection", async () => {
    const local = [{ id: "desk", name: "Desktop" }];
    let catalogId = "old-catalog";
    const storage = {
      listDesktops: async () => ({ desktops: local, activeDesktopId: "desk" }),
      ensureDesktop: async () => { if (catalogId === "new-catalog") throw new Error("local reconciliation failed"); return local[0]; },
      bindOutboxCatalog: async () => undefined,
      readOutbox: async () => [],
    } as unknown as NonNullable<SyncEngineOptions["storage"]>;
    const engine = new SyncEngine({ storage, fetch: (async () => Response.json({ schemaVersion: 1, catalogId, catalogRevision: 1, desktops: local.map((desktop) => remoteDesktopIdentity(desktop.id, desktop.name)), quota: catalogQuota })) as typeof fetch });

    expect((await engine.listDesktops()).quota).toEqual(catalogQuota);
    catalogId = "new-catalog";
    expect(await engine.listDesktops()).toMatchObject({ catalogId: null, quota: null, desktops: local });
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
    const edit: OutboxRecord = { operationId: "edit", sequence: 1, clientId: "client", catalogId: "catalog", desktopId: "desktop-a", operation: { schemaVersion: 1, kind: "layout", layout: { snapToGrid: true, wallpaper: { source: "dusk", fit: "cover", positionX: 50, positionY: 50, blur: 0, dim: 0, overlayColor: "#000000", overlayOpacity: 0 } } }, status: "pending", error: null };
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
    { name: "nonactive desktop mutation", desktopId: "old-nonactive", operation: { schemaVersion: 1, kind: "layout", layout: { snapToGrid: true, wallpaper: { source: "dusk", fit: "cover", positionX: 50, positionY: 50, blur: 0, dim: 0, overlayColor: "#000000", overlayOpacity: 0 } } } },
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
      if (String(input) === "/api/catalog") return Response.json({ schemaVersion: 1, catalogId: "new-catalog", catalogRevision: 2, desktops: [remoteDesktopIdentity()], quota: catalogQuota });
      if (String(input) === "/api/desktops/desk") return Response.json(remote);
      throw new Error(`A stale operation was sent: ${request}`);
    }) as typeof fetch;
    const engine = new SyncEngine({ storage, fetch: fetchImpl, eventSource: FakeEventSource as unknown as typeof EventSource });

    const catalog = await engine.listDesktops();
    expect(catalog.desktops).toEqual([remoteDesktopIdentity()]);
    expect(records[0]).toMatchObject({ status: "blocked", catalogId: "old-catalog" });
    const started = await engine.start("desk", { x: 0, y: 0 });
    expect(started.status).toBe("online");
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
      if (String(input) === "/api/catalog") return Response.json({ schemaVersion: 1, catalogId: "catalog", catalogRevision: 1, desktops: [remoteDesktopIdentity("server-desk", "Desktop")], quota: catalogQuota });
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
      if (String(input) === "/api/desktops/desk/entries/file-1/content-access?revision=1") return Response.json({ entryId: "file-1", contentRevision: 1, size: 4, sha256: "edb465624291e4053c6c5ea4b7eb320dec773e10a57d26b95dcf0564f8e310f8", access: { url: "https://downloads.example.test/file-1", method: "GET", headers: {}, expiresAt: 2_000_000_000_000 } });
      if (String(input) === "https://downloads.example.test/file-1") return new Response("note");
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
    let directInit: RequestInit | undefined;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/desktops/desk") return Response.json(remote);
      if (String(input) === "/api/desktops/desk/entries/file-1/content-access?revision=1") {
        contentRequests += 1;
        return Response.json({ entryId: "file-1", contentRevision: 1, size: 4, sha256: "edb465624291e4053c6c5ea4b7eb320dec773e10a57d26b95dcf0564f8e310f8", access: { url: "https://downloads.example.test/file-1", method: "GET", headers: { "X-Test-Download": "yes" }, expiresAt: 2_000_000_000_000 } });
      }
      if (String(input) === "https://downloads.example.test/file-1") { directInit = init; return new Response("note"); }
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
    expect(directInit).toMatchObject({ method: "GET", credentials: "omit", referrerPolicy: "no-referrer", redirect: "error", cache: "no-store" });
    expect(new Headers(directInit?.headers).get("X-Test-Download")).toBe("yes");
    await engine.stop();
  });

  test("reports, requests, and removes exact validated offline file revisions", async () => {
    const storage = remoteStorage();
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input) === "/api/desktops/desk") return Response.json(remoteDesktopState());
      if (String(input) === "/api/desktops/desk/entries/file-1/content-access?revision=1") return Response.json({ entryId: "file-1", contentRevision: 1, size: 4, sha256: "edb465624291e4053c6c5ea4b7eb320dec773e10a57d26b95dcf0564f8e310f8", access: { url: "https://downloads.example.test/file-1", method: "GET", headers: {}, expiresAt: 2_000_000_000_000 } });
      if (String(input) === "https://downloads.example.test/file-1") return new Response("note");
      throw new Error(`Unexpected request: ${String(input)}`);
    }) as typeof fetch;
    const engine = new SyncEngine({ storage, fetch: fetchImpl, eventSource: FakeEventSource as unknown as typeof EventSource });
    await engine.start("desk", { x: 0, y: 0 });

    expect(await engine.isFileAvailableOffline("file-1")).toBe(false);
    expect(await (await engine.makeFileAvailableOffline("file-1")).text()).toBe("note");
    expect(await engine.isFileAvailableOffline("file-1")).toBe(true);
    expect(await engine.removeFileFromOfflineCache("file-1")).toBe(true);
    expect(await engine.isFileAvailableOffline("file-1")).toBe(false);
    await engine.stop();
  });

  test("roundtrips durable pin intent and downloads through the verified access path", async () => {
    const storage = remoteStorage();
    const requests: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      requests.push(String(input));
      if (String(input) === "/api/desktops/desk") return Response.json(remoteDesktopState());
      if (String(input) === "/api/desktops/desk/entries/file-1/content-access?revision=1") return Response.json({ entryId: "file-1", contentRevision: 1, size: 4, sha256: "edb465624291e4053c6c5ea4b7eb320dec773e10a57d26b95dcf0564f8e310f8", access: { url: "https://downloads.example.test/file-1", method: "GET", headers: {}, expiresAt: 2_000_000_000_000 } });
      if (String(input) === "https://downloads.example.test/file-1") return new Response("note");
      throw new Error(`Unexpected request: ${String(input)}`);
    }) as typeof fetch;
    const engine = new SyncEngine({ storage, fetch: fetchImpl, eventSource: FakeEventSource as unknown as typeof EventSource });
    await engine.start("desk", { x: 0, y: 0 });

    await engine.setOfflinePinIntent(["file-1"], true);
    expect((await engine.loadOfflineInventory()).pinIds).toEqual(["file-1"]);
    expect(await engine.isFileAvailableOffline("file-1")).toBe(true);
    expect(requests).toContain("/api/desktops/desk/entries/file-1/content-access?revision=1");
    await engine.setOfflinePinIntent(["file-1"], false);
    expect((await engine.loadOfflineInventory()).pinIds).toEqual([]);
    expect(await engine.releaseOfflineCopies()).toMatchObject({ releasedFiles: 1, releasedBytes: 4 });
    await engine.stop();
  });

  test("coalesces concurrent active-desktop inventory loads", async () => {
    const storage = remoteStorage();
    const original = storage.loadOfflineInventory;
    let loads = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    storage.loadOfflineInventory = async (desktopId: string) => { loads += 1; await gate; return original(desktopId); };
    const engine = new SyncEngine({ frontendOnly: true, storage });
    await engine.start("desk", { x: 0, y: 0 });
    const first = engine.loadOfflineInventory();
    const second = engine.loadOfflineInventory();
    release();
    await Promise.all([first, second]);
    expect(loads).toBe(1);
    await engine.stop();
  });

  test("suppresses late offline progress after the desktop generation stops", async () => {
    const storage = remoteStorage();
    await storage.setOfflinePins("desk", ["file-1"], true);
    let releaseDownload!: () => void;
    const downloadGate = new Promise<void>((resolve) => { releaseDownload = resolve; });
    const progress: Array<{ phase: string; desktopId: string; generation: number; operationId: string }> = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input) === "/api/desktops/desk") return Response.json(remoteDesktopState());
      if (String(input) === "/api/desktops/desk/entries/file-1/content-access?revision=1") return Response.json({ entryId: "file-1", contentRevision: 1, size: 4, sha256: "edb465624291e4053c6c5ea4b7eb320dec773e10a57d26b95dcf0564f8e310f8", access: { url: "https://downloads.example.test/file-1", method: "GET", headers: {}, expiresAt: 2_000_000_000_000 } });
      if (String(input) === "https://downloads.example.test/file-1") { await downloadGate; return new Response("note"); }
      throw new Error(`Unexpected request: ${String(input)}`);
    }) as typeof fetch;
    const engine = new SyncEngine({ storage, fetch: fetchImpl, eventSource: FakeEventSource as unknown as typeof EventSource });
    engine.subscribeOfflineStorage(() => undefined, (value) => { if (value) progress.push(value); });
    await engine.start("desk", { x: 0, y: 0 });
    while (!progress.length) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(progress[0]).toMatchObject({ phase: "downloading", desktopId: "desk" });
    expect(progress[0].operationId).toBeTruthy();
    await engine.stop();
    const countAfterStop = progress.length;
    releaseDownload();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(progress).toHaveLength(countAfterStop);
  });

  test("retries blocked records in order and publishes queue changes", async () => {
    const storage = remoteStorage();
    let remote = remoteDesktopState();
    let rejectMutation = true;
    const queueSizes: number[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/desktops/desk" && !init?.method) return Response.json(remote);
      if (String(input) === "/api/desktops/desk/root-entry-positions") {
        if (rejectMutation) return Response.json({ error: "position conflict" }, { status: 409 });
        remote = { ...remote, catalogRevision: 2, entries: [{ ...remote.entries[0], position: { x: 5, y: 6 }, revision: 2 }] };
        return Response.json({});
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    }) as typeof fetch;
    const engine = new SyncEngine({ storage, fetch: fetchImpl, eventSource: FakeEventSource as unknown as typeof EventSource });
    await engine.start("desk", { x: 0, y: 0 });
    const unsubscribe = engine.subscribeOutbox((records) => queueSizes.push(records.length));
    await expect(engine.updateRootEntryPositions([{ entryId: "file-1", position: { x: 5, y: 6 } }])).rejects.toThrow("position conflict");
    const [blocked] = await engine.listOutboxRecords();
    expect(blocked.status).toBe("blocked");

    rejectMutation = false;
    await engine.retryBlockedOutboxRecord(blocked.operationId);
    expect(await engine.listOutboxRecords()).toEqual([]);
    expect(queueSizes).toContain(1);
    expect(queueSizes.at(-1)).toBe(0);
    unsubscribe();
    await engine.stop();
  });

  test("discards only the first blocked record and force-reprojects authoritative state", async () => {
    const storage = remoteStorage();
    const remote = remoteDesktopState();
    let latest = desktopStateSnapshot();
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/desktops/desk" && !init?.method) return Response.json(remote);
      if (String(input) === "/api/desktops/desk/layout") return Response.json({ error: "layout conflict" }, { status: 409 });
      throw new Error(`Unexpected request: ${String(input)}`);
    }) as typeof fetch;
    const engine = new SyncEngine({ storage, fetch: fetchImpl, eventSource: FakeEventSource as unknown as typeof EventSource });
    await engine.start("desk", { x: 0, y: 0 });
    engine.subscribe((desktop) => { latest = desktop; }, () => undefined);
    await expect(engine.saveDesktopLayout({ ...remote.layout, snapToGrid: true })).rejects.toThrow("layout conflict");
    const [blocked] = await engine.listOutboxRecords();
    expect(latest.layout.snapToGrid).toBe(true);

    await engine.discardBlockedOutboxRecord(blocked.operationId);
    expect(await engine.listOutboxRecords()).toEqual([]);
    expect(latest.layout.snapToGrid).toBe(remote.layout.snapToGrid);
    expect(storage.stats.remoteApplications.at(-1)).toEqual({ acknowledgedOperationId: blocked.operationId, force: true, useAcknowledgedContent: false });
    await engine.stop();
  });

  test("rejects discard unless the caller selects the blocked head record", async () => {
    const first: OutboxRecord = { operationId: "first", sequence: 1, clientId: "client", catalogId: "catalog", desktopId: "desk", operation: { schemaVersion: 1, kind: "layout", layout: remoteDesktopState().layout }, status: "pending", error: null };
    const second: OutboxRecord = { operationId: "second", sequence: 2, clientId: "client", catalogId: "catalog", desktopId: "desk", operation: { schemaVersion: 1, kind: "editor-settings", settings: remoteDesktopState().editorSettings }, status: "blocked", error: "conflict" };
    const records = [first, second];
    const storage = {
      readOutbox: async () => records,
    } as unknown as NonNullable<SyncEngineOptions["storage"]>;
    const engine = new SyncEngine({ storage });

    await expect(engine.discardBlockedOutboxRecord(first.operationId)).rejects.toThrow("Only blocked changes");
    await expect(engine.discardBlockedOutboxRecord(second.operationId)).rejects.toThrow("earlier queued changes");
    expect(records).toEqual([first, second]);
  });

  test("does not remove authoritative local file content from offline storage", async () => {
    const remote = remoteDesktopState();
    const file = { ...remote.entries[0] };
    delete (file as Partial<typeof remote.entries[0]>).revision;
    delete (file as Partial<typeof remote.entries[0]>).contentRevision;
    const current = { ...desktopStateSnapshot(), entries: [file] };
    let removed = false;
    const storage = {
      loadDesktop: async () => current,
      readFile: async () => new File(["note"], "note.txt"),
      removeCachedFile: async () => { removed = true; return true; },
    } as unknown as NonNullable<SyncEngineOptions["storage"]>;
    const engine = new SyncEngine({ frontendOnly: true, storage, eventSource: FakeEventSource as unknown as typeof EventSource });
    await engine.start("desk", { x: 0, y: 0 });

    expect(await engine.isFileAvailableOffline("file-1")).toBe(true);
    await expect(engine.removeFileFromOfflineCache("file-1")).rejects.toThrow("Authoritative local file content");
    expect(removed).toBe(false);
    await engine.stop();
  });

  test("does not cache content returned for a different revision", async () => {
    const storage = remoteStorage();
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input) === "/api/desktops/desk") return Response.json(remoteDesktopState());
      if (String(input) === "/api/desktops/desk/entries/file-1/content-access?revision=1") return Response.json({ entryId: "file-1", contentRevision: 2, size: 4, sha256: "edb465624291e4053c6c5ea4b7eb320dec773e10a57d26b95dcf0564f8e310f8", access: { url: "https://downloads.example.test/file-1", method: "GET", headers: {}, expiresAt: 2_000_000_000_000 } });
      throw new Error(`Unexpected request: ${String(input)}`);
    }) as typeof fetch;
    const engine = new SyncEngine({ storage, fetch: fetchImpl, eventSource: FakeEventSource as unknown as typeof EventSource });
    await engine.start("desk", { x: 0, y: 0 });
    await expect(engine.readFile("file-1")).rejects.toThrow("changed while it was loading");
    expect(storage.stats.cacheWrites).toBe(0);
    await engine.stop();
  });

  test("hashes staged saves, uploads directly, and commits before reconciliation", async () => {
    const storage = remoteStorage();
    let remote = remoteDesktopState();
    const requests: string[] = [];
    let prepareBody: unknown;
    let directInit: RequestInit | undefined;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(`${init?.method ?? "GET"} ${String(input)}`);
      if (String(input) === "/api/desktops/desk" && !init?.method) return Response.json(remote);
      if (String(input) === "/api/desktops/desk/blob-mutations" && init?.method === "POST") {
        prepareBody = JSON.parse(String(init.body));
        return Response.json({ state: "prepared", uploadId: "upload-1", expiresAt: 2_000_000_000_000, items: [{ entryId: "file-1", access: { url: "https://uploads.example.test/file-1?signature=secret", method: "PUT", headers: { "X-Test-Upload": "yes" }, expiresAt: 2_000_000_000_000 } }] });
      }
      if (String(input).startsWith("https://uploads.example.test/")) {
        directInit = init;
        expect(await new Response(init?.body).text()).toBe("updated note");
        return new Response(null, { status: 200 });
      }
      if (String(input) === "/api/desktops/desk/blob-mutations/upload-1/commit" && init?.method === "POST") {
        remote = { ...remote, catalogRevision: 2, entries: [{ ...remote.entries[0], size: 12, revision: 2, contentRevision: 2 }] };
        return Response.json({});
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    }) as typeof fetch;
    const engine = new SyncEngine({ storage, fetch: fetchImpl, eventSource: FakeEventSource as unknown as typeof EventSource });
    await engine.start("desk", { x: 0, y: 0 });
    await engine.saveTextFile("file-1", "updated note");

    expect(prepareBody).toMatchObject({
      kind: "save-content",
      items: [{ entry: expect.objectContaining({ id: "file-1", size: 12 }), sha256: "977eefe2ccc906a187bc83d1815feaa068bbc1268f3d38f368a9bb2197f1a807", md5: "e2a4459894e14f0f93cc1c007eae90f8" }],
    });
    expect(directInit).toMatchObject({ method: "PUT", credentials: "omit", referrerPolicy: "no-referrer", redirect: "error" });
    expect(new Headers(directInit?.headers).get("X-Test-Upload")).toBe("yes");
    expect(requests.indexOf("PUT https://uploads.example.test/file-1?signature=secret")).toBeLessThan(requests.indexOf("POST /api/desktops/desk/blob-mutations/upload-1/commit"));
    expect((await engine.getOutboxStatus()).pending).toBe(0);
    await engine.stop();
  });

  test("prepares a mixed tree in original order and uploads only its file", async () => {
    const storage = remoteStorage();
    let remote = remoteDesktopState();
    let preparedItems: Array<{ entry: ReturnType<typeof remoteDesktopState>["entries"][number]; sha256: string; md5: string }> = [];
    const requests: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(`${init?.method ?? "GET"} ${String(input)}`);
      if (String(input) === "/api/desktops/desk" && !init?.method) return Response.json(remote);
      if (String(input) === "/api/desktops/desk/blob-mutations" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { kind: string; items: typeof preparedItems };
        expect(body.kind).toBe("create");
        preparedItems = body.items;
        const file = preparedItems.find((item) => item.entry.kind === "file")!;
        return Response.json({ state: "prepared", uploadId: "tree-upload", expiresAt: 2_000_000_000_000, items: [{ entryId: file.entry.id, access: { url: "https://uploads.example.test/tree-file", method: "PUT", headers: {}, expiresAt: 2_000_000_000_000 } }] });
      }
      if (String(input) === "https://uploads.example.test/tree-file") {
        expect(await new Response(init?.body).text()).toBe("leaf");
        return new Response(null, { status: 200 });
      }
      if (String(input) === "/api/desktops/desk/blob-mutations/tree-upload/commit" && init?.method === "POST") {
        remote = { ...remote, catalogRevision: 2, entries: [...remote.entries, ...preparedItems.map(({ entry }) => ({ ...entry, revision: 2, contentRevision: entry.kind === "file" ? 2 : 0 }))] };
        return Response.json({});
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    }) as typeof fetch;
    const engine = new SyncEngine({ storage, fetch: fetchImpl, eventSource: FakeEventSource as unknown as typeof EventSource });
    await engine.start("desk", { x: 0, y: 0 });
    await engine.pasteEntries({
      selectedRootIds: ["source-folder"],
      entries: [
        { kind: "folder", id: "source-folder", name: "Tree", parentId: null, createdAt: 1, modifiedAt: 1, position: { x: 1, y: 2 } },
        { kind: "file", id: "source-file", name: "leaf.txt", parentId: "source-folder", createdAt: 1, modifiedAt: 1, position: { x: 3, y: 4 }, mimeType: "text/plain", size: 4 },
      ],
      contents: new Map([["source-file", new Blob(["leaf"], { type: "text/plain" })]]),
    }, null, new Map([["source-folder", "Tree"]]), new Map([["source-folder", { x: 10, y: 20 }]]));

    expect(preparedItems.map(({ entry, sha256, md5 }) => ({ kind: entry.kind, id: entry.id, parentId: entry.parentId, sha256, md5 }))).toEqual([
      { kind: "folder", id: preparedItems[0].entry.id, parentId: null, sha256: "", md5: "" },
      { kind: "file", id: preparedItems[1].entry.id, parentId: preparedItems[0].entry.id, sha256: "9f91161f43433e49a6de6db680d79f60159f2e4ac9172621a12846428158440b", md5: "bab4ff04cc14af66e4d42c85f888cfe6" },
    ]);
    expect(requests.filter((request) => request.startsWith("PUT https://uploads.example.test/"))).toHaveLength(1);
    expect((await engine.getOutboxStatus()).pending).toBe(0);
    await engine.stop();
  });

  test("prepares and commits folder-only creates without upload targets", async () => {
    const storage = remoteStorage();
    let remote = remoteDesktopState();
    let prepareBody: { kind: string; items: Array<{ entry: { id: string; kind: string }; sha256: string; md5: string }> } | undefined;
    const requests: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(`${init?.method ?? "GET"} ${String(input)}`);
      if (String(input) === "/api/desktops/desk" && !init?.method) return Response.json(remote);
      if (String(input) === "/api/desktops/desk/blob-mutations" && init?.method === "POST") {
        prepareBody = JSON.parse(String(init.body));
        return Response.json({ state: "prepared", uploadId: "folder-upload", expiresAt: 2_000_000_000_000, items: [] });
      }
      if (String(input) === "/api/desktops/desk/blob-mutations/folder-upload/commit" && init?.method === "POST") {
        const folder = prepareBody!.items[0].entry;
        remote = { ...remote, catalogRevision: 2, entries: [...remote.entries, { ...folder, name: "Empty", parentId: null, createdAt: 1, modifiedAt: 2, position: { x: 4, y: 5 }, revision: 2, contentRevision: 0 }] };
        return Response.json({});
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    }) as typeof fetch;
    const engine = new SyncEngine({ storage, fetch: fetchImpl, eventSource: FakeEventSource as unknown as typeof EventSource });
    await engine.start("desk", { x: 0, y: 0 });
    await engine.createFolder("Empty", null, { x: 4, y: 5 });

    expect(prepareBody).toMatchObject({ kind: "create", items: [{ entry: { kind: "folder" }, sha256: "", md5: "" }] });
    expect(requests.some((request) => request.startsWith("PUT "))).toBe(false);
    expect(requests).toContain("POST /api/desktops/desk/blob-mutations/folder-upload/commit");
    expect((await engine.getOutboxStatus()).pending).toBe(0);
    await engine.stop();
  });

  test("reconciles an already committed prepare without uploading or committing again", async () => {
    const storage = remoteStorage();
    let remote = remoteDesktopState();
    const requests: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(`${init?.method ?? "GET"} ${String(input)}`);
      if (String(input) === "/api/desktops/desk" && !init?.method) return Response.json(remote);
      if (String(input) === "/api/desktops/desk/blob-mutations" && init?.method === "POST") {
        remote = { ...remote, catalogRevision: 2, entries: [{ ...remote.entries[0], size: 9, revision: 2, contentRevision: 2 }] };
        return Response.json({ state: "committed" });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    }) as typeof fetch;
    const engine = new SyncEngine({ storage, fetch: fetchImpl, eventSource: FakeEventSource as unknown as typeof EventSource });
    await engine.start("desk", { x: 0, y: 0 });
    await engine.saveTextFile("file-1", "committed");

    expect(requests.some((request) => request.startsWith("PUT "))).toBe(false);
    expect(requests.some((request) => request.includes("/commit"))).toBe(false);
    expect((await engine.getOutboxStatus()).pending).toBe(0);
    await engine.stop();
  });

  test("aborts a failed upload and prepares fresh targets on replay", async () => {
    const storage = remoteStorage();
    let remote = remoteDesktopState();
    let prepares = 0;
    const requests: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(`${init?.method ?? "GET"} ${String(input)}`);
      if (String(input) === "/api/desktops/desk" && !init?.method) return Response.json(remote);
      if (String(input) === "/api/desktops/desk/blob-mutations" && init?.method === "POST") {
        prepares += 1;
        return Response.json({ state: "prepared", uploadId: `upload-${prepares}`, expiresAt: 2_000_000_000_000, items: [{ entryId: "file-1", access: { url: `https://uploads.example.test/file-1?attempt=${prepares}`, method: "PUT", headers: {}, expiresAt: 2_000_000_000_000 } }] });
      }
      if (String(input) === "https://uploads.example.test/file-1?attempt=1") return new Response(null, { status: 503 });
      if (String(input) === "/api/desktops/desk/blob-mutations/upload-1" && init?.method === "DELETE") return new Response(null, { status: 204 });
      if (String(input) === "https://uploads.example.test/file-1?attempt=2") return new Response(null, { status: 200 });
      if (String(input) === "/api/desktops/desk/blob-mutations/upload-2/commit" && init?.method === "POST") {
        remote = { ...remote, catalogRevision: 2, entries: [{ ...remote.entries[0], size: 5, revision: 2, contentRevision: 2 }] };
        return Response.json({});
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    }) as typeof fetch;

    const first = new SyncEngine({ storage, fetch: fetchImpl, eventSource: FakeEventSource as unknown as typeof EventSource });
    await first.start("desk", { x: 0, y: 0 });
    await first.saveTextFile("file-1", "retry");
    expect((await first.getOutboxStatus()).pending).toBe(1);
    await first.stop();

    const second = new SyncEngine({ storage, fetch: fetchImpl, eventSource: FakeEventSource as unknown as typeof EventSource });
    expect((await second.start("desk", { x: 0, y: 0 })).status).toBe("online");
    expect(prepares).toBe(2);
    expect(requests).toContain("DELETE /api/desktops/desk/blob-mutations/upload-1");
    expect(requests).toContain("PUT https://uploads.example.test/file-1?attempt=2");
    expect((await second.getOutboxStatus()).pending).toBe(0);
    await second.stop();
  });

  test("restarts prepare, upload, and commit after an expired commit reservation", async () => {
    const storage = remoteStorage();
    let remote = remoteDesktopState();
    let prepares = 0;
    let commits = 0;
    const requests: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(`${init?.method ?? "GET"} ${String(input)}`);
      if (String(input) === "/api/desktops/desk" && !init?.method) return Response.json(remote);
      if (String(input) === "/api/desktops/desk/blob-mutations" && init?.method === "POST") {
        prepares += 1;
        return Response.json({ state: "prepared", uploadId: `expired-${prepares}`, expiresAt: 2_000_000_000_000, items: [{ entryId: "file-1", access: { url: `https://uploads.example.test/expired-${prepares}`, method: "PUT", headers: {}, expiresAt: 2_000_000_000_000 } }] });
      }
      if (String(input).startsWith("https://uploads.example.test/expired-")) return new Response(null, { status: 200 });
      if (String(input).includes("/blob-mutations/expired-") && String(input).endsWith("/commit")) {
        commits += 1;
        if (commits === 1) return Response.json({ error: "upload reservation expired" }, { status: 410 });
        remote = { ...remote, catalogRevision: 2, entries: [{ ...remote.entries[0], size: 5, revision: 2, contentRevision: 2 }] };
        return Response.json({});
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    }) as typeof fetch;

    const first = new SyncEngine({ storage, fetch: fetchImpl, eventSource: FakeEventSource as unknown as typeof EventSource });
    await first.start("desk", { x: 0, y: 0 });
    await first.saveTextFile("file-1", "retry");
    expect(await first.getOutboxStatus()).toMatchObject({ pending: 1, blocked: 0 });
    await first.stop();

    const second = new SyncEngine({ storage, fetch: fetchImpl, eventSource: FakeEventSource as unknown as typeof EventSource });
    expect((await second.start("desk", { x: 0, y: 0 })).status).toBe("online");
    expect(prepares).toBe(2);
    expect(commits).toBe(2);
    expect(requests).toContain("PUT https://uploads.example.test/expired-2");
    expect(requests.some((request) => request.startsWith("DELETE "))).toBe(false);
    expect((await second.getOutboxStatus()).pending).toBe(0);
    await second.stop();
  });

  for (const commitError of [
    { status: 404, message: "upload reservation not found", blocked: false },
    { status: 409, message: "a reserved upload is missing", blocked: false },
    { status: 409, message: "a reserved upload failed size or checksum verification", blocked: false },
    { status: 409, message: "an entry conflicts with existing metadata", blocked: true },
  ]) test(`${commitError.blocked ? "blocks" : "retries"} commit ${commitError.status}: ${commitError.message}`, async () => {
    const storage = remoteStorage();
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/desktops/desk" && !init?.method) return Response.json(remoteDesktopState());
      if (String(input) === "/api/desktops/desk/blob-mutations" && init?.method === "POST") return Response.json({ state: "prepared", uploadId: "conflict", expiresAt: 2_000_000_000_000, items: [{ entryId: "file-1", access: { url: "https://uploads.example.test/conflict", method: "PUT", headers: {}, expiresAt: 2_000_000_000_000 } }] });
      if (String(input) === "https://uploads.example.test/conflict") return new Response(null, { status: 200 });
      if (String(input) === "/api/desktops/desk/blob-mutations/conflict/commit") return Response.json({ error: commitError.message }, { status: commitError.status });
      throw new Error(`Unexpected request: ${String(input)}`);
    }) as typeof fetch;
    const engine = new SyncEngine({ storage, fetch: fetchImpl, eventSource: FakeEventSource as unknown as typeof EventSource });
    await engine.start("desk", { x: 0, y: 0 });
    const saving = engine.saveTextFile("file-1", "conflict");
    if (commitError.blocked) await expect(saving).rejects.toThrow(commitError.message);
    else await saving;
    expect(await engine.getOutboxStatus()).toMatchObject(commitError.blocked ? { pending: 0, blocked: 1 } : { pending: 1, blocked: 0 });
    expect(storage.stats.blockWrites).toBe(commitError.blocked ? 1 : 0);
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
    const source = { entries: [localFile], snapToGrid: base.layout.snapToGrid, wallpaper: base.layout.wallpaper, editorSettings: base.editorSettings, appearance: base.appearance, sync: { ...base.sync, catalogId: "catalog", catalogRevision: 5, entryRevisions: { [file.id]: 4 }, contentRevisions: { [file.id]: 3 } } };
    const destination = { entries: base.entries, snapToGrid: base.layout.snapToGrid, wallpaper: base.layout.wallpaper, editorSettings: base.editorSettings, appearance: base.appearance, sync: { ...base.sync, catalogId: "catalog", catalogRevision: 5 } };
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
