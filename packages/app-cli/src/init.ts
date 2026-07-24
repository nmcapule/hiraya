import { lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseManifestV1 } from "@hiraya/apps-contracts";

const TEMPLATE_DIRECTORY = fileURLToPath(new URL("../templates/vanilla-ts", import.meta.url));

export interface InitAppResult {
  destination: string;
  appId: string;
  packageName: string;
}

export async function initApp(directory: string, requestedAppId?: string): Promise<InitAppResult> {
  const destination = resolve(directory);
  const directoryName = basename(destination);
  const slug = packageSlug(directoryName);
  const appId = requestedAppId ?? `dev.hiraya.${slug.replaceAll("-", ".")}`;
  validateAppId(appId);
  const packageName = `hiraya-app-${slug.slice(0, 203).replace(/-+$/, "")}`;

  await mkdir(dirname(destination), { recursive: true });
  try {
    await mkdir(destination);
  } catch (error) {
    if (isAlreadyExists(error)) throw new TypeError(`Destination already exists: ${destination}.`);
    throw error;
  }

  try {
    await copyTemplate(TEMPLATE_DIRECTORY, destination);
    const manifestPath = join(destination, "public", "hiraya.app.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.id = appId;
    manifest.name = displayName(directoryName);
    await writeFile(manifestPath, `${JSON.stringify(parseManifestV1(manifest), null, 2)}\n`);

    const sourcePath = join(destination, "src", "main.ts");
    const source = await readFile(sourcePath, "utf8");
    await writeFile(sourcePath, source.replace('const APP_ID = "dev.hiraya.starter";', `const APP_ID = ${JSON.stringify(appId)};`));

    const packagePath = join(destination, "package.json");
    const packageMetadata = JSON.parse(await readFile(packagePath, "utf8")) as Record<string, unknown>;
    packageMetadata.name = packageName;
    await writeFile(packagePath, `${JSON.stringify(packageMetadata, null, 2)}\n`);
    return { destination, appId, packageName };
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

function validateAppId(appId: string): void {
  parseManifestV1({
    schemaVersion: 1,
    id: appId,
    name: "App",
    version: "0.1.0",
    entrypoint: "index.html",
    permissions: [],
  });
}

function packageSlug(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) throw new TypeError("App directory name must contain a letter or number.");
  return /^[a-z]/.test(slug) ? slug : `app-${slug}`;
}

function displayName(value: string): string {
  const name = value.replace(/[-_]+/g, " ").trim().replace(/\b\w/g, (character) => character.toUpperCase());
  return name || "Hiraya App";
}

async function copyTemplate(source: string, destination: string): Promise<void> {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    const stat = await lstat(sourcePath);
    if (stat.isSymbolicLink()) throw new TypeError(`Starter template must not contain symbolic links: ${entry.name}.`);
    if (stat.isDirectory()) {
      await mkdir(destinationPath);
      await copyTemplate(sourcePath, destinationPath);
    } else if (stat.isFile()) {
      await writeFile(destinationPath, await readFile(sourcePath), { flag: "wx" });
    } else throw new TypeError(`Starter template contains a non-regular file: ${entry.name}.`);
  }
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
