import { parseManifestV1, type HirayaAppManifestV1 } from "@hiraya/apps-contracts";
import { parse } from "parse5";
import { unzipSync } from "fflate";

export const APP_ARCHIVE_EXTENSION = ".hiraya.app";
export const APP_MANIFEST_PATH = "hiraya.app.json";
export const APP_ARCHIVE_LIMITS = {
  archiveBytes: 32 * 1024 * 1024,
  entries: 512,
  entryBytes: 16 * 1024 * 1024,
  expandedBytes: 64 * 1024 * 1024,
  manifestBytes: 128 * 1024,
  compressionRatio: 200,
} as const;

export interface AppPackageInspection {
  manifest: HirayaAppManifestV1;
  digest: string;
  entryCount: number;
  compressedBytes: number;
  expandedBytes: number;
  files: ReadonlyMap<string, Uint8Array>;
}

interface ZipEntry {
  path: string;
  compressedSize: number;
  expandedSize: number;
  localOffset: number;
}

interface HtmlNode {
  nodeName?: string;
  tagName?: string;
  value?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: HtmlNode[];
}

const decoder = new TextDecoder("utf-8", { fatal: true });

function uint16(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function uint32(bytes: Uint8Array, offset: number) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

export function normalizeArchivePath(input: string) {
  const path = input.normalize("NFC");
  if (
    path.length === 0 || path.length > 1024 || path.includes("\\") || path.includes("\0") ||
    path.startsWith("/") || /^[A-Za-z]:\//.test(path) ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) throw new TypeError(`Archive contains unsafe path: ${JSON.stringify(input)}.`);
  return path;
}

function decodeZipName(bytes: Uint8Array, utf8: boolean) {
  if (!utf8 && bytes.some((byte) => byte > 0x7f)) throw new TypeError("Archive contains a non-UTF-8 path.");
  try {
    return decoder.decode(bytes);
  } catch {
    throw new TypeError("Archive contains an invalid UTF-8 path.");
  }
}

function readZipDirectory(bytes: Uint8Array) {
  if (bytes.byteLength > APP_ARCHIVE_LIMITS.archiveBytes) throw new TypeError("Archive exceeds the compressed size limit.");
  let end = -1;
  const minimum = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (uint32(bytes, offset) === 0x06054b50) {
      end = offset;
      break;
    }
  }
  if (end < 0 || end + 22 + uint16(bytes, end + 20) !== bytes.length) throw new TypeError("Archive has an invalid ZIP directory.");
  const disk = uint16(bytes, end + 4);
  const centralDisk = uint16(bytes, end + 6);
  const diskEntries = uint16(bytes, end + 8);
  const entryCount = uint16(bytes, end + 10);
  const centralSize = uint32(bytes, end + 12);
  const centralOffset = uint32(bytes, end + 16);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== entryCount || entryCount === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff) {
    throw new TypeError("Multi-disk and ZIP64 archives are not supported.");
  }
  if (entryCount > APP_ARCHIVE_LIMITS.entries) throw new TypeError("Archive contains too many entries.");
  if (centralOffset + centralSize !== end) throw new TypeError("Archive has an invalid ZIP directory layout.");

  const entries: ZipEntry[] = [];
  const paths = new Set<string>();
  let expandedBytes = 0;
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > end || uint32(bytes, offset) !== 0x02014b50) throw new TypeError("Archive has an invalid ZIP entry.");
    const madeBy = uint16(bytes, offset + 4);
    const flags = uint16(bytes, offset + 8);
    const compression = uint16(bytes, offset + 10);
    const compressedSize = uint32(bytes, offset + 20);
    const expandedSize = uint32(bytes, offset + 24);
    const nameLength = uint16(bytes, offset + 28);
    const extraLength = uint16(bytes, offset + 30);
    const commentLength = uint16(bytes, offset + 32);
    const externalAttributes = uint32(bytes, offset + 38);
    const localOffset = uint32(bytes, offset + 42);
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength;
    if (nextOffset > end || nameLength === 0) throw new TypeError("Archive has a truncated ZIP entry.");
    if ((flags & 1) !== 0) throw new TypeError("Encrypted ZIP entries are not supported.");
    if (compression !== 0 && compression !== 8) throw new TypeError("Archive uses an unsupported compression method.");
    if ((madeBy >>> 8) === 3 && ((externalAttributes >>> 16) & 0xf000) === 0xa000) throw new TypeError("Archive must not contain symbolic links.");
    const rawPath = decodeZipName(bytes.subarray(offset + 46, offset + 46 + nameLength), (flags & 0x800) !== 0);
    if (rawPath.endsWith("/")) throw new TypeError("Archive must contain files only, not directory entries.");
    const path = normalizeArchivePath(rawPath);
    if (paths.has(path)) throw new TypeError(`Archive contains duplicate normalized path: ${path}.`);
    paths.add(path);
    if (expandedSize > APP_ARCHIVE_LIMITS.entryBytes) throw new TypeError(`Archive entry exceeds the size limit: ${path}.`);
    if (expandedSize > Math.max(1024, compressedSize * APP_ARCHIVE_LIMITS.compressionRatio)) throw new TypeError(`Archive entry has an unsafe compression ratio: ${path}.`);
    expandedBytes += expandedSize;
    if (expandedBytes > APP_ARCHIVE_LIMITS.expandedBytes) throw new TypeError("Archive exceeds the expanded size limit.");
    entries.push({ path, compressedSize, expandedSize, localOffset });
    offset = nextOffset;
  }
  if (offset !== end) throw new TypeError("Archive ZIP directory contains trailing data.");

  for (const entry of entries) {
    const offset = entry.localOffset;
    if (offset + 30 > centralOffset || uint32(bytes, offset) !== 0x04034b50) throw new TypeError("Archive has an invalid local ZIP entry.");
    const flags = uint16(bytes, offset + 6);
    const nameLength = uint16(bytes, offset + 26);
    const extraLength = uint16(bytes, offset + 28);
    const dataEnd = offset + 30 + nameLength + extraLength + entry.compressedSize;
    if (dataEnd > centralOffset) throw new TypeError("Archive has a truncated local ZIP entry.");
    const localPath = normalizeArchivePath(decodeZipName(bytes.subarray(offset + 30, offset + 30 + nameLength), (flags & 0x800) !== 0));
    if (localPath !== entry.path) throw new TypeError("Archive local and central paths do not match.");
  }
  return { entries, expandedBytes };
}

