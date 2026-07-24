import { describe, expect, test } from "bun:test";
import { installedAppAcceptsFile, installedAppIsAvailable, packageMatchesInstall, parseInstalledApp, removeInstalledApp, replaceInstalledApp, type InstalledApp } from "../src/apps/installed-apps";

function install(version = "1.0.0", digest = "a".repeat(64), packageEntryId = "package-one"): InstalledApp {
  return { appId: "test.editor", packageEntryId, digest, version, approvedAt: 10, manifest: { schemaVersion: 1, id: "test.editor", name: "Editor", version, entrypoint: "index.html", permissions: ["files:read"] } };
}

describe("installed apps", () => {
  test("strictly validates approval identity", () => {
    expect(parseInstalledApp(install())).toEqual(install());
    expect(() => parseInstalledApp({ ...install(), appId: "test.other" })).toThrow("identity");
    expect(() => parseInstalledApp({ ...install(), extra: true })).toThrow("unsupported shape");
  });

  test("matches the complete approved package identity and replaces updates", () => {
    const first = install();
    expect(packageMatchesInstall(first, first.packageEntryId, first.digest, first.version)).toBe(true);
    expect(packageMatchesInstall(first, first.packageEntryId, "b".repeat(64), first.version)).toBe(false);
    const updated = install("2.0.0", "b".repeat(64), "package-two");
    expect(replaceInstalledApp([first], updated)).toEqual([updated]);
    expect(removeInstalledApp([updated], updated.appId)).toEqual([]);
  });

  test("reports deleted and wrong-kind package entries as unavailable", () => {
    const app = install();
    expect(installedAppIsAvailable(app, [])).toBe(false);
    expect(installedAppIsAvailable(app, [{ id: app.packageEntryId, kind: "folder" }])).toBe(false);
    expect(installedAppIsAvailable(app, [{ id: app.packageEntryId, kind: "file" }])).toBe(true);
  });

  test("matches declared MIME, wildcard, and extension associations", () => {
    const app = install();
    const associated = { ...app, manifest: { ...app.manifest, fileTypes: ["text/plain", "image/*", ".md"] } };
    expect(installedAppAcceptsFile(associated, { name: "notes.txt", mimeType: "text/plain; charset=utf-8" })).toBe(true);
    expect(installedAppAcceptsFile(associated, { name: "photo.bin", mimeType: "image/png" })).toBe(true);
    expect(installedAppAcceptsFile(associated, { name: "README.MD", mimeType: "application/octet-stream" })).toBe(true);
    expect(installedAppAcceptsFile(associated, { name: "archive.zip", mimeType: "application/zip" })).toBe(false);
  });
});
