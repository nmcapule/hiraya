import { DEFAULT_WALLPAPER, type DesktopEntry, type DesktopIdentity, type DesktopLayout, type RootEntryPositionUpdate, type EditorSettings, type EntryPosition, type FileEntry, type FolderEntry } from "../types";
import { assertUniqueName, namesMatch, validateEntryName } from "./entry-validation";
import { parseBundledSeededManifest, type SeededManifest } from "./seeded-manifest";
import { validateWallpaperImage } from "./wallpaper-image";
import {
  DEFAULT_EDITOR_SETTINGS,
  emptySyncState,
  desktopStateLayout,
  parseDesktopState,
  type DesktopSyncState,
  type PersistedDesktopState,
} from "./desktop-state";
import { normalizeDesktopName, parseDesktopIdentity, parseLayout, parsePosition, parseRootEntryPositionUpdates } from "./contracts";
import { createStorageDbRequest, type StorageDbMethod, type StorageDbRequests, type StorageDbResponse, type StorageDbResponses } from "./opfs-db-protocol";
import { wallpaperAfterEntryRemoval, type OutboxOperation, type OutboxRecord } from "./outbox";
import { DEFAULT_THEME_STATE, parseCustomTheme, parseThemeState, type CustomTheme, type ThemeState } from "./themes";
import { parseWindowSession, type WindowSession } from "./window-session";
import { activityRecord, type ActivityQuery, type NewActivityRecord } from "./activity";
import { resolveDesktopContext } from "./desktop-catalog";
import { localDesktopIdentity } from "./permissions";

const FILES_DIRECTORY = "files";
const PENDING_DIRECTORY = "pending";
const CONTENT_CACHE_DIRECTORY = ".hiraya-content-cache";
const LEGACY_STORAGE_ENTRIES = [FILES_DIRECTORY, PENDING_DIRECTORY, CONTENT_CACHE_DIRECTORY, ".hiraya-sqlite-v1"];
export const LOCAL_STORAGE_ID = "hiraya-local";
const FRONTEND_ONLY = import.meta.env.HIRAYA_FRONTEND_ONLY === "true";

let storageNamespace: { storageId: string; key: string } | null = null;

function namespaceKey() {
  if (!storageNamespace) throw new Error("Hiraya storage was used before its namespace was selected.");
  return storageNamespace.key;
}

