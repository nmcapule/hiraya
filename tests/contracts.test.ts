import { describe, expect, test } from "bun:test";
import { parseBlobMutationPreparation, parseContentAccessDescriptor, parseEntries, parseRemoteDesktopState, parseRootEntryPositionUpdates } from "../src/lib/contracts";
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

  test("strictly validates direct blob targets and integrity metadata", () => {
    const sha256 = "edb465624291e4053c6c5ea4b7eb320dec773e10a57d26b95dcf0564f8e310f8";
    const uploadAccess = { url: "https://uploads.example.test/object?signature=secret", method: "PUT", headers: { "X-Bz-Info": "value" }, expiresAt: 2_000_000_000_000 };
    const downloadAccess = { url: "https://downloads.example.test/object", method: "GET", headers: {}, expiresAt: 2_000_000_000_000 };
    const prepared = parseBlobMutationPreparation({ state: "prepared", uploadId: "upload-1", expiresAt: 2_000_000_000_000, items: [{ entryId: "file-1", access: uploadAccess }] }, ["file-1"]);
    expect(prepared.state === "prepared" && prepared.items[0].entryId).toBe("file-1");
    expect(parseBlobMutationPreparation({ state: "committed" }, ["file-1"])).toEqual({ state: "committed" });
    expect(parseContentAccessDescriptor({ entryId: "file-1", contentRevision: 4, size: 4, sha256, access: downloadAccess }, "file-1", 4, 4)).toMatchObject({ contentRevision: 4, size: 4, sha256 });
    expect(() => parseBlobMutationPreparation({ state: "prepared", uploadId: "upload-1", expiresAt: 1, items: [{ entryId: "other", access: uploadAccess }] }, ["file-1"])).toThrow("unexpected targets");
    expect(() => parseBlobMutationPreparation({ state: "prepared", uploadId: "upload-1", expiresAt: 1, items: [{ entryId: "file-1", access: { ...uploadAccess, url: "https://user:secret@uploads.example.test/object" } }] }, ["file-1"])).toThrow("safe HTTPS");
    expect(() => parseBlobMutationPreparation({ state: "prepared", uploadId: "upload-1", expiresAt: 1, items: [{ entryId: "file-1", access: { ...uploadAccess, headers: { Cookie: "secret" } } }] }, ["file-1"])).toThrow("unsafe header");
    expect(() => parseBlobMutationPreparation({ state: "prepared", uploadId: "upload-1", expiresAt: 1, items: [{ entryId: "file-1", access: { ...uploadAccess, headers: { "X-Test": "one", "x-test": "two" } } }] }, ["file-1"])).toThrow("unsafe header");
    expect(() => parseContentAccessDescriptor({ entryId: "file-1", contentRevision: 4, size: 4, sha256: sha256.toUpperCase(), access: downloadAccess }, "file-1", 4, 4)).toThrow("SHA-256");
    expect(() => parseContentAccessDescriptor({ entryId: "file-1", contentRevision: 4, size: 4, sha256, access: { ...downloadAccess, method: "PUT" } }, "file-1", 4, 4)).toThrow("must use GET");
  });
});
