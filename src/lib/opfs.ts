import { DEFAULT_WALLPAPER, type DesktopEntry, type DesktopLayout, type DesktopPositionUpdate, type EditorSettings, type EntryPosition, type FileEntry, type FolderEntry } from "../types";
import { assertUniqueName, namesMatch, validateEntryName } from "./entry-validation";
import { parseBundledSeededManifest, type SeededManifest } from "./seeded-manifest";
import {
  DEFAULT_EDITOR_SETTINGS,
  decodeManifest,
  emptySyncState,
  manifestLayout,
  parseManifestV13,
  type DesktopSyncState,
  type PersistedManifestV13,
} from "./manifest-codec";
import { parseLayout, parsePosition, parseRootDesktopPositions } from "./contracts";
import type { StorageDbMethod, StorageDbRequests, StorageDbResponse, StorageDbResponses } from "./opfs-db-protocol";
import type { OutboxOperation, OutboxRecord } from "./outbox";
import { DEFAULT_THEME_STATE, parseCustomTheme, parseThemeState, type CustomTheme, type ThemeState } from "./themes";
import { parseWindowSession, type WindowSession } from "./window-session";
import { activityRecord, type ActivityQuery, type NewActivityRecord } from "./activity";

const MANIFEST_NAME = ".hiraya-manifest.json";
const PREFERENCES_NAME = ".hiraya-preferences.json";
const FILES_DIRECTORY = "files";
const PENDING_DIRECTORY = "pending";

type Manifest = PersistedManifestV13;
export type { DesktopSyncState } from "./manifest-codec";

export type DesktopSnapshot = {
  entries: DesktopEntry[];
  layout: DesktopLayout;
  editorSettings: EditorSettings;
  appearance: ThemeState;
  sync: DesktopSyncState;
};

export type LocalPreferences = { autoUpdate: boolean };

export { DEFAULT_EDITOR_SETTINGS } from "./manifest-codec";

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

  return navigator.storage.getDirectory();
}

async function getFilesDirectory() {
  const root = await getRoot();
  return root.getDirectoryHandle(FILES_DIRECTORY, { create: true });
}

async function getPendingDirectory() {
  const root = await getRoot();
  return root.getDirectoryHandle(PENDING_DIRECTORY, { create: true });
}

async function writeManifest(manifest: Manifest, activity?: NewActivityRecord) {
  await callDatabase("replaceManifest", { manifest, activity });
  desktopLoad = Promise.resolve(manifest);
}

function activityDetails(entries: DesktopEntry[]) {
  const names = entries.slice(0, 18).map((entry) => `${entry.kind === "file" ? "File" : "Folder"}: ${entry.name}`);
  if (entries.length > names.length) names.push(`Additional items: ${entries.length - names.length}`);
  return names;
}

function locationDetail(entries: DesktopEntry[], parentId: string | null) {
  return `Location: ${parentId === null ? "Desktop" : entries.find((entry) => entry.id === parentId)?.name ?? "Unknown folder"}`;
}

function assertValidManifest(manifest: Manifest) {
  parseManifestV13(manifest);
}

async function createManifestFromSeeded(seeded: SeededManifest): Promise<Manifest> {
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
  const entries: DesktopEntry[] = parsedSeeded.entries.map((entry) => {
    if (entry.kind === "folder") return entry;
    const { contentUrl, ...file } = entry;
    void contentUrl;
    return file;
  });
  const created: Manifest = {
    version: 13,
    entries,
    snapToGrid: parsedSeeded.layout.snapToGrid,
    wallpaper: parsedSeeded.layout.wallpaper,
    editorSettings: parsedSeeded.editorSettings,
    appearance: parsedSeeded.appearance,
    sync: emptySyncState(),
  };
  assertValidManifest(created);
  for (const [index, file] of files.entries()) await writeContent(file.id, contents[index]);
  return created;
}

function isNotFound(error: unknown): error is DOMException {
  return error instanceof DOMException && error.name === "NotFoundError";
}

async function readLegacyPreferences(root: FileSystemDirectoryHandle): Promise<LocalPreferences> {
  try {
    const handle = await root.getFileHandle(PREFERENCES_NAME);
    const value: unknown = JSON.parse(await (await handle.getFile()).text());
    if (!value || typeof value !== "object" || (value as Record<string, unknown>).version !== 1 || typeof (value as Record<string, unknown>).autoUpdate !== "boolean") {
      throw new Error("The local preferences have an unsupported format.");
    }
    return { autoUpdate: (value as Record<string, unknown>).autoUpdate as boolean };
  } catch (error) {
    if (isNotFound(error)) return { autoUpdate: true };
    throw error;
  }
}

