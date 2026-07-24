export const STORAGE_PROTOCOL_VERSION = 3;

export function storageWorkerName(frontendOnly: boolean, namespace: string): string {
  return frontendOnly ? `hiraya-storage-v${STORAGE_PROTOCOL_VERSION}` : `hiraya-storage-v${STORAGE_PROTOCOL_VERSION}-${namespace}`;
}

export function storageOwnerLockName(frontendOnly: boolean, namespace: string): string {
  return frontendOnly ? "hiraya-sqlite-v1-owner" : `hiraya-sqlite-v1-owner-${namespace}`;
}
