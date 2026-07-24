import type { FileHandle, FolderHandle } from "@hiraya/apps-contracts";

export type FileCapabilityOperation = "stat" | "read" | "write" | "list" | "create" | "rename" | "move" | "delete";
export type FileCapabilityHandle = FileHandle | FolderHandle;

export type ResolvedFileCapability = {
  handle: FileCapabilityHandle;
  kind: "file" | "folder";
  entryId: string | null;
  scopeEntryId: string | null;
  operations: ReadonlySet<FileCapabilityOperation>;
};

type CapabilityRecord = ResolvedFileCapability & {
  appInstanceId: string;
  revoked: boolean;
};

const DEFAULT_FILE_OPERATIONS: readonly FileCapabilityOperation[] = ["stat", "read"];
const DEFAULT_FOLDER_OPERATIONS: readonly FileCapabilityOperation[] = ["stat", "list"];

export class CapabilityStore {
  private readonly records = new Map<FileCapabilityHandle, CapabilityRecord>();

  grantFile(appInstanceId: string, entryId: string, operations: Iterable<FileCapabilityOperation> = DEFAULT_FILE_OPERATIONS): FileHandle {
    return this.grant(appInstanceId, "file", entryId, entryId, operations) as FileHandle;
  }

  grantFolder(appInstanceId: string, entryId: string | null, operations: Iterable<FileCapabilityOperation> = DEFAULT_FOLDER_OPERATIONS): FolderHandle {
    return this.grant(appInstanceId, "folder", entryId, entryId, operations) as FolderHandle;
  }

  derive(appInstanceId: string, source: FileCapabilityHandle, kind: "file" | "folder", entryId: string): FileCapabilityHandle {
    const parent = this.lookup(appInstanceId, source);
    return this.grant(appInstanceId, kind, entryId, parent.scopeEntryId, parent.operations);
  }

  resolve(appInstanceId: string, handle: FileCapabilityHandle, operation: FileCapabilityOperation, kind?: "file" | "folder"): ResolvedFileCapability | null {
    const record = this.inspect(appInstanceId, handle, kind);
    if (!record) return null;
    if (!record.operations.has(operation)) return null;
    return record;
  }

  inspect(appInstanceId: string, handle: FileCapabilityHandle, kind?: "file" | "folder"): ResolvedFileCapability | null {
    const record = this.records.get(handle);
    if (!record || record.revoked || record.appInstanceId !== appInstanceId || kind && record.kind !== kind) return null;
    return record;
  }

  find(appInstanceId: string, entryId: string | null, kind: "file" | "folder", operation: FileCapabilityOperation): FileCapabilityHandle | null {
    for (const record of this.records.values()) {
      if (!record.revoked && record.appInstanceId === appInstanceId && record.entryId === entryId && record.kind === kind && record.operations.has(operation)) return record.handle;
    }
    return null;
  }

  revoke(handle: FileCapabilityHandle) {
    const record = this.records.get(handle);
    if (record) record.revoked = true;
  }

  revokeInstance(appInstanceId: string) {
    for (const record of this.records.values()) if (record.appInstanceId === appInstanceId) record.revoked = true;
  }

  private lookup(appInstanceId: string, handle: FileCapabilityHandle) {
    const record = this.records.get(handle);
    if (!record || record.revoked || record.appInstanceId !== appInstanceId) throw new Error("Invalid file capability.");
    return record;
  }

  private grant(appInstanceId: string, kind: "file" | "folder", entryId: string | null, scopeEntryId: string | null, operations: Iterable<FileCapabilityOperation>) {
    if (!appInstanceId || kind === "file" && entryId === null) throw new Error("Invalid file capability grant.");
    const handle = `${kind}_${crypto.randomUUID().replaceAll("-", "")}` as FileCapabilityHandle;
    const record: CapabilityRecord = { handle, appInstanceId, kind, entryId, scopeEntryId, operations: new Set(operations), revoked: false };
    this.records.set(handle, record);
    return handle;
  }
}
