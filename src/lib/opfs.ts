import { DEFAULT_WALLPAPER, type DesktopEntry, type DesktopLayout, type DesktopPositionUpdate, type EditorSettings, type EntryPosition, type FileEntry, type FolderEntry } from "../types";
import { assertUniqueName, namesMatch, validateEntryName } from "./entry-validation";
import { parseBundledSeededManifest, type SeededManifest } from "./seeded-manifest";
import {
  DEFAULT_EDITOR_SETTINGS,
  decodeManifest,
  emptySyncState,
  manifestLayout,
  parseManifestV12,
  type DesktopSyncState,
  type PersistedManifestV12,
} from "./manifest-codec";
import { parseLayout, parsePosition, parseRootDesktopPositions } from "./contracts";

const MANIFEST_NAME = ".hiraya-manifest.json";
const PREFERENCES_NAME = ".hiraya-preferences.json";
const FILES_DIRECTORY = "files";

type Manifest = PersistedManifestV12;
export type { DesktopSyncState } from "./manifest-codec";

export type DesktopSnapshot = {
  entries: DesktopEntry[];
  layout: DesktopLayout;
  editorSettings: EditorSettings;
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

async function writeManifest(manifest: Manifest) {
  const root = await getRoot();
  const handle = await root.getFileHandle(MANIFEST_NAME, { create: true });
  const writable = await handle.createWritable();

  try {
    await writable.write(JSON.stringify(manifest));
  } finally {
    await writable.close();
  }
  desktopLoad = Promise.resolve(manifest);
}

function assertValidManifest(manifest: Manifest) {
  parseManifestV12(manifest);
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
    version: 12,
    entries,
    snapToGrid: parsedSeeded.layout.snapToGrid,
    wallpaper: parsedSeeded.layout.wallpaper,
    editorSettings: parsedSeeded.editorSettings,
    sync: emptySyncState(),
  };
  assertValidManifest(created);
  for (const [index, file] of files.entries()) await writeContent(file.id, contents[index]);
  await writeManifest(created);
  return created;
}

async function readManifest(
  seeded: SeededManifest | null = null,
): Promise<Manifest> {
  const root = await getRoot();

  try {
    const handle = await root.getFileHandle(MANIFEST_NAME);
    const file = await handle.getFile();
    const decoded = decodeManifest(JSON.parse(await file.text()));
    if (decoded.migrated) await writeManifest(decoded.manifest);
    return decoded.manifest;
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") {
      if (seeded) return createManifestFromSeeded(seeded);
       const created: Manifest = { version: 12, entries: [], snapToGrid: false, wallpaper: DEFAULT_WALLPAPER, editorSettings: DEFAULT_EDITOR_SETTINGS, sync: emptySyncState() };
      await writeManifest(created);
      return created;
    }
    throw error;
  }
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
let storageWork: Promise<void> = Promise.resolve();

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
  const root = await getRoot();
  let handle: FileSystemFileHandle;
  try {
    handle = await root.getFileHandle(PREFERENCES_NAME);
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return { autoUpdate: true };
    throw error;
  }
  const value: unknown = JSON.parse(await (await handle.getFile()).text());
  if (!value || typeof value !== "object" || (value as Record<string, unknown>).version !== 1 || typeof (value as Record<string, unknown>).autoUpdate !== "boolean") {
    throw new Error("The local preferences have an unsupported format.");
  }
  return { autoUpdate: (value as Record<string, unknown>).autoUpdate as boolean };
}

async function saveLocalPreferencesUnsafe(preferences: LocalPreferences) {
  const root = await getRoot();
  const handle = await root.getFileHandle(PREFERENCES_NAME, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(JSON.stringify({ version: 1, autoUpdate: preferences.autoUpdate }));
  } finally {
    await writable.close();
  }
}

async function loadDesktopUnsafe(_viewport: EntryPosition, seeded: SeededManifest | null = null): Promise<DesktopSnapshot> {
  desktopLoad ??= readManifest(seeded).catch((error) => {
    desktopLoad = null;
    throw error;
  });
  const manifest = await desktopLoad;
  return { entries: manifest.entries, layout: manifestLayout(manifest), editorSettings: manifest.editorSettings, sync: manifest.sync };
}

