import type { AppPermission, FileHandle, FolderHandle } from "@hiraya/apps-contracts";
import type { DesktopEntry } from "../../types";
import { CapabilityStore, type FileCapabilityOperation } from "./capability-store";

export function grantPickedFiles(capabilities: CapabilityStore, instanceId: string, permissions: Iterable<AppPermission>, entries: readonly DesktopEntry[]): FileHandle[] {
  const writable = new Set(permissions).has("files:write");
  const operations: FileCapabilityOperation[] = writable ? ["stat", "read", "write"] : ["stat", "read"];
  return entries.map((entry) => {
    if (entry.kind !== "file") throw new TypeError("The file picker can only grant files.");
    return capabilities.grantFile(instanceId, entry.id, operations);
  });
}

export function grantPickedFolder(capabilities: CapabilityStore, instanceId: string, permissions: Iterable<AppPermission>, entry: DesktopEntry | null): FolderHandle {
  if (entry && entry.kind !== "folder") throw new TypeError("The folder picker can only grant folders.");
  const writable = new Set(permissions).has("files:write");
  const operations: FileCapabilityOperation[] = writable
    ? ["stat", "read", "write", "list", "create", "rename", "move", "delete"]
    : ["stat", "read", "list"];
  return capabilities.grantFolder(instanceId, entry?.id ?? null, operations);
}