async function storageKey(storageId: string) {
  if (!storageId || storageId.length > 1024 || [...storageId].some((character) => character.charCodeAt(0) < 32)) throw new Error("The Hiraya storage ID is invalid.");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(storageId));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function removeLegacyUnscopedStorage(root: FileSystemDirectoryHandle) {
  if (localStorage.getItem("hiraya-scoped-storage-v1") === "complete") return;
  for (const name of LEGACY_STORAGE_ENTRIES) {
    try {
      await root.removeEntry(name, { recursive: true });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  localStorage.setItem("hiraya-scoped-storage-v1", "complete");
}

export async function configureStorageNamespace(storageId: string) {
  const key = await storageKey(storageId);
  if (storageNamespace) {
    if (storageNamespace.storageId !== storageId) throw new Error("The Hiraya storage namespace cannot change after startup.");
    return;
  }
  if (!navigator.storage?.getDirectory) throw new StorageUnavailableError();
  const root = await navigator.storage.getDirectory();
  if (!FRONTEND_ONLY) await removeLegacyUnscopedStorage(root);
  storageNamespace = { storageId, key };
  activeDesktopContext = sessionStorage.getItem(FRONTEND_ONLY ? "hiraya-active-desktop" : `hiraya-active-desktop-${key}`);
}

type DesktopState = PersistedDesktopState;
export type { DesktopSyncState } from "./desktop-state";

export type DesktopStateSnapshot = {
  entries: DesktopEntry[];
  layout: DesktopLayout;
  editorSettings: EditorSettings;
  appearance: ThemeState;
  sync: DesktopSyncState;
};

// Local aliases keep mutation code focused on state transitions rather than persistence mechanics.
type Manifest = DesktopState;
const parseManifestV13 = parseDesktopState;
const manifestLayout = desktopStateLayout;

export type LocalPreferences = { autoUpdate: boolean; externalEmbeddedPreviews: boolean };

export { DEFAULT_EDITOR_SETTINGS } from "./desktop-state";

export class StorageUnavailableError extends Error {
  constructor() {
    super("Private browser storage is unavailable. Open Hiraya in a modern browser over HTTPS or localhost.");
    this.name = "StorageUnavailableError";
  }
}

async function getRoot() {
  if (!("storage" in navigator) || !("getDirectory" in navigator.storage)) {
    throw new StorageUnavailableError();
  }

  const root = await navigator.storage.getDirectory();
  return FRONTEND_ONLY ? root : root.getDirectoryHandle(`.hiraya-storage-${namespaceKey()}`, { create: true });
}

async function getFilesDirectory() {
  const root = await getRoot();
  return root.getDirectoryHandle(FILES_DIRECTORY, { create: true });
}

async function getPendingDirectory() {
  const root = await getRoot();
  return root.getDirectoryHandle(PENDING_DIRECTORY, { create: true });
}

async function getContentCacheDirectory() {
  const root = await getRoot();
  return root.getDirectoryHandle(CONTENT_CACHE_DIRECTORY, { create: true });
}

type ContentCacheMarker = { catalogId: string; contentRevision: number; size: number };

async function readContentCacheMarker(id: string): Promise<ContentCacheMarker | null> {
  try {
    const directory = await getContentCacheDirectory();
    const value: unknown = JSON.parse(await (await directory.getFileHandle(id)).getFile().then((file) => file.text()));
    if (!value || typeof value !== "object") return null;
    const marker = value as Partial<ContentCacheMarker>;
    if (typeof marker.catalogId !== "string" || !Number.isSafeInteger(marker.contentRevision) || !Number.isSafeInteger(marker.size)) return null;
    return marker as ContentCacheMarker;
  } catch (error) {
    if (isNotFound(error) || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function writeContentCacheMarker(id: string, marker: ContentCacheMarker) {
  await writeHandleContent(await getContentCacheDirectory(), id, JSON.stringify(marker));
}

async function removeContentCacheMarker(id: string) {
  try {
    await (await getContentCacheDirectory()).removeEntry(id);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

async function writeDesktopState(state: DesktopState, activity?: NewActivityRecord) {
  await callDatabase("replaceDesktopState", { state, activity });
  desktopLoad = Promise.resolve(state);
}

function activityDetails(entries: DesktopEntry[]) {
  const names = entries.slice(0, 18).map((entry) => `${entry.kind === "file" ? "File" : "Folder"}: ${entry.name}`);
  if (entries.length > names.length) names.push(`Additional items: ${entries.length - names.length}`);
  return names;
}

function locationDetail(entries: DesktopEntry[], parentId: string | null) {
  return `Location: ${parentId === null ? "Desktop" : entries.find((entry) => entry.id === parentId)?.name ?? "Unknown folder"}`;
}

function assertValidDesktopState(state: DesktopState) {
  parseDesktopState(state);
}

async function createDesktopStateFromSeeded(seeded: SeededManifest): Promise<DesktopState> {
  const parsedSeeded = parseBundledSeededManifest(seeded);
  const files = parsedSeeded.entries.filter((entry) => entry.kind === "file");
  const contents = await Promise.all(files.map(async (entry) => {
    const response = await fetch(entry.contentUrl);
    if (!response.ok) throw new Error(`The seeded file “${entry.name}” could not be loaded (${response.status}).`);
    const blob = await response.blob();
    if (blob.size !== entry.size) {
      throw new Error(`The seeded file “${entry.name}” has size ${blob.size}, but its manifest declares ${entry.size}.`);
    }
    return blob.slice(0, blob.size, entry.mimeType);
  }));
  const wallpaperFileId = parsedSeeded.layout.wallpaper.source.startsWith("file:") ? parsedSeeded.layout.wallpaper.source.slice(5) : null;
  if (wallpaperFileId) {
    const index = files.findIndex((entry) => entry.id === wallpaperFileId);
    await validateWallpaperImage(new File([contents[index]], files[index].name, { type: files[index].mimeType }));
  }
  const entries: DesktopEntry[] = parsedSeeded.entries.map((entry) => {
    if (entry.kind === "folder") return entry;
    const { contentUrl, ...file } = entry;
    void contentUrl;
    return file;
  });
  const created: DesktopState = {
    entries,
    snapToGrid: parsedSeeded.layout.snapToGrid,
    wallpaper: parsedSeeded.layout.wallpaper,
    editorSettings: parsedSeeded.editorSettings,
    appearance: parsedSeeded.appearance,
    sync: emptySyncState(),
  };
  assertValidDesktopState(created);
  for (const [index, file] of files.entries()) await writeContent(file.id, contents[index]);
  return created;
}

function isNotFound(error: unknown): error is DOMException {
  return error instanceof DOMException && error.name === "NotFoundError";
}

async function initializeDatabase(): Promise<void> {
  await getRoot();
  await callDatabase("status", undefined);
}

async function readActiveDesktopState(seeded: SeededManifest | null = null): Promise<DesktopState> {
  databaseInitialization ??= initializeDatabase().catch((error) => {
    databaseInitialization = null;
    throw error;
  });
  await databaseInitialization;
  if (!activeDesktopContext) throw new Error("No desktop is active.");
  try {
    return parseDesktopState(await callDatabase("readDesktop", { desktopId: activeDesktopContext }, activeDesktopContext));
  } catch (error) {
    if (!seeded) throw error;
    const desktop = localDesktopIdentity(crypto.randomUUID(), "Desktop");
    const state = await createDesktopStateFromSeeded(seeded);
    await callDatabase("createDesktop", { desktop, state }, null);
    setDesktopContext(desktop.id);
    return state;
  }
}

const readManifest = readActiveDesktopState;
const writeManifest = writeDesktopState;
const assertValidManifest = assertValidDesktopState;

async function writeContent(id: string, content: Blob | string) {
  const directory = await getFilesDirectory();
  const handle = await directory.getFileHandle(id, { create: true });
  const writable = await handle.createWritable();

  try {
    await writable.write(content);
  } finally {
    await writable.close();
  }
}

async function writeHandleContent(directory: FileSystemDirectoryHandle, name: string, content: Blob | string) {
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(content);
  } finally {
    await writable.close();
  }
}

function operationContentIds(operation: OutboxOperation) {
  if (operation.kind === "save-content") return [operation.entry.id];
  if (operation.kind === "create") return operation.entries.filter((entry): entry is FileEntry => entry.kind === "file").map((entry) => entry.id);
  return [];
}

async function stageOperationContents(operationId: string, contents: Map<string, Blob>) {
  if (contents.size === 0) return;
  const pending = await getPendingDirectory();
  const operationDirectory = await pending.getDirectoryHandle(operationId, { create: true });
  for (const [id, content] of contents) await writeHandleContent(operationDirectory, id, content);
}

async function readStagedContent(operationId: string, id: string) {
  const pending = await getPendingDirectory();
  return (await (await pending.getDirectoryHandle(operationId)).getFileHandle(id)).getFile();
}

async function materializeOutbox(records: OutboxRecord[]) {
  for (const record of records) {
    for (const id of operationContentIds(record.operation)) {
      const content = await readStagedContent(record.operationId, id);
      await writeContent(id, content);
    }
  }
}

async function removeStagedOperation(operationId: string) {
  try {
    await (await getPendingDirectory()).removeEntry(operationId, { recursive: true });
  } catch (error) {
    if (!isNotFound(error)) console.warn("Hiraya could not clean up acknowledged pending content.", error);
  }
}

function findParent(entries: DesktopEntry[], parentId: string | null) {
  if (parentId === null) return;
  const parent = entries.find((entry) => entry.id === parentId);
  if (!parent) throw new Error("That parent folder no longer exists.");
  if (parent.kind !== "folder") throw new Error("Files cannot contain other entries.");
  return parent;
}

function getEntry(entries: DesktopEntry[], id: string) {
  const entry = entries.find((candidate) => candidate.id === id);
  if (!entry) throw new Error("That entry no longer exists.");
  return entry;
}

function getFileEntry(entries: DesktopEntry[], id: string): FileEntry {
  const entry = getEntry(entries, id);
  if (entry.kind !== "file") throw new Error("Folders do not have file content.");
  return entry;
}

let desktopLoad: Promise<DesktopState> | null = null;
let databaseInitialization: Promise<void> | null = null;
let storageWork: Promise<void> = Promise.resolve();
let activeDesktopContext: string | null = null;

function setDesktopContext(desktopId: string) {
  activeDesktopContext = desktopId;
  if (typeof sessionStorage !== "undefined") sessionStorage.setItem(FRONTEND_ONLY ? "hiraya-active-desktop" : `hiraya-active-desktop-${namespaceKey()}`, desktopId);
}

type RpcPort = {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent<StorageDbResponse>) => void): void;
  start?: () => void;
  reset(): boolean;
};

let databasePort: Promise<RpcPort> | null = null;
let hostedDatabaseWorker: Worker | null = null;
let hostedDatabaseRequestId: number | null = null;
let requestId = 0;
const pendingRequests = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
const OWNER_CHANGED_MESSAGE = "The local database owner changed. Retry the operation.";
const RETRYABLE_OWNER_CHANGE_METHODS = new Set<StorageDbMethod>(["status", "listDesktops", "readDesktop", "readPreferences", "readWindowSession", "readOutbox", "listActivity"]);
const DATABASE_REQUEST_TIMEOUT_MS = 15_000;
const STORAGE_LOCK_TIMEOUT_MS = 30_000;

class LocalDatabaseOwnerChangedError extends Error {}
class LocalDatabaseTimeoutError extends Error {}

function openDatabasePort(): RpcPort {
  const key = namespaceKey();
  let port: RpcPort;
  if (typeof SharedWorker !== "undefined") {
    const shared = new SharedWorker(new URL("./opfs-shared.worker.ts", import.meta.url), { type: "module", name: FRONTEND_ONLY ? "hiraya-storage" : `hiraya-storage-${key}` });
    shared.port.addEventListener("message", (event) => {
      const message = event.data as { type?: string; requestId?: number };
      if (message.type !== "need-engine" || message.requestId === undefined) return;
      if (hostedDatabaseWorker && hostedDatabaseRequestId === message.requestId) return;
      hostedDatabaseWorker?.terminate();
      const candidateRequestId = message.requestId;
      const worker = new Worker(new URL("./opfs-db.worker.ts", import.meta.url), { type: "module", name: FRONTEND_ONLY ? "hiraya-sqlite-engine" : `hiraya-sqlite-engine-${key}` });
      hostedDatabaseRequestId = candidateRequestId;
      hostedDatabaseWorker = worker;
      const channel = new MessageChannel();
      channel.port2.onmessage = (message: MessageEvent<{ type?: string; error?: string }>) => {
        if (message.data.type === "engine-error") {
          worker.terminate();
          if (hostedDatabaseWorker === worker) {
            hostedDatabaseWorker = null;
            hostedDatabaseRequestId = null;
          }
          return;
        }
        if (message.data.type !== "engine-ready") return;
        channel.port2.onmessage = null;
        if (hostedDatabaseWorker !== worker) {
          channel.port2.close();
          return;
        }
        shared.port.postMessage({ type: "attach-engine", requestId: candidateRequestId, port: channel.port2 }, [channel.port2]);
      };
      channel.port2.start();
      worker.postMessage({ type: "attach", storage: key, port: channel.port1 }, [channel.port1]);
    });
    shared.port.postMessage({ type: "configure-storage", storage: key });
    window.addEventListener("pagehide", () => {
      if (!hostedDatabaseWorker || hostedDatabaseRequestId === null) return;
      const releasedRequestId = hostedDatabaseRequestId;
      hostedDatabaseWorker.terminate();
      hostedDatabaseWorker = null;
      hostedDatabaseRequestId = null;
      shared.port.postMessage({ type: "release-engine", requestId: releasedRequestId });
    });
    port = {
      postMessage: (message, transfer) => shared.port.postMessage(message, transfer ?? []),
      addEventListener: (type, listener) => shared.port.addEventListener(type, listener),
      start: () => shared.port.start(),
      reset: () => {
        hostedDatabaseWorker?.terminate();
        hostedDatabaseWorker = null;
        hostedDatabaseRequestId = null;
        shared.port.postMessage({ type: "reset-engine" });
        return false;
      },
    };
  } else {
    const worker = new Worker(new URL("./opfs-db.worker.ts", import.meta.url), { type: "module", name: FRONTEND_ONLY ? "hiraya-storage-fallback" : `hiraya-storage-fallback-${key}` });
    worker.postMessage({ type: "configure-storage", storage: key });
    port = {
      postMessage: (message, transfer) => worker.postMessage(message, transfer ?? []),
      addEventListener: (type, listener) => worker.addEventListener(type, listener),
      reset: () => {
        worker.terminate();
        return true;
      },
    };
  }
  port.addEventListener("message", (event) => {
    const response = event.data;
    const pending = pendingRequests.get(response.id);
    if (!pending) return;
    pendingRequests.delete(response.id);
    if (response.error) pending.reject(response.error === OWNER_CHANGED_MESSAGE ? new LocalDatabaseOwnerChangedError(response.error) : new Error(response.error));
    else pending.resolve(response.result);
  });
  port.start?.();
  return port;
}

async function callDatabase<M extends StorageDbMethod>(method: M, params: StorageDbRequests[M], desktopId: string | null = activeDesktopContext): Promise<StorageDbResponses[M]> {
  await getRoot();
  for (let attempt = 0; ; attempt += 1) {
    const connection = databasePort ??= Promise.resolve().then(openDatabasePort);
    const port = await connection;
    try {
      const id = ++requestId;
      return await new Promise<StorageDbResponses[M]>((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          if (!pendingRequests.delete(id)) return;
          if (port.reset() && databasePort === connection) databasePort = null;
          const error = new LocalDatabaseTimeoutError("Local storage stopped responding. Please retry the operation.");
          for (const pending of [...pendingRequests.values()]) pending.reject(error);
          pendingRequests.clear();
          reject(error);
        }, DATABASE_REQUEST_TIMEOUT_MS);
        pendingRequests.set(id, {
          resolve: (value) => {
            window.clearTimeout(timeout);
            resolve(value as StorageDbResponses[M]);
          },
          reject: (error) => {
            window.clearTimeout(timeout);
            reject(error);
          },
        });
        port.postMessage(createStorageDbRequest(id, desktopId, method, params));
      });
    } catch (error) {
      if (!(error instanceof LocalDatabaseOwnerChangedError || error instanceof LocalDatabaseTimeoutError) || attempt > 0 || !RETRYABLE_OWNER_CHANGE_METHODS.has(method)) throw error;
    }
  }
}

async function withCrossContextLock<T>(operation: () => Promise<T>) {
  if (!("locks" in navigator) || !navigator.locks) return operation();
  const controller = new AbortController();
  let acquired = false;
  const timeout = window.setTimeout(() => {
    if (!acquired) controller.abort();
  }, STORAGE_LOCK_TIMEOUT_MS);
  try {
    return await navigator.locks.request(FRONTEND_ONLY ? "hiraya-opfs" : `hiraya-opfs-${namespaceKey()}`, { mode: "exclusive", signal: controller.signal }, async () => {
      acquired = true;
      window.clearTimeout(timeout);
      return operation();
    });
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Local storage is busy in another Hiraya window. Close the other window and retry.");
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

function serializeStorage<T>(operation: () => Promise<T>): Promise<T> {
  const locked = () => withCrossContextLock(operation);
  const next = storageWork.then(locked, locked);
  storageWork = next.then(() => undefined, () => undefined);
  return next;
}

async function readLocalPreferencesUnsafe(): Promise<LocalPreferences> {
  await callDatabase("status", undefined);
  return callDatabase("readPreferences", undefined);
}

async function saveLocalPreferencesUnsafe(preferences: LocalPreferences) {
  await callDatabase("status", undefined);
  await callDatabase("writePreferences", { preferences });
}

async function readWindowSessionUnsafe(desktopId: string) {
  await callDatabase("status", undefined);
  return parseWindowSession(await callDatabase("readWindowSession", { desktopId }));
}

async function saveWindowSessionUnsafe(desktopId: string, session: WindowSession) {
  await callDatabase("status", undefined);
  await callDatabase("writeWindowSession", { desktopId, session: parseWindowSession(session) });
}

function emptyDesktopState(): DesktopState {
  return { entries: [], snapToGrid: false, wallpaper: DEFAULT_WALLPAPER, editorSettings: DEFAULT_EDITOR_SETTINGS, appearance: DEFAULT_THEME_STATE, sync: emptySyncState() };
}

async function listDesktopsUnsafe(seeded: SeededManifest | null = null) {
  await initializeDatabase();
  const result = await callDatabase("listDesktops", undefined, null);
  const desktops = result.desktops.map((desktop) => parseDesktopIdentity(desktop, true));
  if (desktops.length === 0 && seeded) {
    const desktop = localDesktopIdentity(crypto.randomUUID(), "Desktop");
    await callDatabase("createDesktop", { desktop, state: await createDesktopStateFromSeeded(seeded) }, null);
    desktops.push(desktop);
  }
  const activeDesktopId = resolveDesktopContext(activeDesktopContext, desktops);
  if (activeDesktopId) setDesktopContext(activeDesktopId);
  return { desktops, activeDesktopId };
}

async function createDesktopUnsafe(nameValue: string) {
  await initializeDatabase();
  const desktop = localDesktopIdentity(crypto.randomUUID(), normalizeDesktopName(nameValue));
  const registry = await callDatabase("listDesktops", undefined);
  if (registry.desktops.some((candidate) => candidate.name.toLocaleLowerCase() === desktop.name.toLocaleLowerCase())) throw new Error("A desktop with that name already exists.");
  const state = emptyDesktopState();
  if (activeDesktopContext) {
    const active = parseDesktopState(await callDatabase("readDesktop", { desktopId: activeDesktopContext }, activeDesktopContext));
    state.sync.catalogId = active.sync.catalogId;
    state.sync.catalogRevision = active.sync.catalogRevision;
  }
  return parseDesktopIdentity(await callDatabase("createDesktop", { desktop, state }), true);
}

async function createOfflineDesktopUnsafe(nameValue: string) {
  await initializeDatabase();
  const desktop = localDesktopIdentity(crypto.randomUUID(), normalizeDesktopName(nameValue));
  const registry = await callDatabase("listDesktops", undefined, null);
  if (registry.desktops.length !== 0) throw new Error("An offline desktop can only initialize an empty browser catalog.");
  const result = await callDatabase("createOfflineDesktop", { desktop, state: emptyDesktopState() }, null);
  setDesktopContext(desktop.id);
  desktopLoad = Promise.resolve(emptyDesktopState());
  return { ...result, desktop: parseDesktopIdentity(result.desktop, true) };
}

async function ensureDesktopUnsafe(value: DesktopIdentity) {
  await initializeDatabase();
  const desktop = parseDesktopIdentity(value, true);
  const registry = await callDatabase("listDesktops", undefined);
  const existing = registry.desktops.find((candidate) => candidate.id === desktop.id);
  if (existing) {
    const hasPendingRename = (await callDatabase("readOutbox", undefined)).some((record) => record.operation.kind === "rename-desktop" && record.operation.desktop.id === desktop.id);
    if (!hasPendingRename && existing.name !== desktop.name) await callDatabase("renameDesktop", { desktopId: desktop.id, name: desktop.name });
    await callDatabase("updateDesktopIdentity", { desktop: hasPendingRename ? { ...desktop, name: existing.name } : desktop });
    return desktop;
  }
  return parseDesktopIdentity(await callDatabase("createDesktop", { desktop, state: emptyDesktopState() }), true);
}

async function renameDesktopUnsafe(desktopId: string, nameValue: string) {
  const name = normalizeDesktopName(nameValue);
  const registry = await callDatabase("listDesktops", undefined);
  if (registry.desktops.some((candidate) => candidate.id !== desktopId && candidate.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error("A desktop with that name already exists.");
  return parseDesktopIdentity(await callDatabase("renameDesktop", { desktopId, name }), true);
}

async function switchDesktopUnsafe(desktopId: string) {
  const manifest = parseDesktopState(await callDatabase("readDesktop", { desktopId }, desktopId));
  setDesktopContext(desktopId);
  desktopLoad = Promise.resolve(manifest);
  await materializeOutbox(await callDatabase("readOutbox", undefined));
  return { entries: manifest.entries, layout: desktopStateLayout(manifest), editorSettings: manifest.editorSettings, appearance: manifest.appearance, sync: manifest.sync };
}

async function deleteDesktopUnsafe(desktopId: string) {
  const deleted = parseDesktopState(await callDatabase("readDesktop", { desktopId }));
  const registry = await callDatabase("listDesktops", undefined);
  const retained = new Set<string>();
  for (const desktop of registry.desktops) {
    if (desktop.id === desktopId) continue;
    const manifest = parseDesktopState(await callDatabase("readDesktop", { desktopId: desktop.id }));
    for (const entry of manifest.entries) if (entry.kind === "file") retained.add(entry.id);
  }
  await callDatabase("deleteDesktop", { desktopId });
  try {
    const directory = await getFilesDirectory();
    for (const entry of deleted.entries) if (entry.kind === "file" && !retained.has(entry.id)) await directory.removeEntry(entry.id).catch(() => undefined);
  } catch (error) { console.warn("Hiraya could not clean up deleted desktop content.", error); }
}

async function retainedFileIdsUnsafe() {
  const registry = await callDatabase("listDesktops", undefined, null);
  const retained = new Set<string>();
  for (const desktop of registry.desktops) {
    const manifest = parseDesktopState(await callDatabase("readDesktop", { desktopId: desktop.id }, null));
    for (const entry of manifest.entries) if (entry.kind === "file") retained.add(entry.id);
  }
  return retained;
}

async function pruneLocalDesktopsUnsafe(retainedDesktopIds: string[]) {
  const registry = await callDatabase("listDesktops", undefined, null);
  const retainedDesktops = new Set(retainedDesktopIds);
  const candidates: string[] = [];
  for (const desktop of registry.desktops) {
    if (retainedDesktops.has(desktop.id) || desktop.id === activeDesktopContext) continue;
    const manifest = parseDesktopState(await callDatabase("readDesktop", { desktopId: desktop.id }, null));
    for (const entry of manifest.entries) if (entry.kind === "file") candidates.push(entry.id);
  }
  await callDatabase("pruneDesktops", { retainedDesktopIds }, activeDesktopContext);
  const retainedFiles = await retainedFileIdsUnsafe();
  try {
    const directory = await getFilesDirectory();
    for (const id of candidates) if (!retainedFiles.has(id)) await directory.removeEntry(id).catch(() => undefined);
  } catch (error) { console.warn("Hiraya could not clean up stale desktop content.", error); }
}

async function readDesktopEntriesUnsafe(desktopId: string) {
  const manifest = parseDesktopState(await callDatabase("readDesktop", { desktopId }));
  return manifest.entries;
}

async function transferEntriesUnsafe(sourceDesktopId: string, destinationDesktopId: string, entryIds: string[], parentId: string | null) {
  const result = await callDatabase("transferEntries", { sourceDesktopId, destinationDesktopId, entryIds, parentId });
  const source = parseDesktopState(result.source);
  desktopLoad = Promise.resolve(source);
  return { entries: source.entries, layout: desktopStateLayout(source), editorSettings: source.editorSettings, appearance: source.appearance, sync: source.sync };
}

async function loadDesktopUnsafe(_viewport: EntryPosition, seeded: SeededManifest | null = null): Promise<DesktopStateSnapshot> {
  desktopLoad ??= readActiveDesktopState(seeded).catch((error) => {
    desktopLoad = null;
    throw error;
  });
  const manifest = await desktopLoad;
  await materializeOutbox(await callDatabase("readOutbox", undefined));
  return { entries: manifest.entries, layout: desktopStateLayout(manifest), editorSettings: manifest.editorSettings, appearance: manifest.appearance, sync: manifest.sync };
}

async function applyRemoteDesktopUnsafe(snapshot: DesktopStateSnapshot, contents: Map<string, Blob>, acknowledgedOperationId?: string, desktopId = activeDesktopContext, force = false, useAcknowledgedContent = true) {
  if (!desktopId) throw new Error("No desktop is active.");
  const current = parseManifestV13(await callDatabase("readDesktop", { desktopId }, null));
  if (!force && current.sync.catalogId === snapshot.sync.catalogId && current.sync.catalogRevision >= snapshot.sync.catalogRevision) {
    return { entries: current.entries, layout: manifestLayout(current), editorSettings: current.editorSettings, appearance: current.appearance, sync: current.sync };
  }
  const next: Manifest = {
    entries: snapshot.entries,
    snapToGrid: snapshot.layout.snapToGrid,
    wallpaper: snapshot.layout.wallpaper,
    editorSettings: snapshot.editorSettings,
    appearance: snapshot.appearance,
    sync: snapshot.sync,
  };
  assertValidManifest(next);
  const acknowledgedRecord = acknowledgedOperationId && useAcknowledgedContent
    ? (await callDatabase("readOutbox", undefined, null)).find((record) => record.operationId === acknowledgedOperationId)
    : undefined;

  for (const entry of snapshot.entries) {
    if (entry.kind !== "file") continue;
    const changedContent = current.sync.catalogId !== snapshot.sync.catalogId || current.sync.contentRevisions[entry.id] !== snapshot.sync.contentRevisions[entry.id];
    if (!changedContent) continue;
    let content = contents.get(entry.id);
    if (!content && acknowledgedRecord && operationContentIds(acknowledgedRecord.operation).includes(entry.id)) {
      content = await readStagedContent(acknowledgedRecord.operationId, entry.id);
    }
    await removeContentCacheMarker(entry.id);
    if (!content) continue;
    if (content.size !== entry.size) throw new Error(`The server returned invalid contents for “${entry.name}”.`);
    await writeContent(entry.id, content.slice(0, content.size, entry.mimeType));
    if (snapshot.sync.catalogId) await writeContentCacheMarker(entry.id, {
      catalogId: snapshot.sync.catalogId,
      contentRevision: snapshot.sync.contentRevisions[entry.id],
      size: entry.size,
    });
  }
  const reconciled = await callDatabase("applyRemoteWithOutbox", { state: next, acknowledgedOperationId }, desktopId);
  const projected = parseDesktopState(reconciled.state);
  if (desktopId === activeDesktopContext) desktopLoad = Promise.resolve(projected);
  await materializeOutbox(await callDatabase("readOutbox", undefined));

  const retained = await retainedFileIdsUnsafe();
  const directory = await getFilesDirectory();
  for (const entry of current.entries) {
    if (entry.kind !== "file" || retained.has(entry.id)) continue;
    try {
      await directory.removeEntry(entry.id);
      await removeContentCacheMarker(entry.id);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "NotFoundError")) console.warn("Hiraya could not clean up stale file content.", error);
    }
  }
  return { entries: projected.entries, layout: manifestLayout(projected), editorSettings: projected.editorSettings, appearance: projected.appearance, sync: projected.sync };
}

async function enqueueMutationUnsafe(operation: OutboxOperation, contents: Map<string, Blob> = new Map()) {
  const reservation = await callDatabase("reserveOperation", undefined);
  const required = operationContentIds(operation);
  if (required.some((id) => !contents.has(id)) || contents.size !== required.length) throw new Error("Queued file content is incomplete.");
  await stageOperationContents(reservation.operationId, contents);
  try {
    const result = await callDatabase("enqueueMutation", {
      operationId: reservation.operationId,
      catalogId: (await readManifest()).sync.catalogId,
      operation,
    });
    const manifest = parseDesktopState(result.state);
    desktopLoad = Promise.resolve(manifest);
    await materializeOutbox([result.record]);
    return {
      desktop: { entries: manifest.entries, layout: manifestLayout(manifest), editorSettings: manifest.editorSettings, appearance: manifest.appearance, sync: manifest.sync },
      record: result.record,
    };
  } catch (error) {
    await removeStagedOperation(reservation.operationId);
    throw error;
  }
}

async function enqueueTransferUnsafe(sourceDesktopId: string, destinationDesktopId: string, entryIds: string[], parentId: string | null) {
  const reservation = await callDatabase("reserveOperation", undefined);
  const result = await callDatabase("enqueueTransfer", {
    operationId: reservation.operationId,
    catalogId: (await readManifest()).sync.catalogId,
    sourceDesktopId,
    destinationDesktopId,
    entryIds,
    parentId,
  });
  const manifest = parseDesktopState(result.state);
  desktopLoad = Promise.resolve(manifest);
  return {
    desktop: { entries: manifest.entries, layout: manifestLayout(manifest), editorSettings: manifest.editorSettings, appearance: manifest.appearance, sync: manifest.sync },
    record: result.record,
  };
}

async function acknowledgeMutationUnsafe(operationId: string) {
  await callDatabase("acknowledgeMutation", { operationId });
  await removeStagedOperation(operationId);
}

async function saveEditorSettingsUnsafe(settings: EditorSettings) {
  const manifest = { ...await readManifest(), editorSettings: settings };
  assertValidManifest(manifest);
  await writeManifest(manifest, activityRecord("Changed editor settings", [
    `Auto-save: ${settings.autoSave ? "On" : "Off"}`,
    `Font size: ${settings.fontSize}`,
    `Language: ${settings.language}`,
  ]));
}

async function saveDesktopLayoutUnsafe(layout: DesktopLayout) {
  const manifest = await readManifest();
  const parsed = parseLayout(layout);
  const next = { ...manifest, snapToGrid: parsed.snapToGrid, wallpaper: parsed.wallpaper };
  assertValidManifest(next);
  await writeManifest(next, activityRecord("Changed desktop layout", [
    `Snap to grid: ${parsed.snapToGrid ? "On" : "Off"}`,
    `Wallpaper: ${parsed.wallpaper.source}`,
  ]));
}

async function selectThemeUnsafe(themeId: string) {
  const manifest = await readManifest();
  const appearance = parseThemeState({ ...manifest.appearance, selectedThemeId: themeId });
  await writeManifest({ ...manifest, appearance }, activityRecord("Selected theme", [`Theme: ${appearance.selectedThemeId}`]));
  return appearance;
}

async function saveCustomThemeUnsafe(value: CustomTheme) {
  const manifest = await readManifest();
  const theme = parseCustomTheme(value);
  const exists = manifest.appearance.customThemes.some((item) => item.id === theme.id);
  const customThemes = exists
    ? manifest.appearance.customThemes.map((item) => item.id === theme.id ? theme : item)
    : [...manifest.appearance.customThemes, theme];
  const appearance = parseThemeState({ ...manifest.appearance, customThemes });
  await writeManifest({ ...manifest, appearance }, activityRecord(exists ? "Updated custom theme" : "Created custom theme", [`Theme: ${theme.name}`, `Theme ID: ${theme.id}`]));
  return theme;
}

async function deleteCustomThemeUnsafe(themeId: string) {
  const manifest = await readManifest();
  const next = applyThemeDelete(manifest, themeId);
  const deleted = manifest.appearance.customThemes.find((theme) => theme.id === themeId)!;
  await writeManifest(next, activityRecord("Deleted custom theme", [`Theme: ${deleted.name}`, `Theme ID: ${themeId}`]));
  return next.appearance;
}

function applyThemeDelete(manifest: Manifest, themeId: string) {
  // Keep local and queued mutation semantics identical.
  return parseManifestV13((() => {
    if (!manifest.appearance.customThemes.some((theme) => theme.id === themeId)) throw new Error("That custom theme no longer exists.");
    const customThemes = manifest.appearance.customThemes.filter((theme) => theme.id !== themeId);
    const selectedThemeId = manifest.appearance.selectedThemeId === themeId ? DEFAULT_THEME_STATE.selectedThemeId : manifest.appearance.selectedThemeId;
    return { ...manifest, appearance: parseThemeState({ selectedThemeId, customThemes }) };
  })());
}

async function createTextFileUnsafe(nameValue: string, parentId: string | null, position: EntryPosition) {
  const name = validateEntryName(nameValue);
  const manifest = await readManifest();
  findParent(manifest.entries, parentId);
  assertUniqueName(manifest.entries, name, parentId);

  const now = Date.now();
  const file: FileEntry = {
    kind: "file",
    id: crypto.randomUUID(),
    name,
    parentId,
    mimeType: "text/plain",
    size: 0,
    createdAt: now,
    modifiedAt: now,
    position: parsePosition(position),
  };
  await writeContent(file.id, "");
  await writeManifest({ ...manifest, entries: [...manifest.entries, file] }, activityRecord("Created file", [`File: ${file.name}`, locationDetail(manifest.entries, parentId)]));
  return file;
}

async function createFolderUnsafe(nameValue: string, parentId: string | null, position: EntryPosition) {
  const name = validateEntryName(nameValue);
  const manifest = await readManifest();
  findParent(manifest.entries, parentId);
  assertUniqueName(manifest.entries, name, parentId);

  const now = Date.now();
  const folder: FolderEntry = {
    kind: "folder",
    id: crypto.randomUUID(),
    name,
    parentId,
    createdAt: now,
    modifiedAt: now,
    position: parsePosition(position),
  };
  await writeManifest({ ...manifest, entries: [...manifest.entries, folder] }, activityRecord("Created folder", [`Folder: ${folder.name}`, locationDetail(manifest.entries, parentId)]));
  return folder;
}

async function importFilesUnsafe(
  files: File[],
  parentId: string | null,
  positions: EntryPosition[],
): Promise<FileEntry[]> {
  if (files.length !== positions.length) throw new Error("Each imported file needs a desktop position.");
  const parsedPositions = positions.map(parsePosition);
  const manifest = await readManifest();
  findParent(manifest.entries, parentId);
  const names = files.map((file) => validateEntryName(file.name));

  for (const [index, name] of names.entries()) {
    assertUniqueName(manifest.entries, name, parentId);
    if (names.slice(0, index).some((candidate) => namesMatch(candidate, name))) {
      throw new Error(`The upload contains more than one file named “${name}”.`);
    }
  }

  const createdAt = Date.now();
  const imported: FileEntry[] = files.map((source, index) => ({
    kind: "file",
    id: crypto.randomUUID(),
    name: names[index],
    parentId,
    mimeType: source.type || "application/octet-stream",
    size: source.size,
    createdAt,
    modifiedAt: source.lastModified || createdAt,
    position: parsedPositions[index],
  }));
  for (const [index, file] of imported.entries()) await writeContent(file.id, files[index]);
  await writeManifest({
    ...manifest,
    entries: [...manifest.entries, ...imported],
  }, activityRecord(imported.length === 1 ? "Imported file" : "Imported files", [...activityDetails(imported), locationDetail(manifest.entries, parentId)]));
  return imported;
}

async function createEntriesUnsafe(entries: DesktopEntry[], contents: Map<string, Blob>) {
  const manifest = await readManifest();
  const next = { ...manifest, entries: [...manifest.entries, ...entries] };
  assertValidManifest(next);
  const files = entries.filter((entry): entry is FileEntry => entry.kind === "file");
  if (contents.size !== files.length || files.some((entry) => contents.get(entry.id)?.size !== entry.size)) throw new Error("Copied file content is incomplete.");
  const written: string[] = [];
  try {
    for (const entry of files) {
      await writeContent(entry.id, contents.get(entry.id)!);
      written.push(entry.id);
    }
    await writeManifest(next, activityRecord(entries.length === 1 ? "Pasted item" : "Pasted items", activityDetails(entries)));
  } catch (error) {
    try {
      const directory = await getFilesDirectory();
      for (const id of written) await directory.removeEntry(id).catch(() => undefined);
    } catch { /* best-effort rollback */ }
    throw error;
  }
  return entries;
}

async function renameEntryUnsafe(id: string, nameValue: string) {
  const name = validateEntryName(nameValue);
  const manifest = await readManifest();
  const existing = getEntry(manifest.entries, id);
  assertUniqueName(manifest.entries, name, existing.parentId, id);
  const renamed: DesktopEntry = { ...existing, name, modifiedAt: Date.now() };
  await writeManifest({
    ...manifest,
    entries: manifest.entries.map((entry) => (entry.id === id ? renamed : entry)),
  }, activityRecord(`Renamed ${existing.kind}`, [`From: ${existing.name}`, `To: ${renamed.name}`]));
  return renamed;
}

async function deleteEntryUnsafe(id: string): Promise<DesktopEntry[]> {
  const manifest = await readManifest();
  getEntry(manifest.entries, id);
  const deletedIds = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of manifest.entries) {
      if (entry.parentId !== null && deletedIds.has(entry.parentId) && !deletedIds.has(entry.id)) {
        deletedIds.add(entry.id);
        changed = true;
      }
    }
  }
  const deleted = manifest.entries.filter((entry) => deletedIds.has(entry.id));
  // Remove visible metadata first; failed blob cleanup can then only leave invisible orphans.
  await writeManifest({
    ...manifest,
    entries: manifest.entries.filter((entry) => !deletedIds.has(entry.id)),
    wallpaper: wallpaperAfterEntryRemoval(manifest.entries.filter((entry) => !deletedIds.has(entry.id)), manifest.wallpaper),
  }, activityRecord(deleted.length === 1 ? `Deleted ${deleted[0].kind}` : "Deleted items", activityDetails(deleted)));
  try {
    const directory = await getFilesDirectory();
    for (const entry of deleted) {
      if (entry.kind !== "file") continue;
      try {
        await directory.removeEntry(entry.id);
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "NotFoundError")) {
          console.warn("Hiraya could not clean up deleted file content.", error);
        }
      }
    }
  } catch (error) {
    console.warn("Hiraya could not clean up deleted file content.", error);
  }
  return deleted;
}

