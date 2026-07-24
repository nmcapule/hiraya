import { Unzip, UnzipInflate } from "fflate";

export const LIMITS = {
  archiveBytes: 32 * 1024 * 1024,
  entries: 2_000,
  entryBytes: 32 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
  compressionRatio: 100,
} as const;

export type ArchiveEntry = {
  path: string;
  rawName: string;
  name: string;
  kind: "file" | "folder";
  compressedSize: number;
  uncompressedSize: number;
  compression: "Stored" | "Deflate" | "Folder";
  modifiedAt: Date | null;
  crc32: number;
  explicit: boolean;
};

export type Archive = {
  bytes: Uint8Array;
  entries: ArchiveEntry[];
  totalBytes: number;
};

const decoder = new TextDecoder("utf-8", { fatal: true });

export function inspectArchive(buffer: ArrayBuffer): Archive {
  if (buffer.byteLength > LIMITS.archiveBytes) throw new Error(`The ZIP exceeds the ${formatLimit(LIMITS.archiveBytes)} archive limit.`);
  const bytes = new Uint8Array(buffer);
  if (bytes.byteLength < 22) throw new Error("This is not a complete ZIP archive.");
  const view = new DataView(buffer);
  const eocd = findEndRecord(view);
  const disk = view.getUint16(eocd + 4, true);
  const centralDisk = view.getUint16(eocd + 6, true);
  const diskEntries = view.getUint16(eocd + 8, true);
  const entryCount = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  const commentLength = view.getUint16(eocd + 20, true);
  if (eocd + 22 + commentLength !== bytes.length) throw new Error("Trailing or malformed ZIP data is not supported.");
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== entryCount) throw new Error("Multi-disk ZIP archives are not supported.");
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new Error("ZIP64 archives are not supported.");
  if (entryCount > LIMITS.entries) throw new Error(`The ZIP has more than ${LIMITS.entries.toLocaleString()} entries.`);
  if (centralOffset + centralSize !== eocd || centralOffset + centralSize > bytes.length) throw new Error("The ZIP central directory is malformed.");

  const entries: ArchiveEntry[] = [];
  const paths = new Map<string, "file" | "folder">();
  const ranges: Array<[number, number]> = [];
  let totalBytes = 0;
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > eocd || view.getUint32(offset, true) !== 0x02014b50) throw new Error("The ZIP central directory is malformed.");
    const madeBy = view.getUint16(offset + 4, true);
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const dosTime = view.getUint16(offset + 12, true);
    const dosDate = view.getUint16(offset + 14, true);
    const crc32 = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const entryCommentLength = view.getUint16(offset + 32, true);
    const startDisk = view.getUint16(offset + 34, true);
    const externalAttributes = view.getUint32(offset + 38, true);
    const localOffset = view.getUint32(offset + 42, true);
    const nextOffset = offset + 46 + nameLength + extraLength + entryCommentLength;
    if (nextOffset > eocd || nameLength === 0) throw new Error("The ZIP contains a malformed entry.");
    if (flags & 0x0001 || flags & 0x0040) throw new Error("Encrypted ZIP entries are not supported.");
    if (flags & 0x0020) throw new Error("Patched ZIP entries are not supported.");
    if (method !== 0 && method !== 8) throw new Error(`Compression method ${method} is not supported.`);
    if (startDisk !== 0 || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) throw new Error("ZIP64 and multi-disk entries are not supported.");
    if (uncompressedSize > LIMITS.entryBytes) throw new Error(`An entry exceeds the ${formatLimit(LIMITS.entryBytes)} per-file limit.`);
    if (uncompressedSize > 1024 * 1024 && (compressedSize === 0 || uncompressedSize / compressedSize > LIMITS.compressionRatio)) throw new Error(`An entry exceeds the ${LIMITS.compressionRatio}:1 compression ratio limit.`);
    totalBytes += uncompressedSize;
    if (totalBytes > LIMITS.totalBytes) throw new Error(`The ZIP exceeds the ${formatLimit(LIMITS.totalBytes)} unpacked limit.`);

    const rawName = decodeName(bytes.subarray(offset + 46, offset + 46 + nameLength), Boolean(flags & 0x0800));
    const folderAttribute = Boolean(externalAttributes & 0x10);
    const isFolder = rawName.endsWith("/") || folderAttribute;
    const path = safePath(rawName, isFolder);
    const unixMode = madeBy >> 8 === 3 ? externalAttributes >>> 16 : 0;
    if ((unixMode & 0xf000) === 0xa000) throw new Error(`Symbolic link entry "${path}" is not supported.`);
    if (paths.has(path)) throw new Error(`Duplicate archive path "${path}" is not supported.`);
    paths.set(path, isFolder ? "folder" : "file");

    validateLocalHeader(view, bytes, localOffset, rawName, flags, method, crc32, compressedSize, uncompressedSize, centralOffset, ranges);
    entries.push({
      path,
      rawName,
      name: path.slice(path.lastIndexOf("/") + 1),
      kind: isFolder ? "folder" : "file",
      compressedSize,
      uncompressedSize,
      compression: isFolder ? "Folder" : method === 0 ? "Stored" : "Deflate",
      modifiedAt: dosDateTime(dosDate, dosTime),
      crc32,
      explicit: true,
    });
    offset = nextOffset;
  }
  if (offset !== eocd) throw new Error("The ZIP central directory entry count is inconsistent.");

  addImplicitFolders(entries, paths);
  entries.sort((a, b) => a.path.localeCompare(b.path));
  ranges.sort((a, b) => a[0] - b[0]);
  for (let index = 1; index < ranges.length; index += 1) if (ranges[index][0] < ranges[index - 1][1]) throw new Error("Overlapping ZIP entries are not supported.");
  return { bytes, entries, totalBytes };
}

