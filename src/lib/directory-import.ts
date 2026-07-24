import type { DesktopEntry, EntryPosition, FileEntry } from "../types";
import { parseEntries } from "./contracts";
import { namesMatch, validateEntryName } from "./entry-validation";
import { fileFromEntry, readAllDirectoryEntries } from "./file-system-entry";

export type ImportSource = {
  relativePath: string;
  file?: File;
};

export type ImportPlan = {
  entries: DesktopEntry[];
  contents: Map<string, Blob>;
  rootIds: string[];
  destinationParentId: string | null;
  folderCount: number;
  fileCount: number;
  totalBytes: number;
};

type DirectoryPickerEnvironment = {
  HTMLInputElement?: { prototype: object };
  showDirectoryPicker?: unknown;
};

const unsupportedDropMessage = "Folder drag and drop is not supported by this browser. Use Import folder or upload the files separately.";

export function supportsDirectoryPicker(environment: DirectoryPickerEnvironment = globalThis) {
  return typeof environment.showDirectoryPicker === "function" || Boolean(environment.HTMLInputElement && "webkitdirectory" in environment.HTMLInputElement.prototype);
}

export function supportsDirectoryHandlePicker(environment: DirectoryPickerEnvironment = globalThis) {
  return typeof environment.showDirectoryPicker === "function";
}

export function sourcesFromDirectoryPicker(files: readonly File[]): ImportSource[] {
  return files.map((file) => ({ relativePath: file.webkitRelativePath, file }));
}

async function sourcesFromEntry(entry: FileSystemEntry, parentPath = ""): Promise<ImportSource[]> {
  const relativePath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
  if (entry.isDirectory) {
    const children = await readAllDirectoryEntries(entry as FileSystemDirectoryEntry);
    const descendants: ImportSource[] = [];
    for (const child of children) descendants.push(...await sourcesFromEntry(child, relativePath));
    return [{ relativePath }, ...descendants];
  }
  if (!entry.isFile) throw new Error("The dropped folder contains an unsupported filesystem item.");
  return [{ relativePath, file: await fileFromEntry(entry as FileSystemFileEntry) }];
}

type IterableDirectoryHandle = FileSystemDirectoryHandle & {
  values(): AsyncIterableIterator<FileSystemFileHandle | IterableDirectoryHandle>;
};

async function sourcesFromHandle(handle: FileSystemFileHandle | IterableDirectoryHandle, parentPath = ""): Promise<ImportSource[]> {
  const relativePath = parentPath ? `${parentPath}/${handle.name}` : handle.name;
  if (handle.kind === "file") return [{ relativePath, file: await handle.getFile() }];
  const result: ImportSource[] = [{ relativePath }];
  for await (const child of handle.values()) result.push(...await sourcesFromHandle(child, relativePath));
  return result;
}

export function sourcesFromDirectoryHandle(handle: FileSystemDirectoryHandle) {
  const iterable = handle as IterableDirectoryHandle;
  if (typeof iterable.values !== "function") throw new Error("This browser cannot enumerate the selected folder safely.");
  return sourcesFromHandle(iterable);
}

export async function sourcesFromDrop(dataTransfer: Pick<DataTransfer, "items" | "files">): Promise<ImportSource[]> {
  const items = Array.from(dataTransfer.items).filter((item) => item.kind === "file");
  const roots: FileSystemEntry[] = [];
  let entryApiAvailable = false;
  let missingEntry = false;
  for (const item of items) {
    const getEntry = (item as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null }).webkitGetAsEntry;
    if (typeof getEntry !== "function") { missingEntry = true; continue; }
    entryApiAvailable = true;
    const entry = getEntry.call(item);
    if (entry) roots.push(entry); else missingEntry = true;
  }
  if (roots.length && missingEntry) throw new Error("The drop contains an item this browser did not expose. Nothing was imported.");
  if (roots.length) {
    const sources: ImportSource[] = [];
    for (const root of roots) sources.push(...await sourcesFromEntry(root));
    return sources;
  }

  const files = Array.from(dataTransfer.files);
  if (files.some((file) => file.webkitRelativePath)) return sourcesFromDirectoryPicker(files);
  if (items.some((item) => item.getAsFile() === null) || entryApiAvailable && items.length !== files.length) {
    throw new Error(unsupportedDropMessage);
  }
  return files.map((file) => ({ relativePath: file.name, file }));
}

export type ImportOperationContext = {
  operationId: string;
  desktopId: string;
  parentId: string | null;
  activationGeneration: number;
  position?: EntryPosition;
};