async function deleteEntriesUnsafe(ids: string[]): Promise<DesktopEntry[]> {
  if (!ids.length) return [];
  const manifest = await readManifest();
  const selected = new Set(ids);
  if (selected.size !== ids.length || ids.some((id) => !manifest.entries.some((entry) => entry.id === id))) throw new Error("An entry no longer exists.");
  const deletedIds = new Set(ids);
  for (let changed = true; changed;) {
    changed = false;
    for (const entry of manifest.entries) if (entry.parentId && deletedIds.has(entry.parentId) && !deletedIds.has(entry.id)) {
      deletedIds.add(entry.id);
      changed = true;
    }
  }
  const deleted = manifest.entries.filter((entry) => deletedIds.has(entry.id));
  await writeManifest(
    {
      ...manifest,
      entries: manifest.entries.filter((entry) => !deletedIds.has(entry.id)),
      wallpaper: wallpaperAfterEntryRemoval(manifest.entries.filter((entry) => !deletedIds.has(entry.id)), manifest.wallpaper),
    },
    activityRecord(deleted.length === 1 ? `Deleted ${deleted[0].kind}` : "Deleted items", activityDetails(deleted)),
  );
  try {
    const directory = await getFilesDirectory();
    for (const entry of deleted) if (entry.kind === "file") await directory.removeEntry(entry.id).catch(() => undefined);
  } catch (error) { console.warn("Hiraya could not clean up deleted file content.", error); }
  return deleted;
}

