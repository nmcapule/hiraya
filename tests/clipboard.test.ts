import { describe, expect, test } from "bun:test";
import { strToU8, unzipSync, zipSync } from "fflate";
import {
  CLIPBOARD_ARCHIVE_MIME_TYPE,
  CLIPBOARD_ARCHIVE_WEB_MIME_TYPE,
  decodeClipboardArchive,
  encodeClipboardArchive,
  isClipboardArchiveType,
  type ClipboardEntrySnapshot,
} from "../src/lib/clipboard";

function snapshot(): ClipboardEntrySnapshot {
  return {
    selectedRootIds: ["folder", "empty"],
    entries: [
      { kind: "folder", id: "folder", name: "Folder", parentId: null, modifiedAt: 1, position: { x: -10, y: 20 } },
      { kind: "file", id: "note", name: "note.txt", parentId: "folder", modifiedAt: 2, position: { x: 0, y: 0 }, mimeType: "text/plain", size: 5 },
      { kind: "folder", id: "nested", name: "Nested", parentId: "folder", modifiedAt: 3, position: { x: 0, y: 0 } },
      { kind: "file", id: "binary", name: "data.bin", parentId: "nested", modifiedAt: 4, position: { x: 0, y: 0 }, mimeType: "application/octet-stream", size: 4 },
      { kind: "folder", id: "empty", name: "Empty", parentId: null, modifiedAt: 5, position: { x: 40, y: 50 } },
    ],
    contents: new Map([
      ["note", new Blob([new Uint8Array([0, 255, 10, 13, 65])], { type: "text/plain" })],
      ["binary", new Blob([new Uint8Array([1, 2, 0, 255])], { type: "application/octet-stream" })],
    ]),
  };
}

async function archiveFiles(blob: Blob) {
  return unzipSync(new Uint8Array(await blob.arrayBuffer()));
}

function archiveBlob(files: Record<string, Uint8Array>) {
  const bytes = zipSync(files);
  return new Blob([bytes.slice().buffer as ArrayBuffer], { type: CLIPBOARD_ARCHIVE_MIME_TYPE });
}

describe("clipboard archive codec", () => {
  test("round-trips recursive metadata, empty folders, and exact bytes", async () => {
    const input = snapshot();
    const archive = await encodeClipboardArchive(input);
    const output = await decodeClipboardArchive(archive);

    expect(archive.type).toBe(CLIPBOARD_ARCHIVE_MIME_TYPE);
    expect(output.selectedRootIds).toEqual(input.selectedRootIds);
    expect(output.entries).toEqual(input.entries);
    expect([...output.contents.keys()]).toEqual(["note", "binary"]);
    expect(new Uint8Array(await output.contents.get("note")!.arrayBuffer())).toEqual(new Uint8Array([0, 255, 10, 13, 65]));
    expect(new Uint8Array(await output.contents.get("binary")!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 0, 255]));
  });

  test("exposes custom web clipboard MIME helpers", () => {
    expect(CLIPBOARD_ARCHIVE_WEB_MIME_TYPE).toBe(`web ${CLIPBOARD_ARCHIVE_MIME_TYPE}`);
    expect(isClipboardArchiveType(CLIPBOARD_ARCHIVE_WEB_MIME_TYPE)).toBe(true);
    expect(isClipboardArchiveType(CLIPBOARD_ARCHIVE_MIME_TYPE)).toBe(true);
    expect(isClipboardArchiveType("text/plain")).toBe(false);
  });

  test("rejects invalid trees and incomplete content while encoding", async () => {
    const missingParent = snapshot();
    missingParent.entries[1] = { ...missingParent.entries[1], parentId: "absent" };
    await expect(encodeClipboardArchive(missingParent)).rejects.toThrow("parent");

    const missingContent = snapshot();
    missingContent.contents.delete("note");
    await expect(encodeClipboardArchive(missingContent)).rejects.toThrow("missing or extra");

    const wrongSize = snapshot();
    wrongSize.contents.set("note", new Blob(["no"]));
    await expect(encodeClipboardArchive(wrongSize)).rejects.toThrow("size");
  });

  test("rejects traversal, extra members, and missing file content", async () => {
    const files = await archiveFiles(await encodeClipboardArchive(snapshot()));
    await expect(decodeClipboardArchive(archiveBlob({ ...files, "../escape": strToU8("bad") }))).rejects.toThrow("unsafe path");
    await expect(decodeClipboardArchive(archiveBlob({ ...files, "extra.txt": strToU8("bad") }))).rejects.toThrow("missing or extra");
    const { "files/note": _removed, ...missing } = files;
    void _removed;
    await expect(decodeClipboardArchive(archiveBlob(missing))).rejects.toThrow("missing or extra");
  });

  test("rejects invalid manifest IDs, names, kinds, sizes, hierarchy, and fields", async () => {
    const original = await archiveFiles(await encodeClipboardArchive(snapshot()));
    const manifest = JSON.parse(new TextDecoder().decode(original["manifest.json"]));
    const cases = [
      { ...manifest, entries: manifest.entries.map((entry: Record<string, unknown>, index: number) => index === 0 ? { ...entry, id: "../bad" } : entry) },
      { ...manifest, entries: manifest.entries.map((entry: Record<string, unknown>, index: number) => index === 0 ? { ...entry, name: "bad/name" } : entry) },
      { ...manifest, entries: manifest.entries.map((entry: Record<string, unknown>, index: number) => index === 0 ? { ...entry, kind: "link" } : entry) },
      { ...manifest, entries: manifest.entries.map((entry: Record<string, unknown>, index: number) => index === 1 ? { ...entry, size: -1 } : entry) },
      { ...manifest, selectedRootIds: ["folder"] },
      { ...manifest, surprise: true },
    ];
    for (const invalid of cases) {
      await expect(decodeClipboardArchive(archiveBlob({ ...original, "manifest.json": strToU8(JSON.stringify(invalid)) }))).rejects.toThrow();
    }
  });
});
