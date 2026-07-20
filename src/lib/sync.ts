import type { SeededManifest } from "./seeded-manifest";
import {
  applyRemoteDesktop,
  createFolder as createLocalFolder,
  createTextFile as createLocalTextFile,
  deleteEntry as deleteLocalEntry,
  importFiles as importLocalFiles,
  loadDesktop,
  moveEntry as moveLocalEntry,
  readDesktopSnapshot,
  readFile,
  readFileByRelativePath,
  renameEntry as renameLocalEntry,
  saveDesktopLayout as saveLocalDesktopLayout,
  saveEditorSettings as saveLocalEditorSettings,
  saveTextFile as saveLocalTextFile,
  updateEntryPosition as updateLocalEntryPosition,
  type DesktopSnapshot,
} from "./opfs";
import { assertUniqueName, namesMatch, validateEntryName } from "./entry-validation";
import type { DesktopEntry, DesktopLayout, EditorSettings, EntryPosition, FileEntry, FolderEntry } from "../types";

type RemoteEntry = DesktopEntry & { revision: number; contentRevision: number };
type RemoteWorkspace = {
  initialized: boolean;
  revision: number;
  entries: RemoteEntry[];
  layout: DesktopLayout;
  layoutRevision: number;
  editorSettings: EditorSettings;
  settingsRevision: number;
};
export type SyncStatus = "connecting" | "online" | "offline" | "local";

const FRONTEND_ONLY = import.meta.env.HIRAYA_FRONTEND_ONLY === "true";

let desktop: DesktopSnapshot | null = null;
let initialized = false;
let status: SyncStatus = "connecting";
let events: EventSource | null = null;
let healthTimer = 0;
let work: Promise<unknown> = Promise.resolve();
const desktopListeners = new Set<(next: DesktopSnapshot) => void>();
const statusListeners = new Set<(next: SyncStatus) => void>();

function setStatus(next: SyncStatus) {
  if (status === next) return;
  status = next;
  for (const listener of statusListeners) listener(next);
}

function publish(next: DesktopSnapshot) {
  desktop = next;
  for (const listener of desktopListeners) listener(next);
}

async function request<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch {
    setStatus("offline");
    throw new Error("The sync server is unavailable. Changes are disabled until it reconnects.");
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error || `The sync server rejected the request (${response.status}).`);
  }
  setStatus("online");
  return response.json() as Promise<T>;
}

function queue<T>(operation: () => Promise<T>) {
  const next = work.then(operation, operation);
  work = next.then(() => undefined, () => undefined);
  return next;
}

function localEntry(entry: RemoteEntry): DesktopEntry {
  const { revision, contentRevision, ...local } = entry;
  void revision;
  void contentRevision;
  return local;
}

function toSnapshot(workspace: RemoteWorkspace): DesktopSnapshot {
  const entryRevisions: Record<string, number> = {};
  const contentRevisions: Record<string, number> = {};
  for (const entry of workspace.entries) {
    entryRevisions[entry.id] = entry.revision;
    if (entry.kind === "file") contentRevisions[entry.id] = entry.contentRevision;
  }
  return {
    entries: workspace.entries.map(localEntry),
    layout: workspace.layout,
    editorSettings: workspace.editorSettings,
    sync: {
      revision: workspace.revision,
      entryRevisions,
      contentRevisions,
      layoutRevision: workspace.layoutRevision,
      settingsRevision: workspace.settingsRevision,
    },
  };
}

async function fetchWorkspace() {
  return request<RemoteWorkspace>("/api/workspace", { cache: "no-store" });
}

async function applyWorkspace(workspace: RemoteWorkspace) {
  if (!desktop) throw new Error("The local desktop has not loaded.");
  initialized = workspace.initialized;
  if (!workspace.initialized || workspace.revision <= desktop.sync.revision) return desktop;
  const next = toSnapshot(workspace);
  const contents = new Map<string, Blob>();
  await Promise.all(workspace.entries.map(async (entry) => {
    if (entry.kind !== "file" || desktop?.sync.contentRevisions[entry.id] === entry.contentRevision) return;
    const response = await fetch(`/api/files/${encodeURIComponent(entry.id)}/content`, { cache: "no-store" });
    if (!response.ok) throw new Error(`The server contents of “${entry.name}” could not be loaded.`);
    const blob = await response.blob();
    if (blob.size !== entry.size) throw new Error(`The server contents of “${entry.name}” have an unexpected size.`);
    contents.set(entry.id, blob);
  }));
  const applied = await applyRemoteDesktop(next, contents);
  publish(applied);
  return applied;
}

