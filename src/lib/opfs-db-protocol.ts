import type { PersistedManifestV13 } from "./manifest-codec";
import type { OutboxOperation, OutboxRecord } from "./outbox";
import type { WindowSession } from "./window-session";
import type { ActivityPage, ActivityQuery, NewActivityRecord } from "./activity";
import type { DesktopIdentity } from "../types";

export type StoredPreferences = { autoUpdate: boolean; externalEmbeddedPreviews: boolean };

export type StorageDbRequests = {
  ping: undefined;
  status: undefined;
  listDesktops: undefined;
  createDesktop: { desktop: DesktopIdentity; manifest: PersistedManifestV13 };
  renameDesktop: { desktopId: string; name: string };
  deleteDesktop: { desktopId: string };
  switchDesktop: { desktopId: string };
  adoptFreshDesktop: { desktopId: string; target: DesktopIdentity };
  readDesktop: { desktopId: string };
  transferEntries: { sourceDesktopId: string; destinationDesktopId: string; entryIds: string[]; parentId: string | null };
  enqueueTransfer: { operationId: string; workspaceId: string | null; sourceDesktopId: string; destinationDesktopId: string; entryIds: string[]; parentId: string | null };
  bootstrap: { manifest: PersistedManifestV13; preferences: StoredPreferences; adoptablePlaceholder: boolean };
  readManifest: undefined;
  replaceManifest: { manifest: PersistedManifestV13; activity?: NewActivityRecord };
  readPreferences: undefined;
  writePreferences: { preferences: StoredPreferences };
  readWindowSession: { desktopId: string };
  writeWindowSession: { desktopId: string; session: WindowSession };
  reserveOperation: undefined;
  enqueueMutation: { operationId: string; workspaceId: string | null; operation: OutboxOperation };
  readOutbox: undefined;
  bindOutboxWorkspace: { workspaceId: string };
  applyRemoteWithOutbox: { manifest: PersistedManifestV13; acknowledgedOperationId?: string };
  acknowledgeMutation: { operationId: string };
  blockMutation: { operationId: string; error: string };
  listActivity: ActivityQuery;
  pruneDesktops: { retainedDesktopIds: string[] };
};

export type StorageDbResponses = {
  ping: undefined;
  status: { existedBeforeOpen: boolean; needsBootstrap: boolean };
  listDesktops: { desktops: DesktopIdentity[]; activeDesktopId: string | null };
  createDesktop: DesktopIdentity;
  renameDesktop: DesktopIdentity;
  deleteDesktop: undefined;
  switchDesktop: PersistedManifestV13;
  adoptFreshDesktop: { adopted: boolean };
  readDesktop: PersistedManifestV13;
  transferEntries: { source: PersistedManifestV13; destination: PersistedManifestV13 };
  enqueueTransfer: { manifest: PersistedManifestV13; record: OutboxRecord };
  bootstrap: { manifest: PersistedManifestV13; preferences: StoredPreferences };
  readManifest: PersistedManifestV13;
  replaceManifest: undefined;
  readPreferences: StoredPreferences;
  writePreferences: undefined;
  readWindowSession: WindowSession;
  writeWindowSession: undefined;
  reserveOperation: { clientId: string; operationId: string; sequence: number };
  enqueueMutation: { manifest: PersistedManifestV13; record: OutboxRecord };
  readOutbox: OutboxRecord[];
  bindOutboxWorkspace: undefined;
  applyRemoteWithOutbox: { manifest: PersistedManifestV13; blocked: OutboxRecord[] };
  acknowledgeMutation: undefined;
  blockMutation: undefined;
  listActivity: ActivityPage;
  pruneDesktops: undefined;
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
