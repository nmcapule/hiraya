import type { DesktopEntry, DesktopLayout, DesktopView, EditorLanguage, EditorSettings, EntryPosition, FileEntry, FolderEntry } from "../types";
import { assertUniqueName, namesMatch, validateEntryName } from "./entry-validation";
import type { PredefinedManifest } from "./predefined-manifest";

const MANIFEST_NAME = ".hiraya-manifest.json";
const FILES_DIRECTORY = "files";

type ManifestV1 = {
  version: 1;
  files: Array<Omit<FileEntry, "kind" | "parentId" | "viewId">>;
};

type ManifestV2 = {
  version: 2;
  entries: Array<Omit<DesktopEntry, "viewId">>;
};

type ManifestV3 = {
  version: 3;
  entries: DesktopEntry[];
  views: DesktopView[];
  viewColumns: number;
};

type ManifestV4 = {
  version: 4;
  entries: DesktopEntry[];
  views: DesktopView[];
  viewColumns: number;
  editorSettings: Omit<EditorSettings, "autoSave">;
};

type ManifestV5 = {
  version: 5;
  entries: DesktopEntry[];
  views: DesktopView[];
  viewColumns: number;
  editorSettings: EditorSettings;
};

export type DesktopSyncState = {
  revision: number;
  entryRevisions: Record<string, number>;
  contentRevisions: Record<string, number>;
  layoutRevision: number;
  settingsRevision: number;
};

type Manifest = {
  version: 6;
  entries: DesktopEntry[];
  views: DesktopView[];
  viewColumns: number;
  editorSettings: EditorSettings;
  sync: DesktopSyncState;
};

export type DesktopSnapshot = {
  entries: DesktopEntry[];
  layout: DesktopLayout;
  editorSettings: EditorSettings;
  sync: DesktopSyncState;
};

const EMPTY_SYNC_STATE: DesktopSyncState = {
  revision: 0,
  entryRevisions: {},
  contentRevisions: {},
  layoutRevision: 0,
  settingsRevision: 0,
};

const EDITOR_LANGUAGES = new Set<EditorLanguage>(["auto", "plain", "markdown", "json", "javascript", "typescript", "jsx", "tsx", "css", "html", "xml", "yaml"]);
export const DEFAULT_EDITOR_SETTINGS: EditorSettings = { autoSave: true, fontSize: 13, language: "auto" };

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
}

function assertValidManifest(manifest: Manifest) {
  const { editorSettings, entries, views, viewColumns } = manifest;
  const byId = new Map<string, DesktopEntry>();
  const viewIds = new Set<string>();

  if (!Number.isInteger(viewColumns) || viewColumns < 1 || !Array.isArray(views) || views.length < 1) {
    throw new Error("The desktop view layout has an unsupported format.");
  }
  if (
    !editorSettings ||
    typeof editorSettings.autoSave !== "boolean" ||
    !Number.isInteger(editorSettings.fontSize) ||
    editorSettings.fontSize < 11 ||
    editorSettings.fontSize > 22 ||
    !EDITOR_LANGUAGES.has(editorSettings.language)
  ) {
    throw new Error("The editor settings have an unsupported format.");
  }
  for (const view of views) {
    if (!view || typeof view.id !== "string" || viewIds.has(view.id)) {
      throw new Error("The desktop view layout has an unsupported format.");
    }
    viewIds.add(view.id);
  }

  for (const entry of entries) {
    if (!entry || (entry.kind !== "file" && entry.kind !== "folder") || typeof entry.id !== "string") {
      throw new Error("The storage index has an unsupported format.");
    }
    if (byId.has(entry.id)) throw new Error("The storage index contains duplicate entry IDs.");
    byId.set(entry.id, entry);
  }

  for (const entry of entries) {
    if (entry.parentId === null && !viewIds.has(entry.viewId ?? "")) {
      throw new Error("The storage index refers to a missing desktop view.");
    }
    if (entry.parentId !== null && entry.viewId !== null) {
      throw new Error("Items inside folders cannot belong to a desktop view.");
    }
    if (entry.parentId !== null && typeof entry.parentId !== "string") {
      throw new Error("The storage index contains an invalid parent ID.");
    }
    if (entry.parentId === entry.id) throw new Error("The storage index contains a folder cycle.");
    if (entry.parentId !== null) {
      const parent = byId.get(entry.parentId);
      if (!parent) throw new Error("The storage index refers to a missing parent folder.");
      if (parent.kind !== "folder") throw new Error("The storage index contains an entry whose parent is a file.");
    }

    const visited = new Set<string>([entry.id]);
    let parentId = entry.parentId;
    while (parentId !== null) {
      if (visited.has(parentId)) throw new Error("The storage index contains a folder cycle.");
      visited.add(parentId);
      parentId = byId.get(parentId)?.parentId ?? null;
    }
  }
}

