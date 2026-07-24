import { lstat, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { parseManifestV1 } from "@hiraya/apps-contracts";
import { zipSync, type Zippable } from "fflate";
import {
  APP_ARCHIVE_EXTENSION,
  APP_ARCHIVE_LIMITS,
  APP_MANIFEST_PATH,
  inspectAppArchive,
  normalizeArchivePath,
  validateAppFiles,
} from "./archive";

const DETERMINISTIC_TIMESTAMP = new Date("1980-01-01T00:00:00.000Z");

export async function readAppDirectory(input: string) {
  const root = resolve(input);
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new TypeError("App input must be a real directory.");
  const canonicalRoot = await realpath(root);
  const files = new Map<string, Uint8Array>();
  let totalBytes = 0;
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) throw new TypeError(`App directory must not contain symbolic links: ${relative(root, absolute)}.`);
      const canonical = await realpath(absolute);
      if (canonical !== canonicalRoot && !canonical.startsWith(`${canonicalRoot}${sep}`)) throw new TypeError("App file resolves outside the app directory.");
      if (stat.isDirectory()) await walk(absolute);
      else if (stat.isFile()) {
        const path = normalizeArchivePath(relative(root, absolute).split(sep).join("/"));
        if (stat.size > APP_ARCHIVE_LIMITS.entryBytes) throw new TypeError(`Package file exceeds the size limit: ${path}.`);
        if (files.size >= APP_ARCHIVE_LIMITS.entries) throw new TypeError("Package contains too many files.");
        totalBytes += stat.size;
        if (totalBytes > APP_ARCHIVE_LIMITS.expandedBytes) throw new TypeError("Package exceeds the expanded size limit.");
        files.set(path, new Uint8Array(await readFile(absolute)));
      } else throw new TypeError(`App directory contains a non-regular file: ${relative(root, absolute)}.`);
    }
  };
  await walk(root);
  return validateAppFiles(files);
}

export function createAppArchive(files: ReadonlyMap<string, Uint8Array>) {
  const archive: Zippable = {};
  for (const [path, bytes] of [...files].sort(([left], [right]) => left.localeCompare(right, "en"))) {
    archive[path] = [bytes, { level: 6, mtime: DETERMINISTIC_TIMESTAMP }];
  }
  const zipped = zipSync(archive, { level: 6, mtime: DETERMINISTIC_TIMESTAMP });
  if (zipped.byteLength > APP_ARCHIVE_LIMITS.archiveBytes) throw new TypeError("Archive exceeds the compressed size limit.");
  return zipped;
}

export async function packageApp(input: string, output?: string) {
  const validated = await readAppDirectory(input);
  const manifest = parseManifestV1(JSON.parse(new TextDecoder().decode(validated.files.get(APP_MANIFEST_PATH)!)));
  const destination = resolve(output ?? `${basename(resolve(input))}${APP_ARCHIVE_EXTENSION}`);
  if (!destination.endsWith(APP_ARCHIVE_EXTENSION)) throw new TypeError(`Package output must end with ${APP_ARCHIVE_EXTENSION}.`);
  const archive = createAppArchive(validated.files);
  const inspection = await inspectAppArchive(archive);
  await writeFile(destination, archive);
  return { destination, manifest, inspection };
}

export async function inspectAppInput(input: string) {
  const path = resolve(input);
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) throw new TypeError("App input must not be a symbolic link.");
  if (stat.isDirectory()) {
    const validated = await readAppDirectory(path);
    return inspectAppArchive(createAppArchive(validated.files));
  }
  if (!stat.isFile() || !path.endsWith(APP_ARCHIVE_EXTENSION)) throw new TypeError(`App archive must end with ${APP_ARCHIVE_EXTENSION}.`);
  return inspectAppArchive(new Uint8Array(await readFile(path)));
}

export function relativeOutput(path: string) {
  return relative(resolve("."), path) || basename(path) || dirname(path);
}