async function validateReferencedContents(manifest: Manifest) {
  const directory = await getFilesDirectory();
  for (const entry of manifest.entries) {
    if (entry.kind !== "file") continue;
    let stored: File;
    try {
      stored = await (await directory.getFileHandle(entry.id)).getFile();
    } catch (error) {
      if (isNotFound(error)) throw new Error(`The stored contents of “${entry.name}” are missing.`);
      throw error;
    }
    if (stored.size !== entry.size) throw new Error(`The stored contents of “${entry.name}” do not match its metadata.`);
  }
}

async function removeLegacyFile(root: FileSystemDirectoryHandle, name: string) {
  try {
    await root.removeEntry(name);
  } catch (error) {
    if (!isNotFound(error)) console.warn(`Hiraya could not remove migrated ${name}.`, error);
  }
}

async function initializeDatabase(seeded: SeededManifest | null): Promise<Manifest> {
  const root = await getRoot();
  const status = await callDatabase("status", undefined);
  if (!status.needsBootstrap) return parseManifestV13(await callDatabase("readManifest", undefined));

  let legacyManifest: Manifest | null = null;
  let hasLegacyManifest = false;
  try {
    const handle = await root.getFileHandle(MANIFEST_NAME);
    hasLegacyManifest = true;
    const file = await handle.getFile();
    legacyManifest = decodeManifest(JSON.parse(await file.text())).manifest;
    await validateReferencedContents(legacyManifest);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  const manifest = legacyManifest ?? (seeded && !status.existedBeforeOpen
    ? await createManifestFromSeeded(seeded)
    : { version: 13, entries: [], snapToGrid: false, wallpaper: DEFAULT_WALLPAPER, editorSettings: DEFAULT_EDITOR_SETTINGS, appearance: DEFAULT_THEME_STATE, sync: emptySyncState() });
  const preferences = hasLegacyManifest ? await readLegacyPreferences(root) : await callDatabase("readPreferences", undefined);
  const bootstrapped = await callDatabase("bootstrap", { manifest, preferences });
  if (hasLegacyManifest) {
    await removeLegacyFile(root, MANIFEST_NAME);
    await removeLegacyFile(root, PREFERENCES_NAME);
  }
  return bootstrapped.manifest;
}

async function readManifest(seeded: SeededManifest | null = null): Promise<Manifest> {
  databaseInitialization ??= initializeDatabase(seeded).then(() => undefined).catch((error) => {
    databaseInitialization = null;
    throw error;
  });
  await databaseInitialization;
  return parseManifestV13(await callDatabase("readManifest", undefined));
}

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

let desktopLoad: Promise<Manifest> | null = null;
let databaseInitialization: Promise<void> | null = null;
let storageWork: Promise<void> = Promise.resolve();

type RpcPort = {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent<StorageDbResponse>) => void): void;
  start?: () => void;
};

let databasePort: Promise<RpcPort> | null = null;
let hostedDatabaseWorker: Worker | null = null;
let hostedDatabaseRequestId: number | null = null;
let requestId = 0;
const pendingRequests = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
const OWNER_CHANGED_MESSAGE = "The local database owner changed. Retry the operation.";
const RETRYABLE_OWNER_CHANGE_METHODS = new Set<StorageDbMethod>(["status", "bootstrap", "readManifest", "readPreferences", "readWindowSession", "readOutbox", "listActivity"]);

class LocalDatabaseOwnerChangedError extends Error {}

