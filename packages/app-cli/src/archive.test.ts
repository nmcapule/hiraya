import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { APP_MANIFEST_PATH, inspectAppArchive } from "./archive";
import { createAppArchive, packageApp, readAppDirectory } from "./filesystem";

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: "dev.hiraya.test",
    name: "Test App",
    version: "1.0.0",
    entrypoint: "index.html",
    icon: "icon.svg",
    permissions: [],
    ...overrides,
  };
}

function appFiles(overrides: Record<string, Uint8Array> = {}) {
  return {
    [APP_MANIFEST_PATH]: strToU8(JSON.stringify(manifest())),
    "index.html": strToU8('<!doctype html><link rel="stylesheet" href="assets/app.css"><script type="module" src="assets/app.js"></script><iframe src="frame.html"></iframe>'),
    "assets/app.css": strToU8("body { color: #fff }"),
    "assets/app.js": strToU8('import "./dependency.js";'),
    "assets/dependency.js": strToU8("document.body.dataset.ready = 'true';"),
    "frame.html": strToU8("<!doctype html><title>Frame</title>"),
    "icon.svg": strToU8('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    ...overrides,
  };
}

function archive(files = appFiles()) {
  return zipSync(files, { level: 6, mtime: new Date("1980-01-01T00:00:00Z") });
}

function signatures(bytes: Uint8Array, signature: number) {
  const found: number[] = [];
  for (let offset = 0; offset <= bytes.length - 4; offset += 1) {
    const value = (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
    if (value === signature) found.push(offset);
  }
  return found;
}

function setUint16(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = value & 255;
  bytes[offset + 1] = value >>> 8;
}

function setUint32(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = value & 255;
  bytes[offset + 1] = value >>> 8;
  bytes[offset + 2] = value >>> 16;
  bytes[offset + 3] = value >>> 24;
}

describe("Hiraya app archives", () => {
  test("validates a complete archive and computes a stable SHA-256 digest", async () => {
    const bytes = archive();
    const first = await inspectAppArchive(bytes);
    const second = await inspectAppArchive(bytes);
    expect(first.manifest).toEqual(manifest());
    expect(first.entryCount).toBe(7);
    expect(first.expandedBytes).toBeGreaterThan(0);
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(second.digest).toBe(first.digest);
  });

  test("creates byte-for-byte deterministic sorted archives", () => {
    const files = new Map(Object.entries(appFiles()).reverse());
    expect(createAppArchive(files)).toEqual(createAppArchive(files));
    const names = signatures(createAppArchive(files), 0x02014b50).map((offset) => {
      const length = createAppArchive(files)[offset + 28] | (createAppArchive(files)[offset + 29] << 8);
      return new TextDecoder().decode(createAppArchive(files).subarray(offset + 46, offset + 46 + length));
    });
    expect(names).toEqual([...names].sort((left, right) => left.localeCompare(right, "en")));
  });

  test("rejects traversal, absolute, backslash, and duplicate normalized paths", async () => {
    for (const path of ["../escape", "/absolute", "C:/absolute", "folder\\file"]) {
      await expect(inspectAppArchive(archive({ ...appFiles(), [path]: strToU8("bad") }))).rejects.toThrow("unsafe path");
    }
    await expect(inspectAppArchive(archive({ ...appFiles(), "caf\u00e9.txt": strToU8("one"), "cafe\u0301.txt": strToU8("two") }))).rejects.toThrow("duplicate normalized path");
  });

  test("rejects missing or malformed manifests, entrypoints, and icons", async () => {
    const { [APP_MANIFEST_PATH]: _manifest, ...withoutManifest } = appFiles();
    void _manifest;
    await expect(inspectAppArchive(archive(withoutManifest))).rejects.toThrow(APP_MANIFEST_PATH);
    await expect(inspectAppArchive(archive({ ...appFiles(), [APP_MANIFEST_PATH]: strToU8("{") }))).rejects.toThrow("valid JSON");
    await expect(inspectAppArchive(archive({ ...appFiles(), [APP_MANIFEST_PATH]: strToU8(JSON.stringify(manifest({ entrypoint: "missing.html" }))) }))).rejects.toThrow("entrypoint is missing");
    await expect(inspectAppArchive(archive({ ...appFiles(), [APP_MANIFEST_PATH]: strToU8(JSON.stringify(manifest({ icon: "missing.svg" }))) }))).rejects.toThrow("icon is missing");
    await expect(inspectAppArchive(archive({ ...appFiles(), [APP_MANIFEST_PATH]: strToU8(JSON.stringify(manifest({ extra: true }))) }))).rejects.toThrow("unsupported shape");
  });

  test("rejects remote scripts, styles, modules, import maps, and frames", async () => {
    const htmlCases = [
      '<script src="https://evil.example/app.js"></script>',
      '<link rel="stylesheet" href="//evil.example/app.css">',
      '<script type="module">import "https://evil.example/app.js"</script>',
      '<script type="importmap">{"imports":{"bad":"https://evil.example/app.js"}}</script>',
      '<iframe src="https://evil.example/"></iframe>',
      '<iframe srcdoc="&lt;script src=&quot;https://evil.example/app.js&quot;&gt;&lt;/script&gt;"></iframe>',
      '<style>@import url("https://evil.example/app.css");</style>',
      '<div style="background: url(https://evil.example/image.png)"></div>',
      '<link rel="preload" as="script" href="https://evil.example/app.js">',
    ];
    for (const html of htmlCases) {
      await expect(inspectAppArchive(archive({ ...appFiles(), "index.html": strToU8(html) }))).rejects.toThrow("remote reference");
    }
    await expect(inspectAppArchive(archive({ ...appFiles(), "assets/app.js": strToU8('export { x } from "https://evil.example/x.js"') }))).rejects.toThrow("remote reference");
    await expect(inspectAppArchive(archive({ ...appFiles(), "assets/app.css": strToU8("body { background: url(https://evil.example/x) }") }))).rejects.toThrow("remote reference");
    await expect(inspectAppArchive(archive({ ...appFiles(), "index.html": strToU8('<base href="https://evil.example/"><script src="assets/app.js"></script>') }))).rejects.toThrow("base URL");
  });

  test("rejects missing local HTML dependencies", async () => {
    await expect(inspectAppArchive(archive({ ...appFiles(), "index.html": strToU8('<script type="module" src="missing.js"></script>') }))).rejects.toThrow("missing package file");
    await expect(inspectAppArchive(archive({ ...appFiles(), "assets/app.js": strToU8('import "./missing.js"') }))).rejects.toThrow("missing package file");
  });

  test("rejects oversized metadata, excessive compression ratios, entry counts, and symlinks", async () => {
    const oversized = archive();
    const central = signatures(oversized, 0x02014b50)[0];
    setUint32(oversized, central + 24, 16 * 1024 * 1024 + 1);
    await expect(inspectAppArchive(oversized)).rejects.toThrow("size limit");

    await expect(inspectAppArchive(archive({ ...appFiles(), "bomb.txt": new Uint8Array(4096) }))).rejects.toThrow("compression ratio");

    const many: Record<string, Uint8Array> = appFiles();
    for (let index = 0; index < 506; index += 1) many[`files/${index}.txt`] = strToU8("x");
    await expect(inspectAppArchive(archive(many))).rejects.toThrow("too many entries");

    const linked = archive();
    const linkedCentral = signatures(linked, 0x02014b50)[0];
    setUint16(linked, linkedCentral + 4, 3 << 8);
    setUint32(linked, linkedCentral + 38, 0xa000 << 16);
    await expect(inspectAppArchive(linked)).rejects.toThrow("symbolic links");
  });

  test("rejects mismatched local paths", async () => {
    const bytes = archive();
    const local = signatures(bytes, 0x04034b50)[0];
    bytes[local + 30] ^= 1;
    await expect(inspectAppArchive(bytes)).rejects.toThrow("paths do not match");
  });
});

describe("app package filesystem", () => {
  test("packages a directory and rejects filesystem symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "hiraya-app-"));
    await mkdir(join(root, "assets"));
    for (const [path, bytes] of Object.entries(appFiles())) {
      const target = join(root, path);
      if (path.includes("/")) await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, bytes);
    }
    const output = join(root, "..", "test.hiraya.app");
    const packaged = await packageApp(root, output);
    expect(packaged.inspection.manifest.id).toBe("dev.hiraya.test");
    expect((await readFile(output)).byteLength).toBe(packaged.inspection.compressedBytes);

    await symlink(join(root, "index.html"), join(root, "linked.html"));
    await expect(readAppDirectory(root)).rejects.toThrow("symbolic links");
  });
});