function migrateEntries(entries: Array<Omit<DesktopEntry, "viewId">>, viewport: EntryPosition): Manifest {
  const width = Math.max(1, viewport.x);
  const height = Math.max(1, viewport.y);
  const rootEntries = entries.filter((entry) => entry.parentId === null);
  const columns = Math.max(1, ...rootEntries.map((entry) => Math.floor(entry.position.x / width) + 1));
  const rows = Math.max(1, ...rootEntries.map((entry) => Math.floor(entry.position.y / height) + 1));
  const views = Array.from({ length: columns * rows }, () => ({ id: crypto.randomUUID() }));
  return {
    version: 6,
    viewColumns: columns,
    views,
    editorSettings: DEFAULT_EDITOR_SETTINGS,
    sync: EMPTY_SYNC_STATE,
    entries: entries.map((entry) => {
      if (entry.parentId !== null) return { ...entry, viewId: null } as DesktopEntry;
      const column = Math.floor(entry.position.x / width);
      const row = Math.floor(entry.position.y / height);
      return {
        ...entry,
        viewId: views[row * columns + column].id,
        position: { x: entry.position.x % width, y: entry.position.y % height },
      } as DesktopEntry;
    }),
  };
}

async function createManifestFromPredefined(predefined: PredefinedManifest): Promise<Manifest> {
  const files = predefined.entries.filter((entry) => entry.kind === "file");
  const contents = await Promise.all(files.map(async (entry) => {
    const response = await fetch(entry.contentUrl);
    if (!response.ok) throw new Error(`The predefined file “${entry.name}” could not be loaded (${response.status}).`);
    const blob = await response.blob();
    if (blob.size !== entry.size) {
      throw new Error(`The predefined file “${entry.name}” has size ${blob.size}, but its manifest declares ${entry.size}.`);
    }
    return blob.slice(0, blob.size, entry.mimeType);
  }));
  const entries: DesktopEntry[] = predefined.entries.map((entry) => {
    if (entry.kind === "folder") return entry;
    const { contentUrl, ...file } = entry;
    void contentUrl;
    return file;
  });
  const created: Manifest = {
    version: 6,
    entries,
    views: predefined.layout.views,
    viewColumns: predefined.layout.columns,
    editorSettings: predefined.editorSettings,
    sync: EMPTY_SYNC_STATE,
  };
  assertValidManifest(created);
  for (const [index, file] of files.entries()) await writeContent(file.id, contents[index]);
  await writeManifest(created);
  return created;
}

