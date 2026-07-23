import { describe, expect, test } from "bun:test";
import { parsePortableSeededManifest, toPortableSeededManifest } from "../src/lib/seeded-manifest";
import { desktopStateSnapshot } from "./fixtures";

describe("seeded packages", () => {
  test("accepts only schema version 1 with complete entries", () => {
    const snapshot = desktopStateSnapshot();
    snapshot.entries = [{ kind: "file", id: "file", name: "read me.txt", parentId: null, createdAt: 1, modifiedAt: 1, position: { x: 0, y: 0 }, mimeType: "text/plain", size: 3 }];
    const value = toPortableSeededManifest(snapshot, () => "content/read%20me.txt");
    expect(value.schemaVersion).toBe(1);
    expect(parsePortableSeededManifest(value)).toEqual(value);
    expect(() => parsePortableSeededManifest({ ...value, schemaVersion: 7 })).toThrow("unsupported format");
    const incomplete = value.entries.map((entry) => { const copy = { ...entry } as Partial<typeof entry>; delete copy.createdAt; return copy; });
    expect(() => parsePortableSeededManifest({ ...value, entries: incomplete })).toThrow("creation date");
  });

  test("preserves current layout, appearance, empty folders, and normalized content URLs", () => {
    const snapshot = desktopStateSnapshot();
    snapshot.layout = { snapToGrid: true, wallpaper: "ember" };
    snapshot.entries = [
      { kind: "folder", id: "empty", name: "Empty", parentId: null, createdAt: 1, modifiedAt: 1, position: { x: -40, y: 20 } },
      { kind: "file", id: "file", name: "notes.txt", parentId: null, createdAt: 2, modifiedAt: 2, position: { x: 60, y: 20 }, mimeType: "text/plain", size: 0 },
    ];
    const value = toPortableSeededManifest(snapshot, () => "content/notes.txt");
    expect(parsePortableSeededManifest(value)).toMatchObject({ schemaVersion: 1, layout: snapshot.layout, appearance: snapshot.appearance, entries: snapshot.entries });
    expect(() => parsePortableSeededManifest({ ...value, entries: value.entries.map((entry) => entry.kind === "file" ? { ...entry, contentUrl: "../notes.txt" } : entry) })).toThrow("normalized relative");
  });
});