export async function extractFiles(archive: Archive, paths: ReadonlySet<string>): Promise<Map<string, Uint8Array>> {
  const wanted = new Map(archive.entries.filter((entry) => entry.kind === "file" && paths.has(entry.path)).map((entry) => [entry.rawName, entry]));
  const extracted = new Map<string, Uint8Array>();
  let failure: Error | null = null;
  const stream = new Unzip((file) => {
    const entry = wanted.get(file.name);
    if (!entry) return;
    const data = new Uint8Array(entry.uncompressedSize);
    let offset = 0;
    file.ondata = (error, chunk, final) => {
      if (failure) return;
      if (error) { failure = error; return; }
      if (offset + chunk.length > data.length) { failure = new Error(`Size verification failed for "${entry.path}".`); return; }
      data.set(chunk, offset);
      offset += chunk.length;
      if (!final) return;
      if (offset !== data.length) { failure = new Error(`Size verification failed for "${entry.path}".`); return; }
      if (crc(data) !== entry.crc32) { failure = new Error(`Checksum verification failed for "${entry.path}".`); return; }
      extracted.set(entry.path, data);
    };
    file.start();
  });
  stream.register(UnzipInflate);
  const chunkSize = 64 * 1024;
  for (let offset = 0; offset < archive.bytes.length && !failure; offset += chunkSize) {
    const end = Math.min(offset + chunkSize, archive.bytes.length);
    try {
      stream.push(archive.bytes.subarray(offset, end), end === archive.bytes.length);
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  if (failure) throw failure;
  if (extracted.size !== wanted.size) throw new Error("The ZIP did not contain every selected file.");
  return extracted;
}

function findEndRecord(view: DataView): number {
  const minimum = Math.max(0, view.byteLength - 65_557);
  for (let offset = view.byteLength - 22; offset >= minimum; offset -= 1) if (view.getUint32(offset, true) === 0x06054b50) return offset;
  throw new Error("The ZIP end record is missing.");
}

function decodeName(value: Uint8Array, utf8: boolean): string {
  if (!utf8 && value.some((byte) => byte > 0x7f)) throw new Error("Legacy non-ASCII ZIP filenames are not supported.");
  try {
    return utf8 ? decoder.decode(value) : String.fromCharCode(...value);
  } catch {
    throw new Error("The ZIP contains an invalid UTF-8 filename.");
  }
}

function safePath(rawName: string, folder: boolean): string {
  if (rawName.includes("\\") || rawName.startsWith("/") || /^[A-Za-z]:/.test(rawName) || rawName.includes("\0")) throw new Error("The ZIP contains an unsafe absolute path.");
  const path = folder && rawName.endsWith("/") ? rawName.slice(0, -1) : rawName;
  if (!path || path.length > 4_096) throw new Error("The ZIP contains an invalid or overlong path.");
  const segments = path.split("/");
  if (segments.some((part) => !part || part === "." || part === ".." || part.length > 255 || [...part].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  }))) {
    throw new Error(`The ZIP contains an unsafe path: "${path}".`);
  }
  return segments.join("/");
}