async function bootstrap() {
  const snapshot = await readDesktopSnapshot();
  const form = new FormData();
  form.append("workspace", JSON.stringify({
    entries: snapshot.entries,
    layout: snapshot.layout,
    editorSettings: snapshot.editorSettings,
  }));
  for (const entry of snapshot.entries) {
    if (entry.kind !== "file") continue;
    const content = snapshot.contents.get(entry.id);
    if (!content) throw new Error(`The contents of “${entry.name}” could not be read for initial sync.`);
    form.append(`file-${entry.id}`, content, entry.name);
  }
  const workspace = await request<RemoteWorkspace>("/api/bootstrap", { method: "POST", body: form });
  initialized = true;
  return applyWorkspace(workspace);
}

async function ensureServer() {
  const workspace = await fetchWorkspace();
  if (!workspace.initialized) return bootstrap();
  initialized = true;
  return applyWorkspace(workspace);
}

async function reconcile() {
  const workspace = await fetchWorkspace();
  if (!workspace.initialized) return bootstrap();
  return applyWorkspace(workspace);
}

function startEvents() {
  events?.close();
  events = new EventSource("/api/events");
  events.onopen = () => {
    setStatus("online");
    void queue(reconcile).catch(() => undefined);
  };
  events.onerror = () => setStatus("offline");
  events.addEventListener("workspace", (event) => {
    const revision = Number((JSON.parse((event as MessageEvent<string>).data) as { revision?: number }).revision);
    if (!Number.isFinite(revision) || revision <= (desktop?.sync.revision ?? 0)) return;
    void queue(reconcile).catch(() => undefined);
  });
  window.clearInterval(healthTimer);
  healthTimer = window.setInterval(() => {
    void fetch("/api/health", { cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error("unhealthy");
      const health = await response.json() as { revision?: number };
      const wasOffline = status === "offline";
      setStatus("online");
      if (wasOffline || Number(health.revision) > (desktop?.sync.revision ?? 0)) {
        void queue(reconcile).catch(() => setStatus("offline"));
      }
    }).catch(() => setStatus("offline"));
  }, 5_000);
}

export async function initializeDesktop(viewport: EntryPosition, seeded: SeededManifest | null = null) {
  desktop = await loadDesktop(viewport, seeded);
  if (FRONTEND_ONLY) {
    initialized = true;
    setStatus("local");
    return { desktop, status };
  }
  setStatus("connecting");
  try {
    await ensureServer();
  } catch {
    setStatus("offline");
  }
  startEvents();
  return { desktop, status };
}

export function subscribeToSync(onDesktop: (next: DesktopSnapshot) => void, onStatus: (next: SyncStatus) => void) {
  desktopListeners.add(onDesktop);
  statusListeners.add(onStatus);
  onStatus(status);
  return () => {
    desktopListeners.delete(onDesktop);
    statusListeners.delete(onStatus);
  };
}

function current() {
  if (!desktop) throw new Error("The desktop is still loading.");
  return desktop;
}

async function mutate<T>(operation: () => Promise<void>, select: (next: DesktopSnapshot) => T) {
  return queue(async () => {
    if (!initialized) await ensureServer();
    try {
      await operation();
    } catch (error) {
      await reconcile().catch(() => undefined);
      throw error;
    }
    const next = await reconcile();
    return select(next);
  });
}

function resolveViewId(parentId: string | null, viewId: string | null) {
  if (parentId !== null) return null;
  if (!current().layout.views.some((view) => view.id === viewId)) throw new Error("That desktop view no longer exists.");
  return viewId;
}

function assertParent(parentId: string | null) {
  if (parentId === null) return;
  const parent = current().entries.find((entry) => entry.id === parentId);
  if (!parent || parent.kind !== "folder") throw new Error("That parent folder no longer exists.");
}

async function postEntry(entry: DesktopEntry, content?: Blob) {
  const form = new FormData();
  form.append("entry", JSON.stringify(entry));
  if (content) form.append("content", content, entry.name);
  await request("/api/entries", { method: "POST", body: form });
}

export function createTextFile(nameValue: string, parentId: string | null, position: EntryPosition, viewId: string | null) {
  if (FRONTEND_ONLY) return createLocalTextFile(nameValue, parentId, position, viewId);
  const name = validateEntryName(nameValue);
  assertParent(parentId);
  assertUniqueName(current().entries, name, parentId);
  const entry: FileEntry = { kind: "file", id: crypto.randomUUID(), name, parentId, mimeType: "text/plain", size: 0, modifiedAt: Date.now(), position, viewId: resolveViewId(parentId, viewId) };
  return mutate(() => postEntry(entry, new Blob([], { type: entry.mimeType })), (next) => next.entries.find((item) => item.id === entry.id) as FileEntry);
}

export function createFolder(nameValue: string, parentId: string | null, position: EntryPosition, viewId: string | null) {
  if (FRONTEND_ONLY) return createLocalFolder(nameValue, parentId, position, viewId);
  const name = validateEntryName(nameValue);
  assertParent(parentId);
  assertUniqueName(current().entries, name, parentId);
  const entry: FolderEntry = { kind: "folder", id: crypto.randomUUID(), name, parentId, modifiedAt: Date.now(), position, viewId: resolveViewId(parentId, viewId) };
  return mutate(() => postEntry(entry), (next) => next.entries.find((item) => item.id === entry.id) as FolderEntry);
}

