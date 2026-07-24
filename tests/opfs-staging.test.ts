import { describe, expect, test } from "bun:test";
import { stageOperationContentsInDirectory } from "../src/lib/opfs";

describe("pending content staging", () => {
  test("removes the whole operation directory after a partial write failure", async () => {
    const removed: Array<{ name: string; recursive?: boolean }> = [];
    const operationDirectory = {} as FileSystemDirectoryHandle;
    const pending = {
      getDirectoryHandle: async () => operationDirectory,
      removeEntry: async (name: string, options?: FileSystemRemoveOptions) => { removed.push({ name, recursive: options?.recursive }); },
    } as unknown as FileSystemDirectoryHandle;
    let writes = 0;
    const contents = new Map([["first", new Blob(["a"])], ["second", new Blob(["b"])]]);

    await expect(stageOperationContentsInDirectory(pending, "operation-1", contents, async () => {
      writes += 1;
      if (writes === 2) throw new Error("disk full");
    })).rejects.toThrow("disk full");
    expect(writes).toBe(2);
    expect(removed).toEqual([{ name: "operation-1", recursive: true }]);
  });
});