function validateLocalHeader(view: DataView, bytes: Uint8Array, offset: number, name: string, flags: number, method: number, crc32: number, compressedSize: number, uncompressedSize: number, centralOffset: number, ranges: Array<[number, number]>): void {
  if (offset + 30 > centralOffset || view.getUint32(offset, true) !== 0x04034b50) throw new Error(`The local header for "${name}" is malformed.`);
  const localFlags = view.getUint16(offset + 6, true);
  const localMethod = view.getUint16(offset + 8, true);
  const localCRC32 = view.getUint32(offset + 14, true);
  const localCompressedSize = view.getUint32(offset + 18, true);
  const localUncompressedSize = view.getUint32(offset + 22, true);
  const nameLength = view.getUint16(offset + 26, true);
  const extraLength = view.getUint16(offset + 28, true);
  const dataStart = offset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + compressedSize;
  if (localFlags !== flags || localMethod !== method || dataEnd > centralOffset) throw new Error(`The local header for "${name}" is inconsistent.`);
  if (!(flags & 0x0008) && (localCRC32 !== crc32 || localCompressedSize !== compressedSize || localUncompressedSize !== uncompressedSize)) throw new Error(`The local metadata for "${name}" is inconsistent.`);
  const localName = decodeName(bytes.subarray(offset + 30, offset + 30 + nameLength), Boolean(flags & 0x0800));
  if (localName !== name) throw new Error(`The local filename for "${name}" is inconsistent.`);
  ranges.push([offset, dataEnd]);
}

function addImplicitFolders(entries: ArchiveEntry[], paths: Map<string, "file" | "folder">): void {
  for (const entry of [...entries]) {
    const segments = entry.path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const path = segments.slice(0, index).join("/");
      const existing = paths.get(path);
      if (existing === "file") throw new Error(`Archive path "${path}" is both a file and a folder.`);
      if (!existing) {
        paths.set(path, "folder");
        entries.push({ path, rawName: `${path}/`, name: segments[index - 1], kind: "folder", compressedSize: 0, uncompressedSize: 0, compression: "Folder", modifiedAt: null, crc32: 0, explicit: false });
      }
    }
  }
  for (const entry of entries) {
    if (entry.kind === "file" && [...paths].some(([path]) => path.startsWith(`${entry.path}/`))) throw new Error(`Archive path "${entry.path}" is both a file and a folder.`);
  }
}

function dosDateTime(date: number, time: number): Date | null {
  if (!date) return null;
  const value = new Date((date >> 9) + 1980, ((date >> 5) & 15) - 1, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2);
  return Number.isNaN(value.getTime()) ? null : value;
}

const crcTable = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  crcTable[index] = value >>> 0;
}

function crc(data: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of data) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function formatLimit(bytes: number): string {
  return `${bytes / 1024 / 1024} MiB`;
}