function openDatabasePort(): RpcPort {
  let port: RpcPort;
  if (typeof SharedWorker !== "undefined") {
    const shared = new SharedWorker(new URL("./opfs-shared.worker.ts", import.meta.url), { type: "module", name: "hiraya-storage" });
    port = shared.port;
    shared.port.addEventListener("message", (event) => {
      const message = event.data as { type?: string; requestId?: number };
      if (message.type !== "need-engine" || message.requestId === undefined) return;
      if (hostedDatabaseWorker && hostedDatabaseRequestId === message.requestId) return;
      hostedDatabaseWorker?.terminate();
      const candidateRequestId = message.requestId;
      const worker = new Worker(new URL("./opfs-db.worker.ts", import.meta.url), { type: "module", name: "hiraya-sqlite-engine" });
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
      worker.postMessage({ type: "attach", port: channel.port1 }, [channel.port1]);
    });
    window.addEventListener("pagehide", () => {
      if (!hostedDatabaseWorker || hostedDatabaseRequestId === null) return;
      const releasedRequestId = hostedDatabaseRequestId;
      hostedDatabaseWorker.terminate();
      hostedDatabaseWorker = null;
      hostedDatabaseRequestId = null;
      shared.port.postMessage({ type: "release-engine", requestId: releasedRequestId });
    }, { once: true });
  } else {
    port = new Worker(new URL("./opfs-db.worker.ts", import.meta.url), { type: "module", name: "hiraya-storage-fallback" });
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

async function callDatabase<M extends StorageDbMethod>(method: M, params: StorageDbRequests[M]): Promise<StorageDbResponses[M]> {
  await getRoot();
  databasePort ??= Promise.resolve().then(openDatabasePort);
  const port = await databasePort;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const id = ++requestId;
      return await new Promise<StorageDbResponses[M]>((resolve, reject) => {
        pendingRequests.set(id, { resolve: (value) => resolve(value as StorageDbResponses[M]), reject });
        port.postMessage({ id, method, params });
      });
    } catch (error) {
      if (!(error instanceof LocalDatabaseOwnerChangedError) || attempt > 0 || !RETRYABLE_OWNER_CHANGE_METHODS.has(method)) throw error;
    }
  }
}

