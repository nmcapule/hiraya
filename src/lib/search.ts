import type { DesktopEntry, DesktopIdentity } from "../types";
import { assertValidId, isRecord, normalizeDesktopName, normalizeEntryName, parseRemoteEntry } from "./contracts";
import { API_ROUTES } from "./api-routes";
import { requireAuthenticatedResponse } from "./auth";

export type DesktopSearchResult = {
  authorityCatalogId: string | null;
  catalogRevision: number | null;
  desktopId: string;
  desktopName: string;
  entry: DesktopEntry;
  breadcrumb: string[];
  stale: boolean;
};

export type DesktopSearchResponse = {
  query: string;
  limit: number;
  truncated: boolean;
  results: DesktopSearchResult[];
};

function parseQuery(value: unknown) {
  if (typeof value !== "string" || [...value].length < 1 || [...value].length > 200 || !value.trim()) throw new Error("The search response contains an invalid query.");
  return value;
}

function parseRevision(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`The search response contains an invalid ${label}.`);
  return value as number;
}

function parseBreadcrumbs(value: unknown, entry: DesktopEntry) {
  if (!Array.isArray(value)) throw new Error("The search response contains invalid breadcrumbs.");
  const seen = new Set<string>();
  const breadcrumbs = value.map((part) => {
    if (!isRecord(part)) throw new Error("The search response contains invalid breadcrumbs.");
    assertValidId(part.id, "The search response contains an invalid breadcrumb ID.");
    const name = normalizeEntryName(typeof part.name === "string" ? part.name : "");
    if (name !== part.name) throw new Error("The search response contains an invalid breadcrumb name.");
    if (part.id === entry.id || seen.has(part.id)) throw new Error("The search response contains duplicate or cyclic breadcrumbs.");
    seen.add(part.id);
    return { id: part.id, name };
  });
  if (entry.parentId === null && breadcrumbs.length !== 0 || entry.parentId !== null && breadcrumbs.at(-1)?.id !== entry.parentId) {
    throw new Error("The search response contains breadcrumbs in an invalid order.");
  }
  return breadcrumbs;
}

export function parseSearchResponse(value: unknown, expectedQuery?: string): DesktopSearchResponse {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.results)) throw new Error("The search response has an unsupported format.");
  const query = parseQuery(value.query);
  if (expectedQuery !== undefined && query !== expectedQuery) throw new Error("The search response is for a different query.");
  const limit = parseRevision(value.limit, "limit");
  if (limit < 1 || limit > 100) throw new Error("The search response contains an invalid limit.");
  if (typeof value.truncated !== "boolean" || value.results.length > limit || value.truncated && value.results.length !== limit) throw new Error("The search response contains invalid truncation metadata.");
  const seen = new Set<string>();
  const authorityRevisions = new Map<string, number>();
  const desktopNames = new Map<string, string>();
  const results = value.results.map((candidate) => {
    if (!isRecord(candidate)) throw new Error("The search response contains an invalid result.");
    assertValidId(candidate.authorityCatalogId, "The search response contains an invalid authority catalog ID.");
    const catalogRevision = parseRevision(candidate.catalogRevision, "catalog revision");
    if (!isRecord(candidate.desktop)) throw new Error("The search response contains invalid desktop context.");
    assertValidId(candidate.desktop.id, "The search response contains an invalid desktop ID.");
    const desktopName = normalizeDesktopName(typeof candidate.desktop.name === "string" ? candidate.desktop.name : "");
    if (desktopName !== candidate.desktop.name) throw new Error("The search response contains an invalid desktop name.");
    const remoteEntry = parseRemoteEntry(candidate.entry);
    if (remoteEntry.revision > catalogRevision || remoteEntry.contentRevision > catalogRevision) throw new Error("The search response contains entry revisions newer than its catalog.");
    const { revision: _revision, contentRevision: _contentRevision, ...entry } = remoteEntry;
    void _revision;
    void _contentRevision;
    const breadcrumbs = parseBreadcrumbs(candidate.breadcrumbs, entry);
    const key = `${candidate.authorityCatalogId}\n${candidate.desktop.id}\n${entry.id}`;
    if (seen.has(key)) throw new Error("The search response contains a duplicate result.");
    seen.add(key);
    const knownRevision = authorityRevisions.get(candidate.authorityCatalogId);
    if (knownRevision !== undefined && knownRevision !== catalogRevision) throw new Error("The search response contains inconsistent authority revisions.");
    authorityRevisions.set(candidate.authorityCatalogId, catalogRevision);
    const desktopKey = `${candidate.authorityCatalogId}\n${candidate.desktop.id}`;
    const knownName = desktopNames.get(desktopKey);
    if (knownName !== undefined && knownName !== desktopName) throw new Error("The search response contains inconsistent desktop context.");
    desktopNames.set(desktopKey, desktopName);
    return { authorityCatalogId: candidate.authorityCatalogId, catalogRevision, desktopId: candidate.desktop.id, desktopName, entry, breadcrumb: breadcrumbs.map((part) => part.name), stale: false };
  });
  return { query, limit, truncated: value.truncated, results };
}

export function breadcrumbForEntry(entries: readonly DesktopEntry[], entry: DesktopEntry) {
  const byId = new Map(entries.map((candidate) => [candidate.id, candidate]));
  const parts: string[] = [];
  const visited = new Set<string>();
  let parentId = entry.parentId;
  while (parentId !== null) {
    if (visited.has(parentId)) return [];
    visited.add(parentId);
    const parent = byId.get(parentId);
    if (!parent || parent.kind !== "folder") return [];
    parts.unshift(parent.name);
    parentId = parent.parentId;
  }
  return parts;
}

export function localSearchResults(desktop: DesktopIdentity, entries: readonly DesktopEntry[], stale: boolean): DesktopSearchResult[] {
  return entries.map((entry) => ({ authorityCatalogId: desktop.authorityCatalogId, catalogRevision: null, desktopId: desktop.id, desktopName: desktop.name, entry, breadcrumb: breadcrumbForEntry(entries, entry), stale }));
}

export function mergeActiveDesktopResults(remote: readonly DesktopSearchResult[], activeDesktop: DesktopIdentity, entries: readonly DesktopEntry[]) {
  return [...remote.filter((result) => result.desktopId !== activeDesktop.id || result.authorityCatalogId !== activeDesktop.authorityCatalogId), ...localSearchResults(activeDesktop, entries, false)];
}

export async function searchAccessibleDesktops(query: string, signal: AbortSignal, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)) {
  const response = requireAuthenticatedResponse(await fetchImpl(API_ROUTES.search(query), { cache: "no-store", credentials: "same-origin", signal }));
  if (!response.ok) throw new Error(`Hiraya search is unavailable (${response.status}).`);
  return parseSearchResponse(await response.json(), query);
}