function decodeText(bytes: Uint8Array, label: string) {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new TypeError(`${label} must be valid UTF-8.`);
  }
}

function localReference(reference: string, fromPath: string, label: string) {
  const trimmed = reference.trim();
  if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("data:")) return null;
  let url: URL;
  try {
    url = new URL(trimmed, `https://package.invalid/${fromPath}`);
  } catch {
    throw new TypeError(`${label} contains an invalid reference.`);
  }
  if (url.origin !== "https://package.invalid" || url.protocol !== "https:") throw new TypeError(`${label} contains a remote reference: ${reference}.`);
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw new TypeError(`${label} contains an invalid encoded path.`);
  }
  return normalizeArchivePath(pathname);
}

function attribute(node: HtmlNode, name: string) {
  return node.attrs?.find((item) => item.name.toLowerCase() === name)?.value;
}

function assertReference(reference: string, fromPath: string, label: string, files: ReadonlyMap<string, Uint8Array>) {
  const path = localReference(reference, fromPath, label);
  if (path !== null && !files.has(path)) throw new TypeError(`${label} references missing package file: ${path}.`);
  return path;
}

function validateCss(css: string, path: string, files: ReadonlyMap<string, Uint8Array>) {
  const references = css.matchAll(/@import\s+(?:url\(\s*)?(?:["']([^"']+)["']|([^"')\s;]+))|url\(\s*(?:["']([^"']+)["']|([^"')\s]+))/gi);
  for (const match of references) {
    const reference = match[1] ?? match[2] ?? match[3] ?? match[4];
    assertReference(reference, path, `Stylesheet ${path}`, files);
  }
}

function validateModule(source: string, path: string, files: ReadonlyMap<string, Uint8Array>) {
  const references = source.matchAll(/(?:\b(?:import|export)\s+(?:[^"'();]*?\sfrom\s*)?|\bimport\s*\(\s*)["']([^"']+)["']/g);
  for (const match of references) assertReference(match[1], path, `Module ${path}`, files);
}

function validateHtmlSource(html: string, entrypoint: string, files: ReadonlyMap<string, Uint8Array>, depth = 0) {
  if (depth > 8) throw new TypeError("Frame source documents are too deeply nested.");
  const document = parse(html) as unknown as HtmlNode;
  const visit = (node: HtmlNode) => {
    const tag = node.tagName?.toLowerCase();
    if (tag === "base" && attribute(node, "href") !== undefined) throw new TypeError("App HTML must not override its package base URL.");
    if (tag === "script") {
      const type = (attribute(node, "type") ?? "").toLowerCase();
      const src = attribute(node, "src");
      if (src !== undefined) {
        const scriptPath = assertReference(src, entrypoint, "Script", files);
        if (type === "module" && scriptPath !== null) validateModule(decodeText(files.get(scriptPath)!, `Module ${scriptPath}`), scriptPath, files);
      } else if (type === "module") {
        const source = node.childNodes?.map((child) => child.value ?? "").join("") ?? "";
        validateModule(source, entrypoint, files);
      } else if (type === "importmap") {
        const source = node.childNodes?.map((child) => child.value ?? "").join("") ?? "";
        let importMap: unknown;
        try { importMap = JSON.parse(source); } catch { throw new TypeError("Import map must be valid JSON."); }
        const scan = (value: unknown) => {
          if (typeof value === "string") assertReference(value, entrypoint, "Import map", files);
          else if (value && typeof value === "object") Object.values(value).forEach(scan);
        };
        scan(importMap);
      }
    }
    if (tag === "link") {
      const rel = (attribute(node, "rel") ?? "").toLowerCase().split(/\s+/);
      const href = attribute(node, "href");
      const as = (attribute(node, "as") ?? "").toLowerCase();
      if (href !== undefined && (rel.some((item) => item === "stylesheet" || item === "modulepreload") || (rel.includes("preload") && (as === "script" || as === "style")))) {
        const assetPath = assertReference(href, entrypoint, "Linked style or module", files);
        if (assetPath !== null && (rel.includes("stylesheet") || as === "style")) validateCss(decodeText(files.get(assetPath)!, `Stylesheet ${assetPath}`), assetPath, files);
        if (assetPath !== null && rel.includes("modulepreload")) validateModule(decodeText(files.get(assetPath)!, `Module ${assetPath}`), assetPath, files);
      }
    }
    if (tag === "style") validateCss(node.childNodes?.map((child) => child.value ?? "").join("") ?? "", entrypoint, files);
    const inlineStyle = attribute(node, "style");
    if (inlineStyle !== undefined) validateCss(inlineStyle, entrypoint, files);
    if (tag === "iframe" || tag === "frame") {
      const src = attribute(node, "src");
      if (src !== undefined) assertReference(src, entrypoint, "Frame", files);
      const srcdoc = attribute(node, "srcdoc");
      if (srcdoc !== undefined) validateHtmlSource(srcdoc, entrypoint, files, depth + 1);
    }
    node.childNodes?.forEach(visit);
  };
  visit(document);
}

function validateHtml(entrypoint: string, files: ReadonlyMap<string, Uint8Array>) {
  validateHtmlSource(decodeText(files.get(entrypoint)!, "App entrypoint"), entrypoint, files);
}

export function validateAppFiles(files: ReadonlyMap<string, Uint8Array>) {
  const normalized = new Map<string, Uint8Array>();
  let expandedBytes = 0;
  for (const [rawPath, bytes] of files) {
    const path = normalizeArchivePath(rawPath);
    if (normalized.has(path)) throw new TypeError(`Package contains duplicate normalized path: ${path}.`);
    if (bytes.byteLength > APP_ARCHIVE_LIMITS.entryBytes) throw new TypeError(`Package file exceeds the size limit: ${path}.`);
    expandedBytes += bytes.byteLength;
    if (normalized.size >= APP_ARCHIVE_LIMITS.entries) throw new TypeError("Package contains too many files.");
    if (expandedBytes > APP_ARCHIVE_LIMITS.expandedBytes) throw new TypeError("Package exceeds the expanded size limit.");
    normalized.set(path, bytes);
  }
  const manifestBytes = normalized.get(APP_MANIFEST_PATH);
  if (!manifestBytes) throw new TypeError(`Package must contain ${APP_MANIFEST_PATH} at its root.`);
  if (manifestBytes.byteLength > APP_ARCHIVE_LIMITS.manifestBytes) throw new TypeError("App manifest exceeds the size limit.");
  let manifestValue: unknown;
  try { manifestValue = JSON.parse(decodeText(manifestBytes, "App manifest")); } catch (error) {
    if (error instanceof TypeError && error.message.endsWith("valid UTF-8.")) throw error;
    throw new TypeError("App manifest must be valid JSON.");
  }
  const manifest = parseManifestV1(manifestValue);
  if (!/\.html?$/i.test(manifest.entrypoint)) throw new TypeError("App entrypoint must be an HTML file.");
  if (!normalized.has(manifest.entrypoint)) throw new TypeError(`App entrypoint is missing: ${manifest.entrypoint}.`);
  if (manifest.icon !== undefined && !normalized.has(manifest.icon)) throw new TypeError(`App icon is missing: ${manifest.icon}.`);
  validateHtml(manifest.entrypoint, normalized);
  return { manifest, files: normalized, expandedBytes };
}

export async function sha256(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function inspectAppArchive(bytes: Uint8Array): Promise<AppPackageInspection> {
  const directory = readZipDirectory(bytes);
  let unzipped: Record<string, Uint8Array>;
  try { unzipped = unzipSync(bytes); } catch { throw new TypeError("Archive could not be decompressed."); }
  const files = new Map<string, Uint8Array>();
  for (const entry of directory.entries) {
    const data = unzipped[entry.path];
    if (!data || data.byteLength !== entry.expandedSize) throw new TypeError(`Archive entry size is invalid: ${entry.path}.`);
    files.set(entry.path, data);
  }
  if (Object.keys(unzipped).length !== directory.entries.length) throw new TypeError("Archive entries do not match its ZIP directory.");
  const validated = validateAppFiles(files);
  return {
    manifest: validated.manifest,
    digest: await sha256(bytes),
    entryCount: files.size,
    compressedBytes: bytes.byteLength,
    expandedBytes: directory.expandedBytes,
    files: validated.files,
  };
}
