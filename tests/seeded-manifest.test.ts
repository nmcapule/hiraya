import { describe, expect, test } from "bun:test";
import { parsePortableSeededManifest, toPortableSeededManifest } from "../src/lib/seeded-manifest";
import { desktopSnapshot } from "./fixtures";

describe("seeded manifests", () => {
  test("round-trips a portable manifest", () => {
    const snapshot = desktopSnapshot();
    snapshot.entries = [{ kind: "file", id: "file-1", name: "read me.txt", parentId: null, viewId: "view-1", modifiedAt: 1, position: { x: 0, y: 0 }, mimeType: "text/plain", size: 3 }];
    const portable = toPortableSeededManifest(snapshot, () => "content/read me.txt");
    expect(parsePortableSeededManifest(JSON.parse(JSON.stringify(portable)))).toEqual(portable);
  });

  test("rejects non-portable content URLs", () => {
    const snapshot = desktopSnapshot();
    snapshot.entries = [{ kind: "file", id: "file-1", name: "one.txt", parentId: null, viewId: "view-1", modifiedAt: 1, position: { x: 0, y: 0 }, mimeType: "text/plain", size: 0 }];
    expect(() => toPortableSeededManifest(snapshot, () => "../one.txt")).toThrow("normalized relative");
    expect(() => toPortableSeededManifest(snapshot, () => "https://example.com/one.txt")).toThrow("relative contentUrl");
  });

  test("accepts encoded paths for legal names containing URL delimiters", () => {
    const snapshot = desktopSnapshot();
    snapshot.entries = [{ kind: "file", id: "file-1", name: "notes?#.txt", parentId: null, viewId: "view-1", modifiedAt: 1, position: { x: 0, y: 0 }, mimeType: "text/plain", size: 0 }];
    const portable = toPortableSeededManifest(snapshot, (entry) => `content/${encodeURIComponent(entry.name)}`);
    expect(portable.entries[0].kind === "file" && portable.entries[0].contentUrl).toBe("content/notes%3F%23.txt");
  });
});
