import type { PersistedDesktopState } from "./desktop-state";
import type { OutboxOperation, OutboxRecord } from "./outbox";
import type { WindowSession } from "./window-session";
import type { ActivityPage, ActivityQuery, NewActivityRecord } from "./activity";
import type { DesktopIdentity } from "../types";
import type { InstalledApp } from "../apps/installed-apps";
import type { JsonValue } from "@hiraya/apps-contracts";

export type StoredPreferences = { autoUpdate: boolean; externalEmbeddedPreviews: boolean };

export type StorageDbRequests = {
  ping: undefined;
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
