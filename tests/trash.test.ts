import { describe, expect, test } from "bun:test";
import { parseTrashDeleteResult, parseTrashDocument, parseTrashRestoreResult } from "../src/lib/contracts";
import { API_ROUTES } from "../src/lib/api-routes";
import { SyncEngine, TrashUnavailableError, type SyncEngineOptions } from "../src/lib/sync";
import { desktopStateSnapshot, remoteDesktopState } from "./fixtures";

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener() {}
  close() {}
}

const folder = {
  kind: "folder" as const,
  id: "folder-1",
  name: "Plans",
  parentId: "old-parent",
  createdAt: 1,
  modifiedAt: 2,
  position: { x: 4, y: 8 },
  revision: 3,
  contentRevision: 0,
};

const file = {
  kind: "file" as const,
  id: "file-1",
  name: "plan.txt",
  parentId: "folder-1",
  createdAt: 1,
  modifiedAt: 2,
  position: { x: 0, y: 0 },
  mimeType: "text/plain",
  size: 4,
  revision: 3,
  contentRevision: 3,
};

describe("Trash contracts", () => {
  test("validates schema version 1, ordering, entries, and counts", () => {
    const document = { schemaVersion: 1, catalogId: "catalog", catalogRevision: 4, desktopId: "desk", items: [
      { entry: folder, deletedAt: 20, descendantCount: 1 },
      { entry: { ...file, id: "file-2", parentId: null }, deletedAt: 10, descendantCount: 0 },
    ] };
    expect(parseTrashDocument(document, "desk")).toEqual(document);
    expect(() => parseTrashDocument({ ...document, schemaVersion: 2 })).toThrow("schema version");
    expect(() => parseTrashDocument({ ...document, desktopId: "other" }, "desk")).toThrow("different desktop");
    expect(() => parseTrashDocument({ ...document, items: [...document.items].reverse() })).toThrow("newest-first");
    expect(() => parseTrashDocument({ ...document, items: [{ ...document.items[0], descendantCount: -1 }] })).toThrow("descendant count");
    expect(() => parseTrashDocument({ ...document, items: [{ ...document.items[0], entry: { ...folder, revision: 5 } }] })).toThrow("newer than its catalog");
  });

  test("validates restore subtrees with an external original parent and delete receipts", () => {
    const restored = [{ ...folder, revision: 5 }, { ...file, revision: 5 }];
    expect(parseTrashRestoreResult({ catalogRevision: 5, entries: restored }, folder.id)).toEqual({ catalogRevision: 5, entries: restored });
    expect(() => parseTrashRestoreResult({ catalogRevision: 5, entries: [file] }, folder.id)).toThrow("root entry");
    expect(() => parseTrashRestoreResult({ catalogRevision: 5, entries: restored }, folder.id, "root")).toThrow("restore its root");
    expect(() => parseTrashRestoreResult({ catalogRevision: 5, entries: [{ ...folder, parentId: null, revision: 4 }, { ...file, revision: 5 }] }, folder.id, "root")).toThrow("entry revisions");
    expect(parseTrashDeleteResult({ catalogRevision: 6, deletedIds: [folder.id, file.id] })).toEqual({ catalogRevision: 6, deletedIds: [folder.id, file.id] });
    expect(() => parseTrashDeleteResult({ catalogRevision: 6, deletedIds: [folder.id, folder.id] })).toThrow("duplicate");
  });

  test("builds encoded Trash routes", () => {
    expect(API_ROUTES.desktopTrash("desk one")).toBe("/api/desktops/desk%20one/trash");
    expect(API_ROUTES.desktopTrashRestore("desk", "entry/one")).toBe("/api/desktops/desk/trash/entry%2Fone/restore");
  });
});

