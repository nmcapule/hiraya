import type {
  AppPermission,
  DirectoryEntry,
  FileHandle,
  FileMetadata,
  FolderHandle,
  FolderMetadata,
  HirayaErrorCode,
  ServiceMethods,
} from "@hiraya/apps-contracts";
import type { DesktopStateSnapshot, SaveFileOptions } from "../../lib/opfs";
import { ContentRevisionConflictError } from "../../lib/opfs";
import type { DesktopEntry, EntryPosition, FileEntry, FolderEntry } from "../../types";
import { CapabilityStore, type FileCapabilityHandle, type FileCapabilityOperation, type ResolvedFileCapability } from "./capability-store";

type Params<M extends keyof ServiceMethods> = ServiceMethods[M]["params"];
type Result<M extends keyof ServiceMethods> = ServiceMethods[M]["result"];

export type FileSyncFunctions = {
  readFile(id: string): Promise<Blob>;
  saveFile(id: string, content: Blob, options?: SaveFileOptions): Promise<FileEntry>;
  createFile(name: string, parentId: string | null, position: EntryPosition, content: Blob, mimeType?: string): Promise<FileEntry>;
  createFolder(name: string, parentId: string | null, position: EntryPosition): Promise<FolderEntry>;
  renameEntry(id: string, name: string): Promise<DesktopEntry>;
  moveEntry(id: string, parentId: string | null, position: EntryPosition): Promise<DesktopEntry>;
  deleteEntry(id: string): Promise<unknown>;
};

export type FileServiceOptions = {
  appInstanceId: string;
  permissions: Iterable<AppPermission>;
  capabilities: CapabilityStore;
  getSnapshot: () => DesktopStateSnapshot;
  sync: FileSyncFunctions;
  createPosition?: () => EntryPosition;
};

export class FileServiceError extends Error {
  constructor(readonly code: HirayaErrorCode, message: string) {
    super(message);
    this.name = "FileServiceError";
  }
}

export class FileService {
  private readonly permissions: ReadonlySet<AppPermission>;
  private readonly createPosition: () => EntryPosition;

  constructor(private readonly options: FileServiceOptions) {
    this.permissions = new Set(options.permissions);
    this.createPosition = options.createPosition ?? (() => ({ x: 0, y: 0 }));
  }

  async stat(params: Params<"files.stat">): Promise<Result<"files.stat">> {
    return this.protect(async () => {
      this.requirePermission("files:read");
      const capability = this.requireHandle(params.handle, "stat");
      return this.publicEntry(this.requireEntry(capability), capability);
    });
  }

  async read(params: Params<"files.read">): Promise<Result<"files.read">> {
    return this.protect(async () => {
      this.requirePermission("files:read");
      const capability = this.requireHandle(params.handle, "read", "file");
      const entry = this.requireEntry(capability, "file") as FileEntry;
      const blob = await this.options.sync.readFile(entry.id);
      return { data: await blob.arrayBuffer(), mimeType: entry.mimeType };
    });
  }

  async write(params: Params<"files.write">): Promise<Result<"files.write">> {
    return this.protect(async () => {
      this.requirePermission("files:write");
      const capability = this.requireHandle(params.handle, "write", "file");
      const entry = this.requireEntry(capability, "file") as FileEntry;
      const saved = await this.options.sync.saveFile(entry.id, new Blob([params.data], { type: params.mimeType ?? entry.mimeType }), {
        mimeType: params.mimeType,
        expectedContentRevision: params.expectedRevision,
      });
      return this.fileMetadata(saved, capability);
    });
  }

  async list(params: Params<"files.list">): Promise<Result<"files.list">> {
    return this.protect(async () => {
      this.requirePermission("files:read");
      const capability = params.folder === null
        ? this.requireRoot("list")
        : this.requireHandle(params.folder, "list", "folder");
      if (capability.entryId !== null) this.requireEntry(capability, "folder");
      return this.snapshot().entries.filter((entry) => entry.parentId === capability.entryId).map((entry) => {
        const handle = this.options.capabilities.derive(this.options.appInstanceId, capability.handle, entry.kind, entry.id);
        return this.publicEntry(entry, { ...capability, handle, kind: entry.kind, entryId: entry.id });
      });
    });
  }

