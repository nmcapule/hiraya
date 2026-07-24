import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initApp } from "./init";

describe("hiraya-app init", () => {
  test("creates a workspace-compatible Vanilla TS app with author guidance", async () => {
    const root = await mkdtemp(join(tmpdir(), "hiraya-init-"));
    const destination = join(root, "Field Notes");
    const result = await initApp(destination, "com.example.field-notes");

    expect(result).toEqual({ destination, appId: "com.example.field-notes", packageName: "hiraya-app-field-notes" });
    const manifest = JSON.parse(await readFile(join(destination, "public", "hiraya.app.json"), "utf8"));
    const packageMetadata = JSON.parse(await readFile(join(destination, "package.json"), "utf8"));
    expect(manifest).toEqual(expect.objectContaining({ id: "com.example.field-notes", name: "Field Notes" }));
    expect(packageMetadata).toEqual(expect.objectContaining({
      name: "hiraya-app-field-notes",
      dependencies: { "@hiraya/apps-sdk": "workspace:*" },
      devDependencies: expect.objectContaining({ "@hiraya/app-cli": "workspace:*" }),
    }));
    expect(await readFile(join(destination, "src", "main.ts"), "utf8")).toContain('const APP_ID = "com.example.field-notes";');
    const guide = await readFile(join(destination, "AGENTS.md"), "utf8");
    for (const topic of ["connectHiraya", "Opaque handles", "Revision-safe writes", "Permissions", "Theme variables", "Security", "Tests"]) {
      expect(guide.toLowerCase()).toContain(topic.toLowerCase());
    }
  });

  test("never overwrites an existing destination", async () => {
    const root = await mkdtemp(join(tmpdir(), "hiraya-init-"));
    const destination = join(root, "existing");
    await Bun.write(destination, "keep me");
    await expect(initApp(destination, "com.example.existing")).rejects.toThrow("already exists");
    expect(await readFile(destination, "utf8")).toBe("keep me");
  });

  test("rejects invalid app IDs before creating the destination", async () => {
    const root = await mkdtemp(join(tmpdir(), "hiraya-init-"));
    const destination = join(root, "invalid");
    await expect(initApp(destination, "Invalid App ID")).rejects.toThrow("App ID is invalid");
    await writeFile(join(root, "sentinel"), "unchanged");
    expect(await readFile(join(root, "sentinel"), "utf8")).toBe("unchanged");
  });
});
