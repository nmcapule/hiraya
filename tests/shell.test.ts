import { describe, expect, test } from "bun:test";
import { areaDirectionalLabel, nextOccupiedArea, occupiedAreaCount, taskbarCapacity, taskbarWindows } from "../src/ui/shell";

describe("cohesive shell view models", () => {
  test("prioritizes the focused window, then windows in the current region, with explicit overflow", () => {
    const windows = [
      { id: "other-a", areaId: "1:0" },
      { id: "current-a", areaId: "0:0" },
      { id: "focused", areaId: "1:0", focused: true },
      { id: "current-b", areaId: "0:0" },
    ];
    const model = taskbarWindows(windows, "0:0", 3);
    expect(model.visible.map((window) => window.id)).toEqual(["focused", "current-a", "current-b"]);
    expect(model.overflow.map((window) => window.id)).toEqual(["other-a"]);
  });

  test("adapts taskbar capacity while reserving the overflow model", () => {
    expect(taskbarCapacity(621, true)).toBe(2);
    expect(taskbarCapacity(768, true)).toBe(5);
    expect(taskbarCapacity(1024, false)).toBe(5);
    expect(taskbarCapacity(1920, false)).toBe(7);
  });

  test("uses directional identity before raw coordinates", () => {
    expect(areaDirectionalLabel({ column: 0, row: 0 }, { column: 0, row: 0 })).toBe("Home");
    expect(areaDirectionalLabel({ column: -1, row: 0 }, { column: 0, row: 0 })).toBe("Left");
    expect(areaDirectionalLabel({ column: 2, row: -1 }, { column: 0, row: 0 })).toBe("Above right");
  });

  test("swipes to the nearest occupied region and never creates an empty one", () => {
    const areas = [{ column: 0, row: 0 }, { column: 3, row: 0 }, { column: 0, row: -2 }];
    expect(nextOccupiedArea(areas, areas[0], "x", 1)).toEqual(areas[1]);
    expect(nextOccupiedArea(areas, areas[0], "y", -1)).toEqual(areas[2]);
    expect(nextOccupiedArea(areas, areas[0], "x", -1)).toEqual(areas[0]);
  });

  test("counts only occupied regions, excluding an empty current region", () => {
    expect(occupiedAreaCount([{ occupied: true }, { occupied: false }, { occupied: true }])).toBe(2);
  });
});
