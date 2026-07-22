import type { DesktopIdentity } from "../types";
import { assertValidId, isRecord, isValidId, normalizeDesktopName, readRevision } from "./contracts";
import type { PersistedManifestV13 } from "./manifest-codec";

export type RemoteDesktopIdentity = DesktopIdentity & { revision: number };
export type RemoteDesktopCatalog = {
  revision: number;
  defaultDesktopId: string;
  desktops: RemoteDesktopIdentity[];
};

export function parseDesktopCatalog(value: unknown): RemoteDesktopCatalog {
  if (!isRecord(value) || !Array.isArray(value.desktops)) throw new Error("The server desktop catalog has an unsupported format.");
  assertValidId(value.defaultDesktopId, "The server desktop catalog has an invalid default desktop ID.");
  const desktops = value.desktops.map((candidate): RemoteDesktopIdentity => {
    if (!isRecord(candidate)) throw new Error("A server desktop has an unsupported format.");
    assertValidId(candidate.id, "A server desktop has an invalid ID.");
    return {
      id: candidate.id,
      name: normalizeDesktopName(typeof candidate.name === "string" ? candidate.name : ""),
      revision: readRevision(candidate.revision, "A server desktop has an invalid revision."),
    };
  });
  if (new Set(desktops.map((desktop) => desktop.id)).size !== desktops.length) throw new Error("The server desktop catalog contains duplicate IDs.");
  if (new Set(desktops.map((desktop) => desktop.name.toLocaleLowerCase())).size !== desktops.length) throw new Error("The server desktop catalog contains duplicate names.");
  if (!desktops.some((desktop) => desktop.id === value.defaultDesktopId)) throw new Error("The server default desktop does not exist.");
  return { revision: readRevision(value.revision), defaultDesktopId: value.defaultDesktopId, desktops };
}

export function desktopIdForManifest(manifest: PersistedManifestV13, fallbackId: string) {
  return isValidId(manifest.sync.workspaceId) ? manifest.sync.workspaceId : fallbackId;
}

export function canAdoptFreshPlaceholder(options: {
  adoptablePlaceholder: boolean;
  desktopCount: number;
  entryCount: number;
  outboxCount: number;
  workspaceId: string | null;
}) {
  return options.adoptablePlaceholder
    && options.desktopCount === 1
    && options.entryCount === 0
    && options.outboxCount === 0
    && options.workspaceId === null;
}

export function resolveDesktopContext(requestedId: string | null, desktops: readonly DesktopIdentity[], migrationFallbackId: string | null) {
  if (requestedId && desktops.some((desktop) => desktop.id === requestedId)) return requestedId;
  if (migrationFallbackId && desktops.some((desktop) => desktop.id === migrationFallbackId)) return migrationFallbackId;
  return desktops[0]?.id ?? null;
}

export function desktopDeleteProtection(desktopId: string, defaultDesktopId: string, desktopCount: number) {
  if (desktopId === defaultDesktopId) return "The default desktop is reserved for older clients and cannot be deleted.";
  if (desktopCount === 1) return "The last desktop cannot be deleted.";
  return "";
}