async function moveEntryUnsafe(id: string, parentId: string | null, position: EntryPosition) {
  const manifest = await readManifest();
  const existing = getEntry(manifest.entries, id);
  findParent(manifest.entries, parentId);
  if (id === parentId) throw new Error("An entry cannot be moved into itself.");

  let ancestorId = parentId;
  while (ancestorId !== null) {
    if (ancestorId === id) throw new Error("A folder cannot be moved into one of its descendants.");
    ancestorId = getEntry(manifest.entries, ancestorId).parentId;
  }
  assertUniqueName(manifest.entries, existing.name, parentId, id);

  const moved: DesktopEntry = { ...existing, parentId, position: parsePosition(position), modifiedAt: Date.now() };
  await writeManifest({
    ...manifest,
    entries: manifest.entries.map((entry) => (entry.id === id ? moved : entry)),
  }, activityRecord(`Moved ${existing.kind}`, [`${existing.kind === "file" ? "File" : "Folder"}: ${existing.name}`, locationDetail(manifest.entries, parentId)]));
  return moved;
}

async function moveEntriesUnsafe(ids: string[], parentId: string | null) {
  const manifest = await readManifest();
  findParent(manifest.entries, parentId);
  const moving = new Set(ids);
  if (!ids.length || moving.size !== ids.length || ids.some((id) => !manifest.entries.some((entry) => entry.id === id))) throw new Error("An entry no longer exists.");
  const modifiedAt = Date.now();
  const next: Manifest = { ...manifest, entries: manifest.entries.map((entry) => moving.has(entry.id) ? { ...entry, parentId, modifiedAt } : entry) };
  assertValidManifest(next);
  const moved = next.entries.filter((entry) => moving.has(entry.id));
  await writeManifest(next, activityRecord(moved.length === 1 ? `Moved ${moved[0].kind}` : "Moved items", [...activityDetails(moved), locationDetail(manifest.entries, parentId)]));
  return moved;
}

