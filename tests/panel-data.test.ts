import { describe, expect, test } from "bun:test";
import type { OutboxRecord } from "../src/lib/outbox";
import { filterAndGroupSearchItems, filterAndGroupShortcuts, groupWindowsByArea, outboxRecordLabel, partitionSyncRecords } from "../src/ui/panel-data";

describe("panel data helpers", () => {
  test("filters search items across metadata and preserves category order", () => {
    const groups = filterAndGroupSearchItems([
      { id: "command", category: "commands", label: "Create folder", keywords: ["new directory"] },
      { id: "file", category: "files", label: "Roadmap.md", detail: "text/markdown" },
      { id: "folder", category: "folders", label: "Planning" },
    ], "plan");
    expect(groups.map((group) => [group.category, group.items.map((item) => item.id)])).toEqual([
      ["folders", ["folder"]],
    ]);
    expect(filterAndGroupSearchItems([
      { id: "command", category: "commands", label: "Create folder", keywords: ["new directory"] },
      { id: "file", category: "files", label: "Roadmap.md" },
    ], "new directory").map((group) => group.category)).toEqual(["commands"]);
  });

  test("filters shortcuts by group, action, and keys", () => {
    const shortcuts = [
      { id: "save", group: "Files", label: "Save file", keys: ["Ctrl", "S"] },
      { id: "search", group: "Navigation", label: "Open search", keys: ["Ctrl", "K"] },
    ];
    expect(filterAndGroupShortcuts(shortcuts, "files ctrl")).toEqual([{ label: "Files", shortcuts: [shortcuts[0]] }]);
    expect(filterAndGroupShortcuts(shortcuts, "missing")).toEqual([]);
  });

  test("groups windows by area in encounter order", () => {
    const windows = [
      { id: "a", title: "Notes", areaId: "one", areaLabel: "Area 1" },
      { id: "b", title: "Image", areaId: "two", areaLabel: "Area 2" },
      { id: "c", title: "Tasks", areaId: "one", areaLabel: "Area 1" },
    ];
    expect(groupWindowsByArea(windows)).toEqual([
      { id: "one", label: "Area 1", windows: [windows[0], windows[2]] },
      { id: "two", label: "Area 2", windows: [windows[1]] },
    ]);
  });

  test("partitions and labels queued sync records", () => {
    const pending = { operationId: "pending", status: "pending", operation: { schemaVersion: 1, kind: "delete", entryId: "entry" } } as OutboxRecord;
    const blocked = { operationId: "blocked", status: "blocked", operation: { schemaVersion: 1, kind: "save-content" } } as OutboxRecord;
    expect(partitionSyncRecords([pending, blocked])).toEqual({ blocked: [blocked], pending: [pending] });
    expect(outboxRecordLabel(pending)).toBe("Delete item");
    expect(outboxRecordLabel(blocked)).toBe("Save file");
  });
});
