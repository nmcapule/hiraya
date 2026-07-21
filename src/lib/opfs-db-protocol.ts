import type { PersistedManifestV13 } from "./manifest-codec";
import type { OutboxOperation, OutboxRecord } from "./outbox";

export type StoredPreferences = { autoUpdate: boolean };

export type StorageDbRequests = {
  ping: undefined;
  status: undefined;
  bootstrap: { manifest: PersistedManifestV13; preferences: StoredPreferences };
  readManifest: undefined;
  replaceManifest: { manifest: PersistedManifestV13 };
  readPreferences: undefined;
  writePreferences: { preferences: StoredPreferences };
  reserveOperation: undefined;
  enqueueMutation: { operationId: string; workspaceId: string | null; operation: OutboxOperation };
  readOutbox: undefined;
  bindOutboxWorkspace: { workspaceId: string };
  applyRemoteWithOutbox: { manifest: PersistedManifestV13; acknowledgedOperationId?: string };
  acknowledgeMutation: { operationId: string };
  blockMutation: { operationId: string; error: string };
};

export type StorageDbResponses = {
  ping: undefined;
  status: { existedBeforeOpen: boolean; needsBootstrap: boolean };
  bootstrap: { manifest: PersistedManifestV13; preferences: StoredPreferences };
  readManifest: PersistedManifestV13;
  replaceManifest: undefined;
  readPreferences: StoredPreferences;
  writePreferences: undefined;
  reserveOperation: { clientId: string; operationId: string; sequence: number };
  enqueueMutation: { manifest: PersistedManifestV13; record: OutboxRecord };
  readOutbox: OutboxRecord[];
  bindOutboxWorkspace: undefined;
  applyRemoteWithOutbox: { manifest: PersistedManifestV13; blocked: OutboxRecord[] };
  acknowledgeMutation: undefined;
  blockMutation: undefined;
};

export type StorageDbMethod = keyof StorageDbRequests;

export type StorageDbRequest<M extends StorageDbMethod = StorageDbMethod> = {
  id: number;
  method: M;
  params: StorageDbRequests[M];
};

export type StorageDbResponse = {
  id: number;
  result?: unknown;
  error?: string;
};