async function updateRootEntryPositionsUnsafe(positionValues: RootEntryPositionUpdate[]) {
  const manifest = await readManifest();
  const positions = parseRootEntryPositionUpdates(positionValues, manifest.entries);
  const byId = new Map(positions.map(({ entryId, position }) => [entryId, position]));
  const next: Manifest = {
    ...manifest,
    entries: manifest.entries.map((entry) => byId.has(entry.id) ? { ...entry, position: byId.get(entry.id)! } : entry),
  };
  assertValidManifest(next);
  const moved = positions.map(({ entryId }) => getEntry(next.entries, entryId));
  await writeManifest(next, activityRecord(moved.length === 1 ? "Moved desktop item" : "Arranged desktop items", activityDetails(moved)));
  return moved;
}

async function updateEntryPositionUnsafe(id: string, position: EntryPosition) {
  const manifest = await readManifest();
  const existing = getEntry(manifest.entries, id);
  const updated: DesktopEntry = { ...existing, position: parsePosition(position) };
  await writeManifest({
    ...manifest,
    entries: manifest.entries.map((entry) => (entry.id === id ? updated : entry)),
  }, activityRecord("Moved desktop item", activityDetails([updated])));
  return updated;
}

async function readFileUnsafe(id: FileEntry["id"]): Promise<File> {
  const manifest = await readManifest();
  const entry = getFileEntry(manifest.entries, id);
  const directory = await getFilesDirectory();
  const handle = await directory.getFileHandle(id);
  const stored = await handle.getFile();
  return new File([stored], entry.name, { type: entry.mimeType, lastModified: entry.modifiedAt });
}

