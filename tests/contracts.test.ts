import { describe, expect, test } from "bun:test";
import { parseEntries, parseRemoteDesktopState, parseRootEntryPositionUpdates } from "../src/lib/contracts";
import { remoteDesktopState } from "./fixtures";

describe("contracts", () => {
  test("requires createdAt", () => {
    const entry = { kind: "folder", id: "a", name: "A", parentId: null, createdAt: 1, modifiedAt: 1, position: { x: 0, y: 0 } };
    expect(parseEntries([entry])).toEqual([entry]);
    const missing = { ...entry } as Partial<typeof entry>;
    delete missing.createdAt;
    expect(() => parseEntries([missing])).toThrow("creation date");
  });

  test("parses strict remote desktop schema version 1", () => {
    const remote = remoteDesktopState();
    expect(parseRemoteDesktopState(remote)).toEqual(remote);
    expect(() => parseRemoteDesktopState({ ...remote, schemaVersion: 5 })).toThrow("schema version");
    expect(() => parseRemoteDesktopState({ ...remote, catalogId: undefined })).toThrow("catalog identity");
  });

  test("accepts positions only for root entries", () => {
    const entries = parseEntries([{ kind: "folder", id: "a", name: "A", parentId: null, createdAt: 1, modifiedAt: 1, position: { x: 0, y: 0 } }]);
    expect(parseRootEntryPositionUpdates([{ entryId: "a", position: { x: -2, y: 3 } }], entries)).toHaveLength(1);
  });
});