function withCrossContextLock<T>(operation: () => Promise<T>) {
  if (!("locks" in navigator) || !navigator.locks) return operation();
  return navigator.locks.request("hiraya-opfs", { mode: "exclusive" }, operation);
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

async function readWindowSessionUnsafe() {
  await callDatabase("status", undefined);
  return parseWindowSession(await callDatabase("readWindowSession", undefined));
}

async function saveWindowSessionUnsafe(session: WindowSession) {
  await callDatabase("status", undefined);
  await callDatabase("writeWindowSession", { session: parseWindowSession(session) });
}

async function loadDesktopUnsafe(_viewport: EntryPosition, seeded: SeededManifest | null = null): Promise<DesktopSnapshot> {
  desktopLoad ??= readManifest(seeded).catch((error) => {
    desktopLoad = null;
    throw error;
  });
  const manifest = await desktopLoad;
  await materializeOutbox(await callDatabase("readOutbox", undefined));
  return { entries: manifest.entries, layout: manifestLayout(manifest), editorSettings: manifest.editorSettings, appearance: manifest.appearance, sync: manifest.sync };
}

async function applyRemoteDesktopUnsafe(snapshot: DesktopSnapshot, contents: Map<string, Blob>, acknowledgedOperationId?: string) {
  const current = await readManifest();
  if (current.sync.workspaceId === snapshot.sync.workspaceId && current.sync.revision >= snapshot.sync.revision) {
    return { entries: current.entries, layout: manifestLayout(current), editorSettings: current.editorSettings, appearance: current.appearance, sync: current.sync };
  }
  const next: Manifest = {
    version: 13,
    entries: snapshot.entries,
    snapToGrid: snapshot.layout.snapToGrid,
    wallpaper: snapshot.layout.wallpaper,
    editorSettings: snapshot.editorSettings,
    appearance: snapshot.appearance,
    sync: snapshot.sync,
  };
  assertValidManifest(next);

  for (const entry of snapshot.entries) {
    if (entry.kind !== "file") continue;
    const changedContent = current.sync.workspaceId !== snapshot.sync.workspaceId || current.sync.contentRevisions[entry.id] !== snapshot.sync.contentRevisions[entry.id];
    if (!changedContent) continue;
    const content = contents.get(entry.id);
    if (!content || content.size !== entry.size) throw new Error(`The server returned invalid contents for “${entry.name}”.`);
    await writeContent(entry.id, content.slice(0, content.size, entry.mimeType));
  }
  const reconciled = await callDatabase("applyRemoteWithOutbox", { manifest: next, acknowledgedOperationId });
  const projected = parseManifestV13(reconciled.manifest);
  desktopLoad = Promise.resolve(projected);
  await materializeOutbox(await callDatabase("readOutbox", undefined));

  const retained = new Set(projected.entries.filter((entry) => entry.kind === "file").map((entry) => entry.id));
  const directory = await getFilesDirectory();
  for (const entry of current.entries) {
    if (entry.kind !== "file" || retained.has(entry.id)) continue;
    try {
      await directory.removeEntry(entry.id);
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
      workspaceId: (await readManifest()).sync.workspaceId,
      operation,
    });
    const manifest = parseManifestV13(result.manifest);
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
    `Wallpaper: ${parsed.wallpaper}`,
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

  const file: FileEntry = {
    kind: "file",
    id: crypto.randomUUID(),
    name,
    parentId,
    mimeType: "text/plain",
    size: 0,
    modifiedAt: Date.now(),
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

  const folder: FolderEntry = {
    kind: "folder",
    id: crypto.randomUUID(),
    name,
    parentId,
    modifiedAt: Date.now(),
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

  const imported: FileEntry[] = files.map((source, index) => ({
    kind: "file",
    id: crypto.randomUUID(),
    name: names[index],
    parentId,
    mimeType: source.type || "application/octet-stream",
    size: source.size,
    modifiedAt: source.lastModified || Date.now(),
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
    { ...manifest, entries: manifest.entries.filter((entry) => !deletedIds.has(entry.id)) },
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

async function updateDesktopPositionsUnsafe(positionValues: DesktopPositionUpdate[]) {
  const manifest = await readManifest();
  const positions = parseRootDesktopPositions(positionValues, manifest.entries);
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

async function readDesktopSnapshotUnsafe(): Promise<{
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

async function readFileByRelativePathUnsafe(
  fromFileId: FileEntry["id"],
  relativePath: string,
): Promise<{ file: FileEntry; blob: Blob }> {
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
  const directory = await getFilesDirectory();
  const handle = await directory.getFileHandle(resolved.id);
  const stored = await handle.getFile();
  return { file: resolved, blob: stored.slice(0, stored.size, resolved.mimeType) };
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

export function readCurrentDesktop(): Promise<DesktopSnapshot> {
  return serializeStorage(async () => {
    const manifest = await readManifest();
    return { entries: manifest.entries, layout: manifestLayout(manifest), editorSettings: manifest.editorSettings, appearance: manifest.appearance, sync: manifest.sync };
  });
}

export function applyRemoteDesktop(snapshot: DesktopSnapshot, contents: Map<string, Blob>, acknowledgedOperationId?: string) {
  return serializeStorage(() => applyRemoteDesktopUnsafe(snapshot, contents, acknowledgedOperationId));
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
export function updateDesktopPositions(positions: DesktopPositionUpdate[]) { return serializeStorage(() => updateDesktopPositionsUnsafe(positions)); }
export function updateEntryPosition(id: string, position: EntryPosition) { return serializeStorage(() => updateEntryPositionUnsafe(id, position)); }
export function readFile(id: FileEntry["id"]) { return serializeStorage(() => readFileUnsafe(id)); }
export function readDesktopSnapshot() { return serializeStorage(() => readDesktopSnapshotUnsafe()); }
export function readFileByRelativePath(fromFileId: FileEntry["id"], relativePath: string) { return serializeStorage(() => readFileByRelativePathUnsafe(fromFileId, relativePath)); }
export function saveTextFile(id: FileEntry["id"], content: string) { return serializeStorage(() => saveTextFileUnsafe(id, content)); }
export function readLocalPreferences() { return serializeStorage(() => readLocalPreferencesUnsafe()); }
export function saveLocalPreferences(preferences: LocalPreferences) { return serializeStorage(() => saveLocalPreferencesUnsafe(preferences)); }
export function readWindowSession() { return serializeStorage(() => readWindowSessionUnsafe()); }
export function saveWindowSession(session: WindowSession) { return serializeStorage(() => saveWindowSessionUnsafe(session)); }
export function enqueueMutation(operation: OutboxOperation, contents?: Map<string, Blob>) { return serializeStorage(() => enqueueMutationUnsafe(operation, contents)); }
export function readOutbox() { return serializeStorage(() => callDatabase("readOutbox", undefined)); }
export function bindOutboxWorkspace(workspaceId: string) { return serializeStorage(() => callDatabase("bindOutboxWorkspace", { workspaceId })); }
export function acknowledgeMutation(operationId: string) { return serializeStorage(() => acknowledgeMutationUnsafe(operationId)); }
export function blockMutation(operationId: string, error: string) { return serializeStorage(() => callDatabase("blockMutation", { operationId, error })); }
export function readPendingContent(operationId: string, entryId: string) { return serializeStorage(() => readStagedContent(operationId, entryId)); }
export function listActivity(query: ActivityQuery = {}) { return serializeStorage(() => callDatabase("listActivity", query)); }
