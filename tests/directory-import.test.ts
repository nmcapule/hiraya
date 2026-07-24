import { describe, expect, test } from "bun:test";
import type { DesktopEntry } from "../src/types";
import { assertImportOperationCurrent, buildImportPlan, sourcesFromDirectoryHandle, sourcesFromDirectoryPicker, sourcesFromDrop, supportsDirectoryPicker, type ImportSource } from "../src/lib/directory-import";

function file(name: string, contents = name, relativePath = "") {
  const value = new File([contents], name, { type: "text/plain", lastModified: 20 });
  Object.defineProperty(value, "webkitRelativePath", { value: relativePath });
  return value;
}

function plan(sources: ImportSource[], existingEntries: DesktopEntry[] = [], destinationParentId: string | null = null) {
  let id = 0;
  return buildImportPlan(sources, {
    destinationParentId,
    existingEntries,
    positionForRoot: (index) => ({ x: 100 + index, y: 200 + index }),
    createId: () => `id-${++id}`,
    now: 10,
  });
}

function paths(imported: ReturnType<typeof plan>) {
  const byId = new Map(imported.entries.map((entry) => [entry.id, entry]));
  return imported.entries.map((entry) => {
    const names = [entry.name];
    let parent = entry.parentId ? byId.get(entry.parentId) : undefined;
    while (parent) { names.unshift(parent.name); parent = parent.parentId ? byId.get(parent.parentId) : undefined; }
    return `${entry.kind}:${names.join("/")}`;
  });
}