async function readManifest(
  viewport: EntryPosition = { x: window.innerWidth, y: Math.max(1, window.innerHeight - 44) },
  predefined: PredefinedManifest | null = null,
): Promise<Manifest> {
  const root = await getRoot();

  try {
    const handle = await root.getFileHandle(MANIFEST_NAME);
    const file = await handle.getFile();
    const parsed = JSON.parse(await file.text()) as Manifest | ManifestV5 | ManifestV4 | ManifestV3 | ManifestV2 | ManifestV1;

    if (parsed.version === 1 && Array.isArray(parsed.files)) {
      const migrated = migrateEntries(
        parsed.files.map((entry) => ({ ...entry, kind: "file" as const, parentId: null })),
        viewport,
      );
      assertValidManifest(migrated);
      await writeManifest(migrated);
      return migrated;
    }
    if (parsed.version === 2 && Array.isArray(parsed.entries)) {
      const migrated = migrateEntries(parsed.entries, viewport);
      assertValidManifest(migrated);
      await writeManifest(migrated);
      return migrated;
    }
    if (parsed.version === 3 && Array.isArray(parsed.entries)) {
      const migrated: Manifest = { ...parsed, version: 6, editorSettings: DEFAULT_EDITOR_SETTINGS, sync: EMPTY_SYNC_STATE };
      assertValidManifest(migrated);
      await writeManifest(migrated);
      return migrated;
    }
    if (parsed.version === 4 && Array.isArray(parsed.entries)) {
      const migrated: Manifest = { ...parsed, version: 6, editorSettings: { ...parsed.editorSettings, autoSave: true }, sync: EMPTY_SYNC_STATE };
      assertValidManifest(migrated);
      await writeManifest(migrated);
      return migrated;
    }
    if (parsed.version === 5 && Array.isArray(parsed.entries)) {
      const migrated: Manifest = { ...parsed, version: 6, sync: EMPTY_SYNC_STATE };
      assertValidManifest(migrated);
      await writeManifest(migrated);
      return migrated;
    }
    if (parsed.version !== 6 || !Array.isArray(parsed.entries)) {
      throw new Error("The storage index has an unsupported format.");
    }

    assertValidManifest(parsed);
    return parsed;
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") {
      if (predefined) return createManifestFromPredefined(predefined);
      const created: Manifest = { version: 6, entries: [], views: [{ id: crypto.randomUUID() }], viewColumns: 1, editorSettings: DEFAULT_EDITOR_SETTINGS, sync: EMPTY_SYNC_STATE };
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

export async function loadDesktop(viewport: EntryPosition, predefined: PredefinedManifest | null = null): Promise<DesktopSnapshot> {
  desktopLoad ??= readManifest(viewport, predefined).catch((error) => {
    desktopLoad = null;
    throw error;
  });
  const manifest = await desktopLoad;
  return { entries: manifest.entries, layout: { views: manifest.views, columns: manifest.viewColumns }, editorSettings: manifest.editorSettings, sync: manifest.sync };
}

export async function applyRemoteDesktop(snapshot: DesktopSnapshot, contents: Map<string, Blob>) {
  const current = await readManifest();
  const next: Manifest = {
    version: 6,
    entries: snapshot.entries,
    views: snapshot.layout.views,
    viewColumns: snapshot.layout.columns,
    editorSettings: snapshot.editorSettings,
    sync: snapshot.sync,
  };
  assertValidManifest(next);

  for (const entry of snapshot.entries) {
    if (entry.kind !== "file") continue;
    const changedContent = current.sync.contentRevisions[entry.id] !== snapshot.sync.contentRevisions[entry.id];
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

export async function saveEditorSettings(settings: EditorSettings) {
  const manifest = { ...await readManifest(), editorSettings: settings };
  assertValidManifest(manifest);
  await writeManifest(manifest);
}

function resolveViewId(manifest: Manifest, parentId: string | null, viewId: string | null) {
  if (parentId !== null) return null;
  if (!manifest.views.some((view) => view.id === viewId)) throw new Error("That desktop view no longer exists.");
  return viewId;
}

export async function saveDesktopLayout(layout: DesktopLayout) {
  const manifest = await readManifest();
  const next = { ...manifest, views: layout.views, viewColumns: layout.columns };
  assertValidManifest(next);
  await writeManifest(next);
}

export async function createTextFile(nameValue: string, parentId: string | null, position: EntryPosition, viewId: string | null) {
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
    position,
    viewId: resolveViewId(manifest, parentId, viewId),
  };
  await writeContent(file.id, "");
  await writeManifest({ ...manifest, entries: [...manifest.entries, file] });
  return file;
}

export async function createFolder(nameValue: string, parentId: string | null, position: EntryPosition, viewId: string | null) {
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
    position,
    viewId: resolveViewId(manifest, parentId, viewId),
  };
  await writeManifest({ ...manifest, entries: [...manifest.entries, folder] });
  return folder;
}

export async function importFiles(
  files: File[],
  parentId: string | null,
  positions: EntryPosition[],
  viewId: string | null,
): Promise<FileEntry[]> {
  if (files.length !== positions.length) throw new Error("Each imported file needs a desktop position.");
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
    position: positions[index],
    viewId: resolveViewId(manifest, parentId, viewId),
  }));
  for (const [index, file] of imported.entries()) await writeContent(file.id, files[index]);
  await writeManifest({ ...manifest, entries: [...manifest.entries, ...imported] });
  return imported;
}

export async function renameEntry(id: string, nameValue: string) {
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

export async function deleteEntry(id: string): Promise<DesktopEntry[]> {
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
  await writeManifest({ ...manifest, entries: manifest.entries.filter((entry) => !deletedIds.has(entry.id)) });
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

export async function moveEntry(id: string, parentId: string | null, position: EntryPosition, viewId: string | null) {
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

  const moved: DesktopEntry = { ...existing, parentId, position, viewId: resolveViewId(manifest, parentId, viewId), modifiedAt: Date.now() };
  await writeManifest({
    ...manifest,
    entries: manifest.entries.map((entry) => (entry.id === id ? moved : entry)),
  });
  return moved;
}

export async function updateEntryPosition(id: string, position: EntryPosition, viewId: string | null) {
  const manifest = await readManifest();
  const existing = getEntry(manifest.entries, id);
  const updated: DesktopEntry = { ...existing, position, viewId: resolveViewId(manifest, existing.parentId, viewId) };
  await writeManifest({
    ...manifest,
    entries: manifest.entries.map((entry) => (entry.id === id ? updated : entry)),
  });
  return updated;
}

export async function readFile(id: FileEntry["id"]): Promise<File> {
  const manifest = await readManifest();
  const entry = getFileEntry(manifest.entries, id);
  const directory = await getFilesDirectory();
  const handle = await directory.getFileHandle(id);
  const stored = await handle.getFile();
  return new File([stored], entry.name, { type: entry.mimeType, lastModified: entry.modifiedAt });
}

export async function readDesktopSnapshot(): Promise<{
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
    layout: { views: manifest.views, columns: manifest.viewColumns },
    editorSettings: manifest.editorSettings,
    contents,
  };
}

export async function readFileByRelativePath(
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

export async function saveTextFile(id: FileEntry["id"], content: string): Promise<FileEntry> {
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
