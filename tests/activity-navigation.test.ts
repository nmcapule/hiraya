import { describe, expect, test } from "bun:test";
import { activityEntryIds, canOpenActivity } from "../src/ui/activity-navigation";
import type { ActivityRecord } from "../src/lib/activity";

const activity: ActivityRecord = { catalogRevision: 1, timestamp: 1, action: "move", source: "api", summary: "Moved files", details: [] };

describe("activity navigation", () => {
  test("returns unique valid affected entry IDs from extended activity data", () => {
    expect(activityEntryIds({ ...activity, entryId: "first", entryIds: ["second", "first", ""] } as ActivityRecord)).toEqual(["first", "second"]);
    expect(activityEntryIds(activity)).toEqual([]);
  });

  test("only offers Open for current entries or an available target desktop", () => {
    const entries = [{ kind: "folder" as const, id: "first", name: "First", parentId: null, createdAt: 1, modifiedAt: 1, position: { x: 0, y: 0 } }];
    expect(canOpenActivity({ ...activity, desktopId: "current", entryIds: ["first"] }, "current", entries, ["current"])).toBe(true);
    expect(canOpenActivity({ ...activity, desktopId: "current", entryIds: ["missing"] }, "current", entries, ["current"])).toBe(false);
    expect(canOpenActivity({ ...activity, desktopId: "other", entryIds: ["entry"] }, "current", entries, ["current", "other"])).toBe(true);
    expect(canOpenActivity({ ...activity, desktopId: "deleted", entryIds: ["entry"] }, "current", entries, ["current"])).toBe(false);
  });
});
