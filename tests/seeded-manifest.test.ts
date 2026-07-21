import { describe, expect, test } from "bun:test";
import { parsePortableSeededManifest, toPortableSeededManifest } from "../src/lib/seeded-manifest";
import { desktopSnapshot } from "./fixtures";

describe("seeded manifests", () => {
  test("round-trips a portable manifest", () => {
    const snapshot = desktopSnapshot();
    snapshot.entries = [{ kind: "file", id: "file-1", name: "read me.txt", parentId: null, modifiedAt: 1, position: { x: 0, y: 0 }, mimeType: "text/plain", size: 3 }];
    snapshot.layout.rootOrder = ["file-1"];
    const portable = toPortableSeededManifest(snapshot, () => "content/read me.txt");
    expect(parsePortableSeededManifest(JSON.parse(JSON.stringify(portable)))).toEqual(portable);
  });

  test("rejects non-portable content URLs", () => {
    const snapshot = desktopSnapshot();
    snapshot.entries = [{ kind: "file", id: "file-1", name: "one.txt", parentId: null, modifiedAt: 1, position: { x: 0, y: 0 }, mimeType: "text/plain", size: 0 }];
    snapshot.layout.rootOrder = ["file-1"];
    expect(() => toPortableSeededManifest(snapshot, () => "../one.txt")).toThrow("normalized relative");
    expect(() => toPortableSeededManifest(snapshot, () => "https://example.com/one.txt")).toThrow("relative contentUrl");
  });

  test("accepts encoded paths for legal names containing URL delimiters", () => {
    const snapshot = desktopSnapshot();
    snapshot.entries = [{ kind: "file", id: "file-1", name: "notes?#.txt", parentId: null, modifiedAt: 1, position: { x: 0, y: 0 }, mimeType: "text/plain", size: 0 }];
    snapshot.layout.rootOrder = ["file-1"];
    const portable = toPortableSeededManifest(snapshot, (entry) => `content/${encodeURIComponent(entry.name)}`);
    expect(portable.entries[0].kind === "file" && portable.entries[0].contentUrl).toBe("content/notes%3F%23.txt");
  });

  test("migrates version 3 view ordering", () => {
    const parsed = parsePortableSeededManifest({
      version: 3,
      layout: { views: [{ id: "second" }, { id: "first" }], columns: 2, snapToGrid: false, wallpaper: "dusk" },
      editorSettings: { autoSave: true, fontSize: 13, language: "auto" },
      entries: [
        { kind: "folder", id: "a", name: "A", parentId: null, viewId: "first", modifiedAt: 1, position: { x: 1, y: 1 } },
        { kind: "folder", id: "b", name: "B", parentId: null, viewId: "second", modifiedAt: 1, position: { x: 1, y: 1 } },
      ],
    });
    expect(parsed.version).toBe(4);
    expect(parsed.layout.rootOrder).toEqual(["b", "a"]);
    expect(parsed.entries.some((entry) => "viewId" in entry)).toBe(false);
  });
});