  async createFile(params: Params<"files.createFile">): Promise<Result<"files.createFile">> {
    return this.protect(async () => {
      this.requirePermission("files:write");
      const parent = this.parentCapability(params.parent, "create");
      const blob = new Blob([params.data ?? new ArrayBuffer(0)], { type: params.mimeType ?? "application/octet-stream" });
      const entry = await this.options.sync.createFile(params.name, parent.entryId, this.createPosition(), blob, params.mimeType);
      const handle = this.options.capabilities.derive(this.options.appInstanceId, parent.handle, "file", entry.id) as FileHandle;
      return this.fileMetadata(entry, { ...parent, handle, kind: "file", entryId: entry.id });
    });
  }

  async createFolder(params: Params<"files.createFolder">): Promise<Result<"files.createFolder">> {
    return this.protect(async () => {
      this.requirePermission("files:write");
      const parent = this.parentCapability(params.parent, "create");
      const entry = await this.options.sync.createFolder(params.name, parent.entryId, this.createPosition());
      const handle = this.options.capabilities.derive(this.options.appInstanceId, parent.handle, "folder", entry.id) as FolderHandle;
      return this.folderMetadata(entry, { ...parent, handle, kind: "folder", entryId: entry.id });
    });
  }

  async rename(params: Params<"files.rename">): Promise<Result<"files.rename">> {
    return this.mutateEntry(params.handle, "rename", (entry) => this.options.sync.renameEntry(entry.id, params.name));
  }

  async move(params: Params<"files.move">): Promise<Result<"files.move">> {
    return this.protect(async () => {
      this.requirePermission("files:write");
      const capability = this.requireHandle(params.handle, "move");
      const entry = this.requireEntry(capability);
      const parent = this.parentCapability(params.parent, "create");
      const moved = await this.options.sync.moveEntry(entry.id, parent.entryId, entry.position);
      return this.publicEntry(moved, capability);
    });
  }

  async delete(params: Params<"files.delete">): Promise<void> {
    return this.protect(async () => {
      this.requirePermission("files:write");
      const capability = this.requireHandle(params.handle, "delete");
      const entry = this.requireEntry(capability);
      if (entry.kind === "folder" && this.snapshot().entries.some((candidate) => candidate.parentId === entry.id) && !params.recursive) {
        throw new FileServiceError("CONFLICT", "The folder is not empty.");
      }
      await this.options.sync.deleteEntry(entry.id);
      this.options.capabilities.revoke(params.handle);
    });
  }

  private async mutateEntry(handle: FileCapabilityHandle, operation: FileCapabilityOperation, mutation: (entry: DesktopEntry) => Promise<DesktopEntry>) {
    return this.protect(async () => {
      this.requirePermission("files:write");
      const capability = this.requireHandle(handle, operation);
      return this.publicEntry(await mutation(this.requireEntry(capability)), capability);
    });
  }

  private parentCapability(handle: FolderHandle | null, operation: FileCapabilityOperation) {
    const capability = handle === null ? this.requireRoot(operation) : this.requireHandle(handle, operation, "folder");
    if (capability.entryId !== null) this.requireEntry(capability, "folder");
    return capability;
  }

  private requireRoot(operation: FileCapabilityOperation) {
    const handle = this.options.capabilities.find(this.options.appInstanceId, null, "folder", operation);
    if (!handle) throw new FileServiceError("PERMISSION_DENIED", "Access to that location was not granted.");
    return this.requireHandle(handle, operation, "folder");
  }

  private requireHandle(handle: FileCapabilityHandle, operation: FileCapabilityOperation, kind?: "file" | "folder") {
    const granted = this.options.capabilities.inspect(this.options.appInstanceId, handle, kind);
    if (!granted) throw new FileServiceError("NOT_FOUND", "The file handle is unavailable.");
    const capability = this.options.capabilities.resolve(this.options.appInstanceId, handle, operation, kind);
    if (!capability) throw new FileServiceError("PERMISSION_DENIED", "The handle was not granted for this operation.");
    return capability;
  }