async function readCachedFileUnsafe(desktopId: string, catalogId: string, id: FileEntry["id"], contentRevision: number): Promise<File | null> {
  const manifest = parseManifestV13(await callDatabase("readDesktop", { desktopId }, null));
  const entry = getFileEntry(manifest.entries, id);
  const hasPendingContent = (await callDatabase("readOutbox", undefined, null)).some((record) =>
    record.desktopId === desktopId && operationContentIds(record.operation).includes(id));
  if (!hasPendingContent) {
    const marker = await readContentCacheMarker(id);
    if (!marker || marker.catalogId !== catalogId || marker.contentRevision !== contentRevision || marker.size !== entry.size) return null;
  }
  try {
    const stored = await (await (await getFilesDirectory()).getFileHandle(id)).getFile();
    if (stored.size !== entry.size) {
      if (!hasPendingContent) await removeContentCacheMarker(id);
      return null;
    }
    return new File([stored], entry.name, { type: entry.mimeType, lastModified: entry.modifiedAt });
  } catch (error) {
    if (isNotFound(error)) {
      if (!hasPendingContent) await removeContentCacheMarker(id);
      return null;
    }
    throw error;
  }
}

async function cacheRemoteFileUnsafe(desktopId: string, catalogId: string, id: FileEntry["id"], contentRevision: number, content: Blob): Promise<File | null> {
  const manifest = parseManifestV13(await callDatabase("readDesktop", { desktopId }, null));
  const entry = manifest.entries.find((candidate): candidate is FileEntry => candidate.id === id && candidate.kind === "file");
  if (!entry || manifest.sync.catalogId !== catalogId || manifest.sync.contentRevisions[id] !== contentRevision) return null;
  const hasPendingContent = (await callDatabase("readOutbox", undefined, null)).some((record) =>
    record.desktopId === desktopId && operationContentIds(record.operation).includes(id));
  if (hasPendingContent) return readCachedFileUnsafe(desktopId, catalogId, id, contentRevision);
  if (content.size !== entry.size) throw new Error(`The server contents of “${entry.name}” have an unexpected size.`);
  const stored = content.slice(0, content.size, entry.mimeType);
  await writeContent(id, stored);
  await writeContentCacheMarker(id, { catalogId, contentRevision, size: entry.size });
  return new File([stored], entry.name, { type: entry.mimeType, lastModified: entry.modifiedAt });
}

