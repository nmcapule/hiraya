export const STORAGE_PROTOCOL_VERSION = 2;

export function storageWorkerName(frontendOnly: boolean, namespace: string): string {
  return frontendOnly ? `hiraya-storage-v${STORAGE_PROTOCOL_VERSION}` : `hiraya-storage-v${STORAGE_PROTOCOL_VERSION}-${namespace}`;
}

export function storageOwnerLockName(frontendOnly: boolean, namespace: string): string {
  return frontendOnly ? `hiraya-sqlite-v${STORAGE_PROTOCOL_VERSION}-owner` : `hiraya-sqlite-v${STORAGE_PROTOCOL_VERSION}-owner-${namespace}`;
}
