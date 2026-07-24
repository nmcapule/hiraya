import { describe, expect, test } from "bun:test";
import type { AppPermission, FileHandle, FolderHandle } from "@hiraya/apps-contracts";
import { CapabilityStore, type FileCapabilityOperation } from "../src/apps/host/capability-store";
import { FileService, FileServiceError, type FileSyncFunctions } from "../src/apps/host/file-service";
import { ContentRevisionConflictError, type DesktopStateSnapshot } from "../src/lib/opfs";
import { grantPickedFiles, grantPickedFolder } from "../src/apps/host/picker-grants";
import type { DesktopEntry, FileEntry, FolderEntry } from "../src/types";
import { desktopStateSnapshot } from "./fixtures";

function fixture() {
  const folder: FolderEntry = { kind: "folder", id: "folder-id", name: "Folder", parentId: null, createdAt: 1, modifiedAt: 1, position: { x: 1, y: 2 } };
  const nested: FileEntry = { kind: "file", id: "nested-id", name: "nested.bin", parentId: folder.id, createdAt: 1, modifiedAt: 2, position: { x: 3, y: 4 }, mimeType: "application/octet-stream", size: 3 };
  const unrelated: FileEntry = { kind: "file", id: "secret-id", name: "secret.txt", parentId: null, createdAt: 1, modifiedAt: 2, position: { x: 5, y: 6 }, mimeType: "text/plain", size: 6 };
  let snapshot: DesktopStateSnapshot = { ...desktopStateSnapshot(), entries: [folder, nested, unrelated], sync: { ...desktopStateSnapshot().sync, contentRevisions: { [nested.id]: 7, [unrelated.id]: 2 } } };
  const contents = new Map([[nested.id, new Blob([new Uint8Array([0, 128, 255])], { type: nested.mimeType })], [unrelated.id, new Blob(["secret"])]]);
  const calls: string[] = [];
  const replace = (next: DesktopEntry) => { snapshot = { ...snapshot, entries: snapshot.entries.map((entry) => entry.id === next.id ? next : entry) }; return next; };
  const sync: FileSyncFunctions = {
    readFile: async (id) => { calls.push(`read:${id}`); return contents.get(id)!; },
    saveFile: async (id, content, options) => {
      calls.push(`write:${id}`);
      const actual = snapshot.sync.contentRevisions[id] ?? 0;
      if (options?.expectedContentRevision !== undefined && options.expectedContentRevision !== actual) throw new ContentRevisionConflictError(options.expectedContentRevision, actual);
      contents.set(id, content);
      const current = snapshot.entries.find((entry): entry is FileEntry => entry.id === id && entry.kind === "file")!;
      snapshot = { ...snapshot, sync: { ...snapshot.sync, contentRevisions: { ...snapshot.sync.contentRevisions, [id]: actual + 1 } } };
      return replace({ ...current, size: content.size, mimeType: options?.mimeType ?? current.mimeType, modifiedAt: current.modifiedAt + 1 }) as FileEntry;
    },
    createFile: async (name, parentId, position, content, mimeType) => {
      calls.push("create-file");
      const entry: FileEntry = { kind: "file", id: `new-file-${calls.length}`, name, parentId, position, size: content.size, mimeType: mimeType ?? content.type, createdAt: 3, modifiedAt: 3 };
      contents.set(entry.id, content); snapshot = { ...snapshot, entries: [...snapshot.entries, entry] }; return entry;
    },
    createFolder: async (name, parentId, position) => {
      calls.push("create-folder");
      const entry: FolderEntry = { kind: "folder", id: `new-folder-${calls.length}`, name, parentId, position, createdAt: 3, modifiedAt: 3 };
      snapshot = { ...snapshot, entries: [...snapshot.entries, entry] }; return entry;
    },
    renameEntry: async (id, name) => { calls.push(`rename:${id}`); return replace({ ...snapshot.entries.find((entry) => entry.id === id)!, name }); },
    moveEntry: async (id, parentId, position) => { calls.push(`move:${id}`); return replace({ ...snapshot.entries.find((entry) => entry.id === id)!, parentId, position }); },
    deleteEntry: async (id) => { calls.push(`delete:${id}`); snapshot = { ...snapshot, entries: snapshot.entries.filter((entry) => entry.id !== id && entry.parentId !== id) }; },
  };
  const capabilities = new CapabilityStore();
  const service = (instance = "app-1", permissions: AppPermission[] = ["files:read", "files:write"]) => new FileService({ appInstanceId: instance, permissions, capabilities, getSnapshot: () => snapshot, sync });
  return { capabilities, service, calls, folder, nested, unrelated, contents, snapshot: () => snapshot };
}