async function removeCachedFileUnsafe(desktopId: string, catalogId: string, id: FileEntry["id"], contentRevision: number) {
  const manifest = parseManifestV13(await callDatabase("readDesktop", { desktopId }, null));
  const entry = getFileEntry(manifest.entries, id);
  if (manifest.sync.catalogId !== catalogId || manifest.sync.contentRevisions[id] !== contentRevision) return false;
  const hasPendingContent = (await callDatabase("readOutbox", undefined, null)).some((record) => operationContentIds(record.operation).includes(id));
  if (hasPendingContent) throw new Error("Pending file content cannot be removed from offline storage.");
  const marker = await readContentCacheMarker(id);
  if (!marker || marker.catalogId !== catalogId || marker.contentRevision !== contentRevision || marker.size !== entry.size) return false;

  // Remove availability first so interrupted cleanup cannot leave an unverified cache hit.
  await removeContentCacheMarker(id);
  try {
    await (await getFilesDirectory()).removeEntry(id);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  return true;
}

async function captureDesktopStateUnsafe(): Promise<{
  entries: DesktopEntry[];
  layout: DesktopLayout;
  editorSettings: EditorSettings;
  appearance: ThemeState;
  contents: Map<string, Blob>;
}> {
  const manifest = await readManifest();
  const directory = await getFilesDirectory();
  const contents = new Map<string, Blob>();
  for (const entry of manifest.entries) {
    if (entry.kind !== "file") continue;
    const handle = await directory.getFileHandle(entry.id);
    const stored = await handle.getFile();
    if (stored.size !== entry.size) throw new Error(`The stored contents of “${entry.name}” do not match its metadata.`);
    contents.set(entry.id, stored.slice(0, stored.size, entry.mimeType));
  }
  return {
    entries: manifest.entries,
    layout: manifestLayout(manifest),
    editorSettings: manifest.editorSettings,
    appearance: manifest.appearance,
    contents,
  };
}

async function readDesktopStateUnsafe(desktopId: string): Promise<DesktopStateSnapshot> {
  const manifest = parseManifestV13(await callDatabase("readDesktop", { desktopId }, null));
  return { entries: manifest.entries, layout: manifestLayout(manifest), editorSettings: manifest.editorSettings, appearance: manifest.appearance, sync: manifest.sync };
}

async function resolveFileByRelativePathUnsafe(
  fromFileId: FileEntry["id"],
  relativePath: string,
): Promise<FileEntry> {
  const manifest = await readManifest();
  const source = getFileEntry(manifest.entries, fromFileId);
  const path = relativePath.split(/[?#]/, 1)[0];
  if (!path || path.startsWith("/") || path.startsWith("\\") || /^[a-z][a-z\d+.-]*:/i.test(path)) {
    throw new Error("That link is not a local relative file path.");
  }

  let parentId = source.parentId;
  let resolved: DesktopEntry | undefined;
  const encodedSegments = path.split("/");
  for (const [index, encodedSegment] of encodedSegments.entries()) {
    let segment: string;
    try {
      segment = decodeURIComponent(encodedSegment);
    } catch {
      throw new Error("That link contains invalid URL encoding.");
    }
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (parentId === null) throw new Error("That link points outside the desktop.");
      const parent = getEntry(manifest.entries, parentId);
      parentId = parent.parentId;
      resolved = undefined;
      continue;
    }
    if (segment.includes("/") || segment.includes("\\") || [...segment].some((character) => character.charCodeAt(0) < 32)) {
      throw new Error("That link contains an invalid file name.");
    }
    resolved = manifest.entries.find(
      (entry) => entry.parentId === parentId && entry.name.localeCompare(segment, undefined, { sensitivity: "accent" }) === 0,
    );
    if (!resolved) throw new Error(`No local file exists at “${relativePath}”.`);
    if (index < encodedSegments.length - 1 && resolved.kind !== "folder") {
      throw new Error(`No local file exists at “${relativePath}”.`);
    }
    parentId = resolved.kind === "folder" ? resolved.id : resolved.parentId;
  }

  if (!resolved || resolved.kind !== "file") throw new Error(`No local file exists at “${relativePath}”.`);
  return resolved;
}

async function readFileByRelativePathUnsafe(fromFileId: FileEntry["id"], relativePath: string): Promise<{ file: FileEntry; blob: Blob }> {
  const file = await resolveFileByRelativePathUnsafe(fromFileId, relativePath);
  return { file, blob: await readFileUnsafe(file.id) };
}

async function saveTextFileUnsafe(id: FileEntry["id"], content: string): Promise<FileEntry> {
  const manifest = await readManifest();
  const existing = getFileEntry(manifest.entries, id);
  await writeContent(id, content);
  const saved: FileEntry = {
    ...existing,
    size: new Blob([content]).size,
    modifiedAt: Date.now(),
  };
  await writeManifest({
    ...manifest,
    entries: manifest.entries.map((entry) => (entry.id === id ? saved : entry)),
  }, activityRecord("Edited file", [`File: ${saved.name}`, `Size: ${saved.size} bytes`]));
  return saved;
}

export function loadDesktop(viewport: EntryPosition, seeded: SeededManifest | null = null) {
  return serializeStorage(() => loadDesktopUnsafe(viewport, seeded));
}

export function readCurrentDesktop(): Promise<DesktopStateSnapshot> {
  return serializeStorage(async () => {
    const manifest = await readManifest();
    return { entries: manifest.entries, layout: manifestLayout(manifest), editorSettings: manifest.editorSettings, appearance: manifest.appearance, sync: manifest.sync };
  });
}

export function applyRemoteDesktop(snapshot: DesktopStateSnapshot, contents: Map<string, Blob>, acknowledgedOperationId?: string, desktopId?: string, force = false, useAcknowledgedContent = true) {
  return serializeStorage(() => applyRemoteDesktopUnsafe(snapshot, contents, acknowledgedOperationId, desktopId, force, useAcknowledgedContent));
}

export function saveEditorSettings(settings: EditorSettings) { return serializeStorage(() => saveEditorSettingsUnsafe(settings)); }
export function saveDesktopLayout(layout: DesktopLayout) { return serializeStorage(() => saveDesktopLayoutUnsafe(layout)); }
export function selectTheme(themeId: string) { return serializeStorage(() => selectThemeUnsafe(themeId)); }
export function saveCustomTheme(theme: CustomTheme) { return serializeStorage(() => saveCustomThemeUnsafe(theme)); }
export function deleteCustomTheme(themeId: string) { return serializeStorage(() => deleteCustomThemeUnsafe(themeId)); }
export function createTextFile(name: string, parentId: string | null, position: EntryPosition) { return serializeStorage(() => createTextFileUnsafe(name, parentId, position)); }
export function createFolder(name: string, parentId: string | null, position: EntryPosition) { return serializeStorage(() => createFolderUnsafe(name, parentId, position)); }
export function importFiles(files: File[], parentId: string | null, positions: EntryPosition[]) { return serializeStorage(() => importFilesUnsafe(files, parentId, positions)); }
export function createEntries(entries: DesktopEntry[], contents: Map<string, Blob>) { return serializeStorage(() => createEntriesUnsafe(entries, contents)); }
export function renameEntry(id: string, name: string) { return serializeStorage(() => renameEntryUnsafe(id, name)); }
export function deleteEntry(id: string) { return serializeStorage(() => deleteEntryUnsafe(id)); }
export function deleteEntries(ids: string[]) { return serializeStorage(() => deleteEntriesUnsafe(ids)); }
export function moveEntry(id: string, parentId: string | null, position: EntryPosition) { return serializeStorage(() => moveEntryUnsafe(id, parentId, position)); }
export function moveEntries(ids: string[], parentId: string | null) { return serializeStorage(() => moveEntriesUnsafe(ids, parentId)); }
export function updateRootEntryPositions(positions: RootEntryPositionUpdate[]) { return serializeStorage(() => updateRootEntryPositionsUnsafe(positions)); }
export function updateEntryPosition(id: string, position: EntryPosition) { return serializeStorage(() => updateEntryPositionUnsafe(id, position)); }
export function readFile(id: FileEntry["id"]) { return serializeStorage(() => readFileUnsafe(id)); }
export function readCachedFile(desktopId: string, catalogId: string, id: FileEntry["id"], contentRevision: number) { return serializeStorage(() => readCachedFileUnsafe(desktopId, catalogId, id, contentRevision)); }
export function cacheRemoteFile(desktopId: string, catalogId: string, id: FileEntry["id"], contentRevision: number, content: Blob) { return serializeStorage(() => cacheRemoteFileUnsafe(desktopId, catalogId, id, contentRevision, content)); }
export function removeCachedFile(desktopId: string, catalogId: string, id: FileEntry["id"], contentRevision: number) { return serializeStorage(() => removeCachedFileUnsafe(desktopId, catalogId, id, contentRevision)); }
export function captureDesktopState() { return serializeStorage(() => captureDesktopStateUnsafe()); }
export function readDesktopState(desktopId: string) { return serializeStorage(() => readDesktopStateUnsafe(desktopId)); }
export function readFileByRelativePath(fromFileId: FileEntry["id"], relativePath: string) { return serializeStorage(() => readFileByRelativePathUnsafe(fromFileId, relativePath)); }
export function resolveFileByRelativePath(fromFileId: FileEntry["id"], relativePath: string) { return serializeStorage(() => resolveFileByRelativePathUnsafe(fromFileId, relativePath)); }
export function saveTextFile(id: FileEntry["id"], content: string) { return serializeStorage(() => saveTextFileUnsafe(id, content)); }
export function readLocalPreferences() { return serializeStorage(() => readLocalPreferencesUnsafe()); }
export function saveLocalPreferences(preferences: LocalPreferences) { return serializeStorage(() => saveLocalPreferencesUnsafe(preferences)); }
export function listDesktops(seeded: SeededManifest | null = null) { return serializeStorage(() => listDesktopsUnsafe(seeded)); }
export function createDesktop(name: string) { return serializeStorage(() => createDesktopUnsafe(name)); }
export function createOfflineDesktop(name: string) { return serializeStorage(() => createOfflineDesktopUnsafe(name)); }
export function ensureDesktop(desktop: DesktopIdentity) { return serializeStorage(() => ensureDesktopUnsafe(desktop)); }
export function renameDesktop(desktopId: string, name: string) { return serializeStorage(() => renameDesktopUnsafe(desktopId, name)); }
export function deleteDesktop(desktopId: string) { return serializeStorage(() => deleteDesktopUnsafe(desktopId)); }
export function switchDesktop(desktopId: string) { return serializeStorage(() => switchDesktopUnsafe(desktopId)); }
export function pruneLocalDesktops(retainedDesktopIds: string[]) { return serializeStorage(() => pruneLocalDesktopsUnsafe(retainedDesktopIds)); }
export function readDesktopEntries(desktopId: string) { return serializeStorage(() => readDesktopEntriesUnsafe(desktopId)); }
export function transferEntries(sourceDesktopId: string, destinationDesktopId: string, entryIds: string[], parentId: string | null) { return serializeStorage(() => transferEntriesUnsafe(sourceDesktopId, destinationDesktopId, entryIds, parentId)); }
export function readWindowSession(desktopId: string) { return serializeStorage(() => readWindowSessionUnsafe(desktopId)); }
export function saveWindowSession(desktopId: string, session: WindowSession) { return serializeStorage(() => saveWindowSessionUnsafe(desktopId, session)); }
export function enqueueMutation(operation: OutboxOperation, contents?: Map<string, Blob>) { return serializeStorage(() => enqueueMutationUnsafe(operation, contents)); }
export function enqueueTransfer(sourceDesktopId: string, destinationDesktopId: string, entryIds: string[], parentId: string | null) { return serializeStorage(() => enqueueTransferUnsafe(sourceDesktopId, destinationDesktopId, entryIds, parentId)); }
export function readOutbox() { return serializeStorage(() => callDatabase("readOutbox", undefined)); }
export function bindOutboxCatalog(catalogId: string) { return serializeStorage(() => callDatabase("bindOutboxCatalog", { catalogId }, null)); }
export function acknowledgeMutation(operationId: string) { return serializeStorage(() => acknowledgeMutationUnsafe(operationId)); }
export function blockMutation(operationId: string, error: string) { return serializeStorage(() => callDatabase("blockMutation", { operationId, error })); }
export function readPendingContent(operationId: string, entryId: string) { return serializeStorage(() => readStagedContent(operationId, entryId)); }
export function listActivity(query: ActivityQuery = {}) { return serializeStorage(() => callDatabase("listActivity", query)); }
