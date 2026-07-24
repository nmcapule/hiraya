export function storageWorkerName(frontendOnly: boolean, namespace: string, buildTimestamp: string): string {
  const buildId = buildTimestamp.replace(/[^a-zA-Z0-9_-]/g, "-");
  if (!buildId) throw new Error("The storage worker requires a build identity.");
  return frontendOnly ? `hiraya-storage-${buildId}` : `hiraya-storage-${buildId}-${namespace}`;
}
