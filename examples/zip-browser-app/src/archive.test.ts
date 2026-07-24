import { describe, expect, test } from "bun:test";
import { strToU8, zipSync } from "fflate";
import { inspectArchive } from "./archive";

function archive(files: Record<string, Uint8Array>) {
  const bytes = zipSync(files);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe("ZIP inspection", () => {
  test("accepts a small safe archive", () => {
    const result = inspectArchive(archive({ "folder/readme.txt": strToU8("hello") }));
    expect(result.entries.some((entry) => entry.path === "folder/readme.txt")).toBe(true);
  });

  test("rejects traversal paths", () => {
    expect(() => inspectArchive(archive({ "../escape.txt": strToU8("no") }))).toThrow("unsafe path");
  });

  test("rejects extreme compression ratios", () => {
    expect(() => inspectArchive(archive({ "zeros.bin": new Uint8Array(2 * 1024 * 1024) }))).toThrow("compression ratio");
  });

  test("rejects inconsistent local metadata", () => {
    const buffer = archive({ "readme.txt": strToU8("hello") });
    const view = new DataView(buffer);
    view.setUint32(18, view.getUint32(18, true) + 1, true);
    expect(() => inspectArchive(buffer)).toThrow("local metadata");
  });
});
