import { parseManifestV1, type HirayaAppManifestV1 } from "@hiraya/apps-contracts";

export type InstalledApp = Readonly<{
  appId: string;
  packageEntryId: string;
  digest: string;
  version: string;
  manifest: HirayaAppManifestV1;
  approvedAt: number;
}>;

const DIGEST = /^[a-f0-9]{64}$/;

export function parseInstalledApp(value: unknown): InstalledApp {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Installed app must be an object.");
  const item = value as Record<string, unknown>;
  const manifest = parseManifestV1(item.manifest);
  if (Object.keys(item).some((key) => !["appId", "packageEntryId", "digest", "version", "manifest", "approvedAt"].includes(key))) throw new TypeError("Installed app has an unsupported shape.");
  if (item.appId !== manifest.id || item.version !== manifest.version) throw new TypeError("Installed app identity does not match its manifest.");
  if (typeof item.packageEntryId !== "string" || item.packageEntryId.length === 0 || item.packageEntryId.length > 256) throw new TypeError("Installed app package entry ID is invalid.");
  if (typeof item.digest !== "string" || !DIGEST.test(item.digest)) throw new TypeError("Installed app digest is invalid.");
  if (typeof item.approvedAt !== "number" || !Number.isSafeInteger(item.approvedAt) || item.approvedAt < 0) throw new TypeError("Installed app approval time is invalid.");
  return { appId: manifest.id, packageEntryId: item.packageEntryId, digest: item.digest, version: manifest.version, manifest, approvedAt: item.approvedAt };
}

export function packageMatchesInstall(install: InstalledApp | undefined, packageEntryId: string, digest: string, version: string): boolean {
  return Boolean(install && install.packageEntryId === packageEntryId && install.digest === digest && install.version === version);
}

export function replaceInstalledApp(current: readonly InstalledApp[], value: unknown): InstalledApp[] {
  const install = parseInstalledApp(value);
  return [...current.filter((item) => item.appId !== install.appId), install];
}

export function removeInstalledApp(current: readonly InstalledApp[], appId: string): InstalledApp[] {
  return current.filter((item) => item.appId !== appId);
}

export function installedAppIsAvailable(install: InstalledApp, entries: readonly { id: string; kind: "file" | "folder" }[]): boolean {
  return entries.some((entry) => entry.id === install.packageEntryId && entry.kind === "file");
}

export function installedAppAcceptsFile(install: InstalledApp, file: { name: string; mimeType: string }): boolean {
  const name = file.name.toLowerCase();
  const mimeType = file.mimeType.split(";", 1)[0].trim().toLowerCase();
  return install.manifest.fileTypes?.some((value) => {
    const type = value.trim().toLowerCase();
    if (type.startsWith(".")) return name.endsWith(type);
    if (type.endsWith("/*")) return mimeType.startsWith(type.slice(0, -1));
    return type === mimeType;
  }) ?? false;
}