describe("Trash API wrappers", () => {
  test("reports frontend-only Trash as unavailable without fetching", async () => {
    let fetched = false;
    const engine = new SyncEngine({ frontendOnly: true, fetch: (async () => { fetched = true; throw new Error("unexpected"); }) as typeof fetch });
    await expect(engine.listTrash("desk")).rejects.toBeInstanceOf(TrashUnavailableError);
    await expect(engine.restoreTrash("desk", folder.id, "root")).rejects.toBeInstanceOf(TrashUnavailableError);
    await expect(engine.permanentlyDeleteTrash("desk", folder.id)).rejects.toBeInstanceOf(TrashUnavailableError);
    expect(fetched).toBe(false);
  });

  test("uses backend methods, bodies, credentials, and idempotency headers", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const engine = new SyncEngine({ fetch: (async (input, init) => {
      requests.push({ url: String(input), init });
      if (String(input).endsWith("/restore")) return Response.json({ catalogRevision: 5, entries: [{ ...folder, parentId: null, revision: 5 }, { ...file, revision: 5 }] });
      if (init?.method === "DELETE") return Response.json({ catalogRevision: 6, deletedIds: [folder.id, file.id] });
      return Response.json({ schemaVersion: 1, catalogId: "catalog", catalogRevision: 4, desktopId: "desk", items: [{ entry: folder, deletedAt: 20, descendantCount: 1 }] });
    }) as typeof fetch });

    await engine.listTrash("desk");
    await engine.restoreTrash("desk", folder.id, "root");
    await engine.permanentlyDeleteTrash("desk", folder.id);

    expect(requests.map(({ url, init }) => [url, init?.method ?? "GET"])).toEqual([
      ["/api/desktops/desk/trash", "GET"],
      ["/api/desktops/desk/trash/folder-1/restore", "POST"],
      ["/api/desktops/desk/trash/folder-1", "DELETE"],
    ]);
    expect(requests.every(({ init }) => init?.credentials === "same-origin" && init.cache === "no-store")).toBe(true);
    expect(requests[1].init?.body).toBe(JSON.stringify({ destination: "root" }));
    const restoreHeaders = new Headers(requests[1].init?.headers);
    const deleteHeaders = new Headers(requests[2].init?.headers);
    expect(restoreHeaders.get("X-Hiraya-Client-ID")).toBeTruthy();
    expect(restoreHeaders.get("X-Hiraya-Client-ID")).toBe(deleteHeaders.get("X-Hiraya-Client-ID"));
    expect(restoreHeaders.get("X-Hiraya-Operation-ID")).not.toBe(deleteHeaders.get("X-Hiraya-Operation-ID"));
  });

  test("does not advance the observed revision or swallow restore reconciliation failures", async () => {
    let current = desktopStateSnapshot();
    let applications = 0;
    const storage = {
      loadDesktop: async () => current,
      readDesktopState: async () => current,
      applyRemoteDesktop: async (next: typeof current) => {
        applications += 1;
        if (applications > 1) throw new Error("projection failed");
        current = next;
        return current;
      },
      bindOutboxCatalog: async () => undefined,
      readOutbox: async () => [],
    } as unknown as NonNullable<SyncEngineOptions["storage"]>;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/restore") && init?.method === "POST") return Response.json({ catalogRevision: 2, entries: [{ ...folder, parentId: null, revision: 2 }] });
      if (String(input) === "/api/desktops/desk") return Response.json({ ...remoteDesktopState(), catalogRevision: applications === 0 ? 1 : 2 });
      throw new Error(`Unexpected request: ${String(input)}`);
    }) as typeof fetch;
    const engine = new SyncEngine({ storage, fetch: fetchImpl, eventSource: FakeEventSource as unknown as typeof EventSource });
    await engine.start("desk", { x: 0, y: 0 });

    const revisionBeforeRestore = Reflect.get(engine, "catalogRevision");
    await expect(engine.restoreTrash("desk", folder.id, "root")).rejects.toThrow("projection failed");
    expect(Reflect.get(engine, "catalogRevision")).toBe(revisionBeforeRestore);
    await engine.stop();
  });
});