async function applyRemoteDesktopUnsafe(snapshot: DesktopSnapshot, contents: Map<string, Blob>) {
  const current = await readManifest();
  if (current.sync.workspaceId === snapshot.sync.workspaceId && current.sync.revision >= snapshot.sync.revision) {
    return { entries: current.entries, layout: manifestLayout(current), editorSettings: current.editorSettings, sync: current.sync };
  }
  const next: Manifest = {
    version: 12,
    entries: snapshot.entries,
    snapToGrid: snapshot.layout.snapToGrid,
    wallpaper: snapshot.layout.wallpaper,
    editorSettings: snapshot.editorSettings,
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
  await writeManifest(next);
  desktopLoad = Promise.resolve(next);

  const retained = new Set(snapshot.entries.filter((entry) => entry.kind === "file").map((entry) => entry.id));
  const directory = await getFilesDirectory();
  for (const entry of current.entries) {
    if (entry.kind !== "file" || retained.has(entry.id)) continue;
    try {
      await directory.removeEntry(entry.id);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "NotFoundError")) console.warn("Hiraya could not clean up stale file content.", error);
    }
  }
  return snapshot;
}

async function saveEditorSettingsUnsafe(settings: EditorSettings) {
  const manifest = { ...await readManifest(), editorSettings: settings };
  assertValidManifest(manifest);
  await writeManifest(manifest);
}

async function saveDesktopLayoutUnsafe(layout: DesktopLayout) {
  const manifest = await readManifest();
  const parsed = parseLayout(layout);
  const next = { ...manifest, snapToGrid: parsed.snapToGrid, wallpaper: parsed.wallpaper };
  assertValidManifest(next);
  await writeManifest(next);
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
  await writeManifest({ ...manifest, entries: [...manifest.entries, file] });
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
  await writeManifest({ ...manifest, entries: [...manifest.entries, folder] });
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
  });
  return imported;
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
  });
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
  });
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
  });
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
  await writeManifest(next);
  return positions.map(({ entryId }) => getEntry(next.entries, entryId));
}

async function updateEntryPositionUnsafe(id: string, position: EntryPosition) {
  const manifest = await readManifest();
  const existing = getEntry(manifest.entries, id);
  const updated: DesktopEntry = { ...existing, position: parsePosition(position) };
  await writeManifest({
    ...manifest,
    entries: manifest.entries.map((entry) => (entry.id === id ? updated : entry)),
  });
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
  });
  return saved;
}

export function loadDesktop(viewport: EntryPosition, seeded: SeededManifest | null = null) {
  return serializeStorage(() => loadDesktopUnsafe(viewport, seeded));
}

export function readCurrentDesktop(): Promise<DesktopSnapshot> {
  return serializeStorage(async () => {
    const manifest = await readManifest();
    return { entries: manifest.entries, layout: manifestLayout(manifest), editorSettings: manifest.editorSettings, sync: manifest.sync };
  });
}

export function applyRemoteDesktop(snapshot: DesktopSnapshot, contents: Map<string, Blob>) {
  return serializeStorage(() => applyRemoteDesktopUnsafe(snapshot, contents));
}

export function saveEditorSettings(settings: EditorSettings) { return serializeStorage(() => saveEditorSettingsUnsafe(settings)); }
export function saveDesktopLayout(layout: DesktopLayout) { return serializeStorage(() => saveDesktopLayoutUnsafe(layout)); }
export function createTextFile(name: string, parentId: string | null, position: EntryPosition) { return serializeStorage(() => createTextFileUnsafe(name, parentId, position)); }
export function createFolder(name: string, parentId: string | null, position: EntryPosition) { return serializeStorage(() => createFolderUnsafe(name, parentId, position)); }
export function importFiles(files: File[], parentId: string | null, positions: EntryPosition[]) { return serializeStorage(() => importFilesUnsafe(files, parentId, positions)); }
export function renameEntry(id: string, name: string) { return serializeStorage(() => renameEntryUnsafe(id, name)); }
export function deleteEntry(id: string) { return serializeStorage(() => deleteEntryUnsafe(id)); }
export function moveEntry(id: string, parentId: string | null, position: EntryPosition) { return serializeStorage(() => moveEntryUnsafe(id, parentId, position)); }
export function updateDesktopPositions(positions: DesktopPositionUpdate[]) { return serializeStorage(() => updateDesktopPositionsUnsafe(positions)); }
export function updateEntryPosition(id: string, position: EntryPosition) { return serializeStorage(() => updateEntryPositionUnsafe(id, position)); }
export function readFile(id: FileEntry["id"]) { return serializeStorage(() => readFileUnsafe(id)); }
export function readDesktopSnapshot() { return serializeStorage(() => readDesktopSnapshotUnsafe()); }
export function readFileByRelativePath(fromFileId: FileEntry["id"], relativePath: string) { return serializeStorage(() => readFileByRelativePathUnsafe(fromFileId, relativePath)); }
export function saveTextFile(id: FileEntry["id"], content: string) { return serializeStorage(() => saveTextFileUnsafe(id, content)); }
export function readLocalPreferences() { return serializeStorage(() => readLocalPreferencesUnsafe()); }
export function saveLocalPreferences(preferences: LocalPreferences) { return serializeStorage(() => saveLocalPreferencesUnsafe(preferences)); }
