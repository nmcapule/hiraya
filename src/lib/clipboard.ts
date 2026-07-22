import { strToU8, unzip, zip, type Zippable } from "fflate";
import type { DesktopEntry } from "../types";
import { isRecord, isValidId, parseEntries } from "./contracts";

export const CLIPBOARD_ARCHIVE_VERSION = 1 as const;
export const CLIPBOARD_ARCHIVE_MIME_TYPE = "application/x-hiraya-entry-archive+zip";
export const CLIPBOARD_ARCHIVE_WEB_MIME_TYPE = `web ${CLIPBOARD_ARCHIVE_MIME_TYPE}`;

export type ClipboardEntrySnapshot = {
  selectedRootIds: string[];
  entries: DesktopEntry[];
  contents: Map<string, Blob>;
};

type ClipboardManifest = {
  version: typeof CLIPBOARD_ARCHIVE_VERSION;
  selectedRootIds: string[];
  entries: DesktopEntry[];
};

const MANIFEST_PATH = "manifest.json";
const textDecoder = new TextDecoder("utf-8", { fatal: true });

function hasExactKeys(value: Record<string, unknown>, keys: string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function assertExactEntryShape(value: unknown) {
  if (!isRecord(value) || !isRecord(value.position) || !hasExactKeys(value.position, ["x", "y"])) {
    throw new Error("A clipboard entry has an unsupported format.");
  }
  const keys = value.kind === "file"
    ? ["kind", "id", "name", "parentId", "modifiedAt", "position", "mimeType", "size"]
    : ["kind", "id", "name", "parentId", "modifiedAt", "position"];
  if (!hasExactKeys(value, keys)) throw new Error("A clipboard entry has an unsupported format.");
}

function parseManifest(value: unknown): ClipboardManifest {
  if (!isRecord(value) || !hasExactKeys(value, ["version", "selectedRootIds", "entries"]) || value.version !== CLIPBOARD_ARCHIVE_VERSION || !Array.isArray(value.selectedRootIds) || !Array.isArray(value.entries)) {
    throw new Error("The clipboard archive has an unsupported manifest.");
  }
  value.entries.forEach(assertExactEntryShape);
  const entries = parseEntries(value.entries) as DesktopEntry[];
  const selectedRootIds = value.selectedRootIds;
  const selected = new Set<string>();
  for (const id of selectedRootIds) {
    if (!isValidId(id) || selected.has(id)) throw new Error("The clipboard archive has invalid selected root IDs.");
    selected.add(id);
  }
  const roots = entries.filter((entry) => entry.parentId === null).map((entry) => entry.id);
  if (selected.size === 0 || selected.size !== roots.length || roots.some((id) => !selected.has(id))) {
    throw new Error("The clipboard archive does not contain exactly its selected trees.");
  }
  return { version: CLIPBOARD_ARCHIVE_VERSION, selectedRootIds: [...selectedRootIds], entries };
}

function contentPath(id: string) {
  return `files/${encodeURIComponent(id)}`;
}

function assertSafeArchivePath(path: string) {
  if (path.startsWith("/") || path.includes("\\") || path.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("The clipboard archive contains an unsafe path.");
  }
}

function validateSnapshot(snapshot: ClipboardEntrySnapshot) {
  if (!isRecord(snapshot) || !(snapshot.contents instanceof Map)) throw new Error("The clipboard snapshot has an unsupported format.");
  const manifest = parseManifest({
    version: CLIPBOARD_ARCHIVE_VERSION,
    selectedRootIds: snapshot.selectedRootIds,
    entries: snapshot.entries,
  });
  const files = new Map(manifest.entries.filter((entry) => entry.kind === "file").map((entry) => [entry.id, entry]));
  if (snapshot.contents.size !== files.size) throw new Error("The clipboard snapshot has missing or extra file contents.");
  for (const [id, content] of snapshot.contents) {
    const file = files.get(id);
    if (!file || !(content instanceof Blob)) throw new Error("The clipboard snapshot has missing or extra file contents.");
    if (content.size !== file.size) throw new Error(`Clipboard file content size does not match entry “${file.name}”.`);
  }
  return manifest;
}

function createZip(files: Zippable) {
  return new Promise<Uint8Array>((resolve, reject) => {
    zip(files, { level: 6 }, (error, archive) => error ? reject(error) : resolve(archive));
  });
}

function openZip(bytes: Uint8Array) {
  return new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    unzip(bytes, (error, files) => error ? reject(new Error("The clipboard archive is not a valid ZIP file.", { cause: error })) : resolve(files));
  });
}