async function expectCode(promise: Promise<unknown>, code: string) {
  try { await promise; } catch (error) { expect(error).toBeInstanceOf(FileServiceError); expect((error as FileServiceError).code).toBe(code); return; }
  throw new Error(`Expected ${code}.`);
}

describe("app file authority", () => {
  test("turns picker selections into instance-bound least-authority capabilities", async () => {
    const h = fixture();
    const file = grantPickedFiles(h.capabilities, "app-1", ["files:read"], [h.nested])[0];
    const folder = grantPickedFolder(h.capabilities, "app-1", ["files:read", "files:write"], h.folder);
    expect((await h.service().read({ handle: file })).data.byteLength).toBe(3);
    await expectCode(h.service().write({ handle: file, data: new ArrayBuffer(0) }), "PERMISSION_DENIED");
    expect(await h.service().createFile({ parent: folder, name: "created.bin" })).toMatchObject({ name: "created.bin" });
    await expectCode(h.service("app-2").stat({ handle: file }), "NOT_FOUND");
  });

  test("defaults launch grants to read-only file and folder access", async () => {
    const h = fixture();
    const file = h.capabilities.grantFile("app-1", h.nested.id);
    const folder = h.capabilities.grantFolder("app-1", h.folder.id);
    expect((await h.service().stat({ handle: file })).metadata.name).toBe("nested.bin");
    expect(await h.service().list({ folder })).toHaveLength(1);
    await expectCode(h.service().write({ handle: file, data: new ArrayBuffer(0) }), "PERMISSION_DENIED");
    await expectCode(h.service().createFile({ parent: folder, name: "denied.bin" }), "PERMISSION_DENIED");
  });

  test("reads, writes and lists binary files without exposing entry IDs", async () => {
    const h = fixture();
    const folderHandle = h.capabilities.grantFolder("app-1", h.folder.id, ["stat", "read", "write", "list"]);
    const listed = await h.service().list({ folder: folderHandle });
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(h.nested.id);
    const handle = listed[0].metadata.handle as FileHandle;
    const read = await h.service().read({ handle });
    expect([...new Uint8Array(read.data)]).toEqual([0, 128, 255]);
    const saved = await h.service().write({ handle, data: new Uint8Array([255, 0, 127]).buffer, mimeType: "image/png", expectedRevision: 7 });
    expect(saved).toMatchObject({ mimeType: "image/png", size: 3, contentRevision: 8 });
    expect([...new Uint8Array(await h.contents.get(h.nested.id)!.arrayBuffer())]).toEqual([255, 0, 127]);
  });

  test("rejects forged, cross-instance and revoked handles without leaking entries", async () => {
    const h = fixture();
    const handle = h.capabilities.grantFile("app-1", h.nested.id);
    await expectCode(h.service().stat({ handle: "file_1234567890123456" as FileHandle }), "NOT_FOUND");
    await expectCode(h.service("app-2").stat({ handle }), "NOT_FOUND");
    h.capabilities.revoke(handle);
    await expectCode(h.service().stat({ handle }), "NOT_FOUND");
    expect(h.calls).toEqual([]);
  });

  test("confines listing and derived handles to the granted folder ancestry", async () => {
    const h = fixture();
    const folder = h.capabilities.grantFolder("app-1", h.folder.id);
    expect((await h.service().list({ folder })).map((entry) => entry.metadata.name)).toEqual(["nested.bin"]);
    const unrelated = h.capabilities.grantFile("app-1", h.unrelated.id, ["stat"]);
    const forgedScope = h.capabilities.derive("app-1", folder, "file", h.unrelated.id) as FileHandle;
    await expectCode(h.service().stat({ handle: forgedScope }), "NOT_FOUND");
    expect((await h.service().stat({ handle: unrelated })).metadata.name).toBe("secret.txt");
  });

  test("enforces app permissions and every operation grant", async () => {
    const operations: FileCapabilityOperation[] = ["stat", "read", "write", "rename", "move", "delete"];
    for (const operation of operations) {
      const h = fixture();
      const handle = h.capabilities.grantFile("app-1", h.nested.id, operations.filter((candidate) => candidate !== operation));
      const service = h.service();
      const calls: Record<typeof operation, () => Promise<unknown>> = {
        stat: () => service.stat({ handle }), read: () => service.read({ handle }),
        write: () => service.write({ handle, data: new ArrayBuffer(0) }), rename: () => service.rename({ handle, name: "new.bin" }),
        move: () => service.move({ handle, parent: null }), delete: () => service.delete({ handle }),
      };
      await expectCode(calls[operation](), "PERMISSION_DENIED");
    }
    const h = fixture();
    const handle = h.capabilities.grantFile("app-1", h.nested.id);
    await expectCode(h.service("app-1", []).read({ handle }), "PERMISSION_DENIED");
    await expectCode(h.service("app-1", ["files:read"]).write({ handle, data: new ArrayBuffer(0) }), "PERMISSION_DENIED");
  });

  test("denies list, create and move destinations without folder grants", async () => {
    const h = fixture();
    const noList = h.capabilities.grantFolder("app-1", h.folder.id, ["stat"]);
    await expectCode(h.service().list({ folder: noList }), "PERMISSION_DENIED");
    await expectCode(h.service().createFile({ parent: noList, name: "x", data: new ArrayBuffer(0) }), "PERMISSION_DENIED");
    await expectCode(h.service().createFolder({ parent: null, name: "x" }), "PERMISSION_DENIED");
    const file = h.capabilities.grantFile("app-1", h.nested.id, ["move"]);
    await expectCode(h.service().move({ handle: file, parent: null }), "PERMISSION_DENIED");
  });

  test("creates, renames, moves and recursively deletes through granted folders", async () => {
    const h = fixture();
    const root = h.capabilities.grantFolder("app-1", null, ["stat", "read", "write", "list", "create", "rename", "move", "delete"]);
    const folder = await h.service().createFolder({ parent: root, name: "Created" });
    const file = await h.service().createFile({ parent: folder.handle, name: "data.bin", data: new Uint8Array([1, 2]).buffer });
    expect((await h.service().rename({ handle: file.handle, name: "renamed.bin" })).metadata.name).toBe("renamed.bin");
    expect((await h.service().move({ handle: file.handle, parent: root })).metadata.parent).toBeNull();
    await h.service().delete({ handle: folder.handle, recursive: true });
    expect(h.calls).toContain("create-file");
  });

  test("maps stale expected revisions to CONFLICT before writing", async () => {
    const h = fixture();
    const handle = h.capabilities.grantFile("app-1", h.nested.id, ["stat", "read", "write"]);
    await expectCode(h.service().write({ handle, data: new ArrayBuffer(1), expectedRevision: 6 }), "CONFLICT");
    expect(h.snapshot().sync.contentRevisions[h.nested.id]).toBe(7);
  });

  test("rejects file/folder kind confusion", async () => {
    const h = fixture();
    const folder = h.capabilities.grantFolder("app-1", h.folder.id);
    await expectCode(h.service().read({ handle: folder as unknown as FileHandle }), "NOT_FOUND");
    const file = h.capabilities.grantFile("app-1", h.nested.id);
    await expectCode(h.service().list({ folder: file as unknown as FolderHandle }), "NOT_FOUND");
  });
});
