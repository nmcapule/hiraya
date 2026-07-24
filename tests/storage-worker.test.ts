import { describe, expect, test } from "bun:test";
import { storageOwnerLockName, storageWorkerName } from "../src/lib/storage-worker";

describe("storage worker identity", () => {
  test("versions routers and owner locks together while isolating accounts", () => {
    expect(storageWorkerName(false, "account-a")).toBe("hiraya-storage-v3-account-a");
    expect(storageWorkerName(false, "account-b")).not.toBe(storageWorkerName(false, "account-a"));
    expect(storageWorkerName(true, "ignored")).toBe("hiraya-storage-v3");
    expect(storageOwnerLockName(false, "account-a")).toBe("hiraya-sqlite-v1-owner-account-a");
    expect(storageOwnerLockName(false, "account-b")).not.toBe(storageOwnerLockName(false, "account-a"));
    expect(storageOwnerLockName(true, "ignored")).toBe("hiraya-sqlite-v1-owner");
  });
});
