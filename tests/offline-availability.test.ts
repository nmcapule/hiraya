import { describe, expect, test } from "bun:test";
import { buildOfflineAvailability, dedupeOfflineRoots, offlineFilesUnderRoots, outboxProtectedFileIds, type OfflineStorageInventory } from "../src/lib/offline-availability";
import type { OutboxRecord } from "../src/lib/outbox";
import type { DesktopEntry } from "../src/types";

const entries: DesktopEntry[] = [
  { kind: "folder", id: "root", name: "Root", parentId: null, createdAt: 1, modifiedAt: 1, position: { x: 0, y: 0 } },
  { kind: "file", id: "a", name: "a.txt", parentId: "root", mimeType: "text/plain", size: 10, createdAt: 1, modifiedAt: 1, position: { x: 0, y: 0 } },
  { kind: "folder", id: "nested", name: "Nested", parentId: "root", createdAt: 1, modifiedAt: 1, position: { x: 0, y: 0 } },
  { kind: "file", id: "b", name: "b.txt", parentId: "nested", mimeType: "text/plain", size: 20, createdAt: 1, modifiedAt: 1, position: { x: 0, y: 0 } },
];

function inventory(overrides: Partial<OfflineStorageInventory> = {}): OfflineStorageInventory {
  return { desktopId: "desktop", pinIds: [], files: {}, cachedBytes: 0, protectedBytes: 0, browserStorage: null, ...overrides };
}

describe("offline availability model", () => {
  test("deduplicates overlapping roots and expands folders recursively", () => {
    expect(dedupeOfflineRoots(entries, ["root", "a", "nested"])).toEqual(["root"]);
    expect(offlineFilesUnderRoots(entries, ["root", "nested"]).map((file) => file.id)).toEqual(["a", "b"]);
  });

  test("keeps folder pins dynamic and aggregates partial availability", () => {
    const model = buildOfflineAvailability(entries, inventory({
      pinIds: ["root"],
      files: { a: { cached: true, cachedBytes: 10, storedBytes: 10, pending: false, protected: false }, b: { cached: false, cachedBytes: 0, storedBytes: 0, pending: false, protected: false } },
      cachedBytes: 10,
    }));
    expect(model.pinnedFileIds).toEqual(["a", "b"]);
    expect(model.entries.root.status).toBe("pinned");
    expect(model.entries.root.downloadBytes).toBe(20);
    expect(model.entries.a.directlyPinned).toBe(false);
    expect(model.entries.nested.pinned).toBe(true);
  });

  test("reports partial unpinned folders and protects pending/local bytes", () => {
    const model = buildOfflineAvailability(entries, inventory({ files: {
      a: { cached: true, cachedBytes: 10, storedBytes: 10, pending: false, protected: false },
      b: { cached: true, cachedBytes: 20, storedBytes: 20, pending: true, protected: true },
    } }));
    expect(model.entries.nested.status).toBe("protected");
    expect(model.entries.root.status).toBe("protected");
    expect(model.entries.b.pending).toBe(true);
    expect(model.entries.b.downloadBytes).toBe(0);
  });

  test("includes newly reconciled descendants under an existing folder pin", () => {
    const next = [...entries, { kind: "file", id: "c", name: "c.txt", parentId: "nested", mimeType: "text/plain", size: 30, createdAt: 2, modifiedAt: 2, position: { x: 0, y: 0 } } satisfies DesktopEntry];
    expect(buildOfflineAvailability(next, inventory({ pinIds: ["root"] })).pinnedFileIds).toEqual(["a", "b", "c"]);
  });

  test("protects transferred files and folder descendants across desktops", () => {
    const transfer: OutboxRecord = { operationId: "transfer", sequence: 1, clientId: "client", catalogId: "catalog", desktopId: "source", operation: { schemaVersion: 1, kind: "entry-transfer", entryIds: ["root"], destinationDesktopId: "destination", parentId: null }, status: "pending", error: null };
    expect([...outboxProtectedFileIds([transfer], [{ entries }])].sort()).toEqual(["a", "b"]);
  });
});