export function importFiles(files: File[], parentId: string | null, positions: EntryPosition[], viewId: string | null) {
  if (FRONTEND_ONLY) return importLocalFiles(files, parentId, positions, viewId);
  if (files.length !== positions.length) throw new Error("Each imported file needs a desktop position.");
  assertParent(parentId);
  const names = files.map((file) => validateEntryName(file.name));
  for (const [index, name] of names.entries()) {
    assertUniqueName(current().entries, name, parentId);
    if (names.slice(0, index).some((candidate) => namesMatch(candidate, name))) throw new Error(`The upload contains more than one file named “${name}”.`);
  }
  const entries: FileEntry[] = files.map((file, index) => ({ kind: "file", id: crypto.randomUUID(), name: names[index], parentId, mimeType: file.type || "application/octet-stream", size: file.size, modifiedAt: file.lastModified || Date.now(), position: positions[index], viewId: resolveViewId(parentId, viewId) }));
  return mutate(async () => {
    const form = new FormData();
    form.append("entries", JSON.stringify(entries));
    for (const [index, entry] of entries.entries()) form.append(`file-${entry.id}`, files[index], entry.name);
    await request("/api/imports", { method: "POST", body: form });
  }, (next) => entries.map((entry) => next.entries.find((item) => item.id === entry.id) as FileEntry));
}

export function renameEntry(id: string, nameValue: string) {
  if (FRONTEND_ONLY) return renameLocalEntry(id, nameValue);
  const existing = current().entries.find((entry) => entry.id === id);
  if (!existing) throw new Error("That entry no longer exists.");
  const name = validateEntryName(nameValue);
  assertUniqueName(current().entries, name, existing.parentId, id);
  const entry = { ...existing, name };
  return mutate(() => request(`/api/entries/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(entry) }).then(() => undefined), (next) => next.entries.find((item) => item.id === id) as DesktopEntry);
}

export function deleteEntry(id: string) {
  if (FRONTEND_ONLY) return deleteLocalEntry(id);
  const before = current().entries;
  if (!before.some((entry) => entry.id === id)) throw new Error("That entry no longer exists.");
  return mutate(() => request(`/api/entries/${encodeURIComponent(id)}`, { method: "DELETE" }).then(() => undefined), (next) => before.filter((entry) => !next.entries.some((item) => item.id === entry.id)));
}

export function moveEntry(id: string, parentId: string | null, position: EntryPosition, viewId: string | null) {
  if (FRONTEND_ONLY) return moveLocalEntry(id, parentId, position, viewId);
  const existing = current().entries.find((entry) => entry.id === id);
  if (!existing) throw new Error("That entry no longer exists.");
  assertParent(parentId);
  const entry = { ...existing, parentId, position, viewId: resolveViewId(parentId, viewId) };
  return mutate(() => request(`/api/entries/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(entry) }).then(() => undefined), (next) => next.entries.find((item) => item.id === id) as DesktopEntry);
}

export function updateEntryPosition(id: string, position: EntryPosition, viewId: string | null) {
  if (FRONTEND_ONLY) return updateLocalEntryPosition(id, position, viewId);
  const existing = current().entries.find((entry) => entry.id === id);
  if (!existing) throw new Error("That entry no longer exists.");
  const entry = { ...existing, position, viewId: resolveViewId(existing.parentId, viewId) };
  return mutate(() => request(`/api/entries/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(entry) }).then(() => undefined), (next) => next.entries.find((item) => item.id === id) as DesktopEntry);
}

export function saveTextFile(id: string, content: string) {
  if (FRONTEND_ONLY) return saveLocalTextFile(id, content);
  const existing = current().entries.find((entry): entry is FileEntry => entry.id === id && entry.kind === "file");
  if (!existing) throw new Error("That file no longer exists.");
  return mutate(() => request(`/api/files/${encodeURIComponent(id)}/content`, { method: "PUT", headers: { "Content-Type": existing.mimeType }, body: content }).then(() => undefined), (next) => next.entries.find((item) => item.id === id) as FileEntry);
}

export function saveDesktopLayout(layout: DesktopLayout) {
  if (FRONTEND_ONLY) return saveLocalDesktopLayout(layout);
  return mutate(() => request("/api/layout", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(layout) }).then(() => undefined), () => undefined);
}

export function saveEditorSettings(settings: EditorSettings) {
  if (FRONTEND_ONLY) return saveLocalEditorSettings(settings);
  return mutate(() => request("/api/editor-settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings) }).then(() => undefined), () => undefined);
}

export { readFile, readFileByRelativePath };