export function assertImportOperationCurrent(context: ImportOperationContext, current: { desktopId: string; activationGeneration: number; entries: readonly DesktopEntry[] }) {
  if (context.desktopId !== current.desktopId || context.activationGeneration !== current.activationGeneration) {
    throw new DOMException("The import was cancelled because the active desktop changed.", "AbortError");
  }
  if (context.parentId !== null && !current.entries.some((entry) => entry.id === context.parentId && entry.kind === "folder")) {
    throw new DOMException("The import was cancelled because its destination folder is no longer available.", "AbortError");
  }
}

function safeSegments(path: string) {
  if (!path || path.startsWith("/") || path.includes("\\")) throw new Error(`The import contains an unsafe path: “${path || "(empty)"}”.`);
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) throw new Error(`The import contains an unsafe path: “${path}”.`);
  return segments.map((segment) => {
    try {
      const name = validateEntryName(segment);
      if (name !== segment) throw new Error("non-canonical path segment");
      return name;
    } catch {
      throw new Error(`The import contains an invalid path segment in “${path}”.`);
    }
  });
}

export function buildImportPlan(
  sources: readonly ImportSource[],
  options: {
    destinationParentId: string | null;
    existingEntries: readonly DesktopEntry[];
    positionForRoot: (index: number) => EntryPosition;
    createId?: () => string;
    now?: number;
  },
): ImportPlan {
  if (!sources.length) throw new Error("The selected folder does not contain any importable items.");
  const existing = [...options.existingEntries];
  if (options.destinationParentId !== null && !existing.some((entry) => entry.id === options.destinationParentId && entry.kind === "folder")) {
    throw new Error("The import destination folder no longer exists.");
  }

  const explicit = new Map<string, { segments: string[]; file?: File }>();
  for (const source of sources) {
    const segments = safeSegments(source.relativePath);
    const key = segments.map((segment) => segment.toLowerCase()).join("/");
    if (explicit.has(key)) throw new Error(`The import contains a duplicate relative path: “${source.relativePath}”.`);
    explicit.set(key, { segments, file: source.file });
  }

  const nodes = new Map<string, { segments: string[]; file?: File }>();
  for (const source of explicit.values()) {
    source.segments.forEach((_, index) => {
      const segments = source.segments.slice(0, index + 1);
      const key = segments.map((segment) => segment.toLowerCase()).join("/");
      const file = index === source.segments.length - 1 ? source.file : undefined;
      const prior = nodes.get(key);
      if (prior?.file || file && prior) throw new Error(`The import contains conflicting items at “${segments.join("/")}”.`);
      nodes.set(key, { segments, file });
    });
  }

  const ordered = [...nodes.entries()].sort(([leftKey, left], [rightKey, right]) =>
    left.segments.length - right.segments.length || leftKey.localeCompare(rightKey),
  );
  const rootNodes = ordered.filter(([, node]) => node.segments.length === 1);
  for (const [, root] of rootNodes) {
    const conflict = existing.find((entry) => entry.parentId === options.destinationParentId && namesMatch(entry.name, root.segments[0]));
    if (conflict) throw new Error(`Cannot import “${root.segments[0]}”: an entry with that name already exists in the destination.`);
  }

  const createId = options.createId ?? (() => crypto.randomUUID());
  const now = options.now ?? Date.now();
  const ids = new Map(ordered.map(([key]) => [key, createId()]));
  const rootIndex = new Map(rootNodes.map(([key], index) => [key, index]));
  const siblingIndexes = new Map<string, number>();
  const entries = ordered.map(([key, node]): DesktopEntry => {
    const parentKey = node.segments.slice(0, -1).map((segment) => segment.toLowerCase()).join("/");
    const parentId = node.segments.length === 1 ? options.destinationParentId : ids.get(parentKey)!;
    const siblingIndex = siblingIndexes.get(parentKey) ?? 0;
    siblingIndexes.set(parentKey, siblingIndex + 1);
    const position = node.segments.length === 1 ? options.positionForRoot(rootIndex.get(key)!) : { x: 8, y: 8 + siblingIndex * 88 };
    const common = { id: ids.get(key)!, name: node.segments.at(-1)!, parentId, createdAt: now, modifiedAt: node.file?.lastModified || now, position };
    return node.file
      ? { ...common, kind: "file", mimeType: node.file.type || "application/octet-stream", size: node.file.size }
      : { ...common, kind: "folder" };
  });
  parseEntries([...existing, ...entries]);

  const files = entries.filter((entry): entry is FileEntry => entry.kind === "file");
  const contents = new Map<string, Blob>();
  for (const file of files) {
    const key = ordered.find(([path]) => ids.get(path) === file.id)![0];
    contents.set(file.id, nodes.get(key)!.file!);
  }
  return {
    entries,
    contents,
    rootIds: rootNodes.map(([key]) => ids.get(key)!),
    destinationParentId: options.destinationParentId,
    folderCount: entries.length - files.length,
    fileCount: files.length,
    totalBytes: files.reduce((total, file) => total + file.size, 0),
  };
}