describe("directory import plans", () => {
  test("preserves nested and empty folders with complete deterministic hierarchy", () => {
    const imported = plan([
      { relativePath: "Project/empty" },
      { relativePath: "Project/docs/readme.txt", file: file("readme.txt", "readme") },
      { relativePath: "Project/src/nested/code.ts", file: file("code.ts", "code") },
    ]);

    expect(paths(imported)).toEqual([
      "folder:Project",
      "folder:Project/docs",
      "folder:Project/empty",
      "folder:Project/src",
      "file:Project/docs/readme.txt",
      "folder:Project/src/nested",
      "file:Project/src/nested/code.ts",
    ]);
    expect(imported.rootIds).toEqual(["id-1"]);
    expect(imported.entries[0].position).toEqual({ x: 100, y: 200 });
    expect(imported.folderCount).toBe(5);
    expect(imported.fileCount).toBe(2);
    expect(imported.totalBytes).toBe(10);
    expect([...imported.contents.values()].map((content) => content.size)).toEqual([6, 4]);
  });

  test("allows duplicate basenames in different directories", () => {
    expect(paths(plan([
      { relativePath: "One/same.txt", file: file("same.txt", "1") },
      { relativePath: "Two/same.txt", file: file("same.txt", "2") },
    ]))).toEqual(["folder:One", "folder:Two", "file:One/same.txt", "file:Two/same.txt"]);
  });

  test("rejects traversal, invalid path characters, duplicate paths, and file-folder collisions", () => {
    expect(() => plan([{ relativePath: "../escape.txt", file: file("escape.txt") }])).toThrow("unsafe path");
    expect(() => plan([{ relativePath: "ok/bad\\name.txt", file: file("bad.txt") }])).toThrow("unsafe path");
    expect(() => plan([{ relativePath: "ok/bad\u0001name.txt", file: file("bad.txt") }])).toThrow("invalid path segment");
    expect(() => plan([{ relativePath: "ok/ padded.txt", file: file("padded.txt") }])).toThrow("invalid path segment");
    expect(() => plan([{ relativePath: "Tree/a.txt", file: file("a.txt") }, { relativePath: "tree/A.txt", file: file("A.txt") }])).toThrow("duplicate relative path");
    expect(() => plan([{ relativePath: "Tree", file: file("Tree") }, { relativePath: "Tree/a.txt", file: file("a.txt") }])).toThrow("conflicting items");
  });

  test("rejects the whole import on a destination sibling conflict", () => {
    const existing: DesktopEntry[] = [{ kind: "folder", id: "existing", name: "Project", parentId: null, createdAt: 1, modifiedAt: 1, position: { x: 0, y: 0 } }];
    expect(() => plan([{ relativePath: "project/a.txt", file: file("a.txt") }], existing)).toThrow("Cannot import “project”");
  });

  test("places selected roots into an existing folder", () => {
    const existing: DesktopEntry[] = [{ kind: "folder", id: "destination", name: "Destination", parentId: null, createdAt: 1, modifiedAt: 1, position: { x: 0, y: 0 } }];
    const imported = plan([{ relativePath: "Project/a.txt", file: file("a.txt") }], existing, "destination");
    expect(imported.destinationParentId).toBe("destination");
    expect(imported.entries[0]).toMatchObject({ name: "Project", parentId: "destination", position: { x: 100, y: 200 } });
    expect(imported.entries[1].parentId).toBe(imported.entries[0].id);
  });

  test("isolates picker detection and reads picker relative paths", () => {
    expect(supportsDirectoryPicker({ HTMLInputElement: { prototype: { webkitdirectory: false } } })).toBe(true);
    expect(supportsDirectoryPicker({ HTMLInputElement: { prototype: {} } })).toBe(false);
    const picked = file("note.txt", "note", "Project/note.txt");
    expect(sourcesFromDirectoryPicker([picked])).toEqual([{ relativePath: "Project/note.txt", file: picked }]);
  });

  test("rejects an unsupported directory drop instead of flattening it", async () => {
    const directoryItem = { kind: "file", getAsFile: () => null };
    await expect(sourcesFromDrop({ items: [directoryItem] as unknown as DataTransferItemList, files: [] as unknown as FileList })).rejects.toThrow("not supported");
  });

  test("rejects a whole mixed drop when one file item lacks an entry", async () => {
    const leaf = { name: "leaf.txt", isDirectory: false, isFile: true, file: (resolve: (value: File) => void) => resolve(file("leaf.txt")) } as unknown as FileSystemFileEntry;
    const exposed = { kind: "file", getAsFile: () => file("leaf.txt"), webkitGetAsEntry: () => leaf };
    const omitted = { kind: "file", getAsFile: () => file("other.txt"), webkitGetAsEntry: () => null };
    await expect(sourcesFromDrop({ items: [exposed, omitted] as unknown as DataTransferItemList, files: [file("leaf.txt"), file("other.txt")] as unknown as FileList })).rejects.toThrow("Nothing was imported");
  });

  test("cancels an import session after desktop activation changes", () => {
    const context = { operationId: "import-1", desktopId: "desk-a", parentId: null, activationGeneration: 4 };
    expect(() => assertImportOperationCurrent(context, { desktopId: "desk-b", activationGeneration: 5, entries: [] })).toThrow("active desktop changed");
  });

  test("preferred directory handles preserve nested empty folders", async () => {
    const empty = { kind: "directory", name: "empty", async *values() {} } as unknown as FileSystemDirectoryHandle;
    const nested = { kind: "directory", name: "nested", async *values() { yield empty; } } as unknown as FileSystemDirectoryHandle;
    const root = { kind: "directory", name: "Project", async *values() { yield nested; } } as unknown as FileSystemDirectoryHandle;
    expect((await sourcesFromDirectoryHandle(root)).map((source) => source.relativePath)).toEqual(["Project", "Project/nested", "Project/nested/empty"]);
  });

  test("drains directory readers and preserves empty folders from drop", async () => {
    let reads = 0;
    const empty = {
      name: "empty", isDirectory: true, isFile: false,
      createReader: () => ({ readEntries: (resolve: (entries: FileSystemEntry[]) => void) => { reads += 1; resolve([]); } }),
    } as unknown as FileSystemDirectoryEntry;
    const leafFile = file("leaf.txt", "leaf");
    const leaf = {
      name: "leaf.txt", isDirectory: false, isFile: true,
      file: (resolve: (value: File) => void) => resolve(leafFile),
    } as unknown as FileSystemFileEntry;
    let rootRead = 0;
    const root = {
      name: "Project", isDirectory: true, isFile: false,
      createReader: () => ({
        readEntries: (resolve: (entries: FileSystemEntry[]) => void) => {
          reads += 1;
          resolve(rootRead++ === 0 ? [empty] : rootRead === 2 ? [leaf] : []);
        },
      }),
    } as unknown as FileSystemDirectoryEntry;
    const item = { kind: "file", getAsFile: () => null, webkitGetAsEntry: () => root };

    const sources = await sourcesFromDrop({ items: [item] as unknown as DataTransferItemList, files: [] as unknown as FileList });
    expect(sources.map((source) => source.relativePath)).toEqual(["Project", "Project/empty", "Project/leaf.txt"]);
    expect(paths(plan(sources))).toEqual(["folder:Project", "folder:Project/empty", "file:Project/leaf.txt"]);
    expect(reads).toBe(4);
  });
});