  private requireEntry(capability: ResolvedFileCapability, kind?: "file" | "folder") {
    const entry = capability.entryId === null ? undefined : this.snapshot().entries.find((candidate) => candidate.id === capability.entryId);
    if (!entry || entry.kind !== capability.kind || kind && entry.kind !== kind || !this.inScope(entry.id, capability.scopeEntryId)) {
      throw new FileServiceError("NOT_FOUND", "The file handle is unavailable.");
    }
    return entry;
  }

  private inScope(entryId: string, scopeEntryId: string | null) {
    if (scopeEntryId === null) return true;
    const entries = this.snapshot().entries;
    let current = entries.find((entry) => entry.id === entryId);
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      if (current.id === scopeEntryId) return true;
      seen.add(current.id);
      current = current.parentId === null ? undefined : entries.find((entry) => entry.id === current!.parentId);
    }
    return false;
  }

  private publicEntry(entry: DesktopEntry, capability: ResolvedFileCapability): DirectoryEntry {
    return entry.kind === "file"
      ? { kind: "file", metadata: this.fileMetadata(entry, capability) }
      : { kind: "folder", metadata: this.folderMetadata(entry, capability) };
  }

  private fileMetadata(entry: FileEntry, capability: ResolvedFileCapability): FileMetadata {
    return {
      handle: capability.handle as FileHandle,
      name: entry.name,
      mimeType: entry.mimeType,
      size: entry.size,
      modifiedAt: entry.modifiedAt,
      parent: this.parentHandle(entry.parentId, capability),
      contentRevision: this.snapshot().sync.contentRevisions[entry.id] ?? 0,
    };
  }

  private folderMetadata(entry: FolderEntry, capability: ResolvedFileCapability): FolderMetadata {
    return { handle: capability.handle as FolderHandle, name: entry.name, modifiedAt: entry.modifiedAt, parent: this.parentHandle(entry.parentId, capability) };
  }

  private parentHandle(parentId: string | null, capability: ResolvedFileCapability) {
    if (parentId === null) return null;
    const existing = this.options.capabilities.find(this.options.appInstanceId, parentId, "folder", "stat");
    if (existing) return existing as FolderHandle;
    if (!this.inScope(parentId, capability.scopeEntryId)) return null;
    return this.options.capabilities.derive(this.options.appInstanceId, capability.handle, "folder", parentId) as FolderHandle;
  }

  private requirePermission(permission: AppPermission) {
    if (!this.permissions.has(permission)) throw new FileServiceError("PERMISSION_DENIED", "The app does not have permission for this operation.");
  }

  private snapshot() {
    return this.options.getSnapshot();
  }

  private async protect<T>(operation: () => Promise<T> | T): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof FileServiceError) throw error;
      if (error instanceof ContentRevisionConflictError) throw new FileServiceError("CONFLICT", "The file changed since it was last read.");
      if (error instanceof DOMException && error.name === "QuotaExceededError") throw new FileServiceError("QUOTA_EXCEEDED", "There is not enough storage space.");
      const message = error instanceof Error ? error.message.toLowerCase() : "";
      if (message.includes("already exists") || message.includes("same name")) throw new FileServiceError("ALREADY_EXISTS", "An item with that name already exists.");
      if (message.includes("invalid") || message.includes("name") && message.includes("must")) throw new FileServiceError("INVALID_REQUEST", "The file request is invalid.");
      if (message.includes("offline") || message.includes("not available offline")) throw new FileServiceError("OFFLINE", "The file is unavailable offline.");
      if (message.includes("no longer exists") || message.includes("not found")) throw new FileServiceError("NOT_FOUND", "The file handle is unavailable.");
      throw new FileServiceError("INTERNAL", "The file operation failed.");
    }
  }
}
