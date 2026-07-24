import type { PersistedDesktopState } from "./desktop-state";
import type { OutboxOperation, OutboxRecord } from "./outbox";
import type { WindowSession } from "./window-session";
import type { ActivityPage, ActivityQuery, NewActivityRecord } from "./activity";
import type { DesktopIdentity } from "../types";
import type { InstalledApp } from "../apps/installed-apps";
import type { JsonValue } from "@hiraya/apps-contracts";
import { isValidId } from "./contracts";
import { STORAGE_PROTOCOL_VERSION } from "./storage-worker";

export type StoredPreferences = { autoUpdate: boolean; externalEmbeddedPreviews: boolean; searchAllDesktops: boolean; onboardingVersion: number };

export type StorageDbRequests = {
  ping: undefined;
  protocol: undefined;
  status: undefined;
  listDesktops: undefined;
  createDesktop: { desktop: DesktopIdentity; state: PersistedDesktopState };
  createOfflineDesktop: { desktop: DesktopIdentity; state: PersistedDesktopState };
  renameDesktop: { desktopId: string; name: string };
  updateDesktopIdentity: { desktop: DesktopIdentity };
  deleteDesktop: { desktopId: string };
  readDesktop: { desktopId: string };
  transferEntries: { sourceDesktopId: string; destinationDesktopId: string; entryIds: string[]; parentId: string | null };
  enqueueTransfer: { operationId: string; catalogId: string | null; sourceDesktopId: string; destinationDesktopId: string; entryIds: string[]; parentId: string | null };
  replaceDesktopState: { state: PersistedDesktopState; activity?: NewActivityRecord };
  readPreferences: undefined;
  writePreferences: { preferences: StoredPreferences };
  readWindowSession: { desktopId: string };
  writeWindowSession: { desktopId: string; session: WindowSession };
  reserveOperation: undefined;
  enqueueMutation: { operationId: string; catalogId: string | null; operation: OutboxOperation };
  readOutbox: undefined;
  bindOutboxCatalog: { catalogId: string };
  applyRemoteWithOutbox: { state: PersistedDesktopState; acknowledgedOperationId?: string };
  acknowledgeMutation: { operationId: string };
  blockMutation: { operationId: string; error: string };
  listActivity: ActivityQuery;
  pruneDesktops: { retainedDesktopIds: string[] };
  listOfflinePins: { desktopId: string };
  setOfflinePins: { desktopId: string; entryIds: string[]; pinned: boolean; createdAt: number };
  listInstalledApps: undefined;
  installApp: { install: InstalledApp };
  uninstallApp: { appId: string };
  readAppStorage: { appId: string; key: string };
  writeAppStorage: { appId: string; key: string; value: JsonValue; maxBytes: number; maxEntries: number };
  removeAppStorage: { appId: string; key: string };
  clearAppStorage: { appId: string };
};

export type StorageDbResponses = {
  ping: undefined;
  protocol: { version: number };
  status: { existedBeforeOpen: boolean };
  listDesktops: { desktops: DesktopIdentity[] };
  createDesktop: DesktopIdentity;
  createOfflineDesktop: { desktop: DesktopIdentity; record: OutboxRecord };
  renameDesktop: DesktopIdentity;
  updateDesktopIdentity: DesktopIdentity;
  deleteDesktop: undefined;
  readDesktop: PersistedDesktopState;
  transferEntries: { source: PersistedDesktopState; destination: PersistedDesktopState };
  enqueueTransfer: { state: PersistedDesktopState; record: OutboxRecord };
  replaceDesktopState: undefined;
  readPreferences: StoredPreferences;
  writePreferences: undefined;
  readWindowSession: WindowSession;
  writeWindowSession: undefined;
  reserveOperation: { clientId: string; operationId: string; sequence: number };
  enqueueMutation: { state: PersistedDesktopState; record: OutboxRecord };
  readOutbox: OutboxRecord[];
  bindOutboxCatalog: undefined;
  applyRemoteWithOutbox: { state: PersistedDesktopState; blocked: OutboxRecord[] };
  acknowledgeMutation: undefined;
  blockMutation: undefined;
  listActivity: ActivityPage;
  pruneDesktops: undefined;
  listOfflinePins: { desktopId: string; entryIds: string[] };
  setOfflinePins: { desktopId: string; entryIds: string[] };
  listInstalledApps: InstalledApp[];
  installApp: InstalledApp;
  uninstallApp: undefined;
  readAppStorage: JsonValue | undefined;
  writeAppStorage: undefined;
  removeAppStorage: undefined;
  clearAppStorage: undefined;
};

export type StorageDbMethod = keyof StorageDbRequests;

export type StorageDbRequest<M extends StorageDbMethod = StorageDbMethod> = {
  id: number;
  desktopId: string | null;
  method: M;
  params: StorageDbRequests[M];
};

export type StorageDbResponse = {
  id: number;
  result?: unknown;
  error?: string;
};

export function createStorageDbRequest<M extends StorageDbMethod>(id: number, desktopId: string | null, method: M, params: StorageDbRequests[M]): StorageDbRequest<M> {
  return { id, desktopId, method, params };
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).sort().join("\n") === [...keys].sort().join("\n");
}

export function validateOfflinePinRequest(method: "listOfflinePins" | "setOfflinePins", params: unknown, requestDesktopId: string | null) {
  const keys = method === "listOfflinePins" ? ["desktopId"] : ["createdAt", "desktopId", "entryIds", "pinned"];
  if (!exactRecord(params, keys) || !isValidId(params.desktopId) || params.desktopId !== requestDesktopId) throw new Error("The offline pin request has an invalid desktop binding.");
  if (method === "listOfflinePins") return;
  if (!Array.isArray(params.entryIds) || params.entryIds.some((id) => !isValidId(id)) || new Set(params.entryIds).size !== params.entryIds.length || typeof params.pinned !== "boolean" || !Number.isSafeInteger(params.createdAt) || Number(params.createdAt) < 0) {
    throw new Error("The offline pin request is invalid.");
  }
}

export function parseOfflinePinResponse(value: unknown, expectedDesktopId: string) {
  if (!exactRecord(value, ["desktopId", "entryIds"]) || value.desktopId !== expectedDesktopId || !Array.isArray(value.entryIds) || value.entryIds.some((id) => !isValidId(id)) || new Set(value.entryIds).size !== value.entryIds.length) {
    throw new Error("The local storage worker returned an invalid offline-pin response. Reload Hiraya and close any older Hiraya tabs.");
  }
  return [...value.entryIds] as string[];
}

export function parseStorageProtocol(value: unknown) {
  if (!exactRecord(value, ["version"]) || value.version !== STORAGE_PROTOCOL_VERSION) throw new Error("The local storage worker protocol is outdated. Reload Hiraya and close any older Hiraya tabs.");
  return STORAGE_PROTOCOL_VERSION;
}
