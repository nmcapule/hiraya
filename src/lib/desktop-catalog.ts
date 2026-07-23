import type { DesktopIdentity } from "../types";
import { assertValidId, isRecord, normalizeDesktopName, readRevision } from "./contracts";

export type RemoteDesktopIdentity = DesktopIdentity;
export type RemoteDesktopCatalog = {
  schemaVersion: 1;
  catalogId: string;
  catalogRevision: number;
  desktops: RemoteDesktopIdentity[];
};

export function parseDesktopCatalog(value: unknown): RemoteDesktopCatalog {
  if (!isRecord(value) || !Array.isArray(value.desktops)) throw new Error("The server desktop catalog has an unsupported format.");
  if (value.schemaVersion !== 1) throw new Error("The server catalog uses an unsupported schema version.");
  assertValidId(value.catalogId, "The server catalog has an invalid ID.");
  const desktops = value.desktops.map((candidate): RemoteDesktopIdentity => {
    if (!isRecord(candidate)) throw new Error("A server desktop has an unsupported format.");
    assertValidId(candidate.id, "A server desktop has an invalid ID.");
    return {
      id: candidate.id,
      name: normalizeDesktopName(typeof candidate.name === "string" ? candidate.name : ""),
    };
  });
  if (new Set(desktops.map((desktop) => desktop.id)).size !== desktops.length) throw new Error("The server desktop catalog contains duplicate IDs.");
  if (new Set(desktops.map((desktop) => desktop.name.toLocaleLowerCase())).size !== desktops.length) throw new Error("The server desktop catalog contains duplicate names.");
  return { schemaVersion: 1, catalogId: value.catalogId, catalogRevision: readRevision(value.catalogRevision), desktops };
}

export function resolveDesktopContext(requestedId: string | null, desktops: readonly DesktopIdentity[]) {
  if (requestedId && desktops.some((desktop) => desktop.id === requestedId)) return requestedId;
  return desktops[0]?.id ?? null;
}

export function desktopDeleteProtection(desktopCount: number) {
  if (desktopCount === 1) return "The last desktop cannot be deleted.";
  return "";
}