export async function encodeClipboardArchive(snapshot: ClipboardEntrySnapshot): Promise<Blob> {
  const manifest = validateSnapshot(snapshot);
  const files: Zippable = { [MANIFEST_PATH]: strToU8(JSON.stringify(manifest)) };
  await Promise.all(manifest.entries.map(async (entry) => {
    if (entry.kind === "file") files[contentPath(entry.id)] = new Uint8Array(await snapshot.contents.get(entry.id)!.arrayBuffer());
  }));
  const archive = await createZip(files);
  return new Blob([archive.slice().buffer as ArrayBuffer], { type: CLIPBOARD_ARCHIVE_MIME_TYPE });
}

export async function decodeClipboardArchive(archive: Blob): Promise<ClipboardEntrySnapshot> {
  const files = await openZip(new Uint8Array(await archive.arrayBuffer()));
  const paths = Object.keys(files);
  paths.forEach(assertSafeArchivePath);
  const manifestBytes = files[MANIFEST_PATH];
  if (!manifestBytes) throw new Error("The clipboard archive is missing its manifest.");
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(textDecoder.decode(manifestBytes));
  } catch (error) {
    throw new Error("The clipboard archive has an invalid manifest.", { cause: error });
  }
  const manifest = parseManifest(manifestValue);
  const fileEntries = manifest.entries.filter((entry) => entry.kind === "file");
  const expectedPaths = new Set([MANIFEST_PATH, ...fileEntries.map((entry) => contentPath(entry.id))]);
  if (paths.length !== expectedPaths.size || paths.some((path) => !expectedPaths.has(path))) {
    throw new Error("The clipboard archive contains missing or extra files.");
  }
  const contents = new Map<string, Blob>();
  for (const entry of fileEntries) {
    const bytes = files[contentPath(entry.id)];
    if (!bytes || bytes.byteLength !== entry.size) throw new Error(`Clipboard file content size does not match entry “${entry.name}”.`);
    contents.set(entry.id, new Blob([bytes.slice().buffer as ArrayBuffer], { type: entry.mimeType }));
  }
  return { selectedRootIds: manifest.selectedRootIds, entries: manifest.entries, contents };
}

export function isClipboardArchiveType(type: string) {
  return type === CLIPBOARD_ARCHIVE_WEB_MIME_TYPE || type === CLIPBOARD_ARCHIVE_MIME_TYPE;
}

export async function createClipboardArchiveItem(snapshot: ClipboardEntrySnapshot): Promise<ClipboardItem> {
  return new ClipboardItem({ [CLIPBOARD_ARCHIVE_WEB_MIME_TYPE]: await encodeClipboardArchive(snapshot) });
}

export async function decodeClipboardArchiveItem(item: Pick<ClipboardItem, "types" | "getType">) {
  const type = item.types.find(isClipboardArchiveType);
  if (!type) throw new Error("The clipboard does not contain a Hiraya entry archive.");
  return decodeClipboardArchive(await item.getType(type));
}

function entryFile(entry: FileSystemFileEntry) {
  return new Promise<File>((resolve, reject) => entry.file(resolve, reject));
}

async function directoryEntries(entry: FileSystemDirectoryEntry) {
  const reader = entry.createReader();
  const result: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) return result;
    result.push(...batch);
  }
}

export async function snapshotFromClipboardItems(items: DataTransferItemList): Promise<ClipboardEntrySnapshot | null> {
  const roots = Array.from(items).map((item) => item.webkitGetAsEntry()).filter((entry): entry is FileSystemEntry => entry !== null);
  if (!roots.length) return null;
  const entries: DesktopEntry[] = [];
  const contents = new Map<string, Blob>();
  const selectedRootIds: string[] = [];

  async function visit(source: FileSystemEntry, parentId: string | null) {
    const id = crypto.randomUUID();
    const position = { x: 8, y: 8 };
    if (parentId === null) selectedRootIds.push(id);
    if (source.isDirectory) {
      entries.push({ kind: "folder", id, name: source.name, parentId, modifiedAt: Date.now(), position });
      for (const child of await directoryEntries(source as FileSystemDirectoryEntry)) await visit(child, id);
      return;
    }
    if (!source.isFile) throw new Error("The clipboard contains an unsupported filesystem item.");
    const file = await entryFile(source as FileSystemFileEntry);
    entries.push({ kind: "file", id, name: source.name || file.name, parentId, mimeType: file.type || "application/octet-stream", size: file.size, modifiedAt: file.lastModified || Date.now(), position });
    contents.set(id, file);
  }

  for (const root of roots) await visit(root, null);
  const snapshot = { selectedRootIds, entries, contents };
  validateSnapshot(snapshot);
  return snapshot;
}
