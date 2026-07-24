import { describe, expect, test } from "bun:test";
import { storageWorkerName } from "../src/lib/storage-worker";

describe("storage worker identity", () => {
  test("isolates storage routers by frontend build and account namespace", () => {
    const first = storageWorkerName(false, "account-a", "2026-07-24T03:00:00Z");
    expect(first).toBe("hiraya-storage-2026-07-24T03-00-00Z-account-a");
    expect(storageWorkerName(false, "account-a", "2026-07-24T04:00:00Z")).not.toBe(first);
    expect(storageWorkerName(false, "account-b", "2026-07-24T03:00:00Z")).not.toBe(first);
    expect(storageWorkerName(true, "ignored", "2026-07-24T03:00:00Z")).toBe("hiraya-storage-2026-07-24T03-00-00Z");
  });
});
