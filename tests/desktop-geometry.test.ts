import { describe, expect, test } from "bun:test";
import type { DesktopEntry } from "../src/types";
import { desktopSlots, nextAvailableDesktopSlot, projectLogicalAxis, projectLogicalPosition, reorderDesktopSegments, reorderSurfaceSegments, responsiveDesktop, restoreLogicalPosition } from "../src/ui/desktop-geometry";
import { adjacentArea, arrangeableAreaItems, desktopAreaItems, moveLogicalPositionToArea, persistAreaPositionUpdates } from "../src/ui/desktop-areas";

function file(id: string, x = 22, y = 22): DesktopEntry {
  return { kind: "file", id, name: `${id}.txt`, parentId: null, modifiedAt: 1, position: { x, y }, mimeType: "text/plain", size: 0 };
}

describe("responsive desktop geometry", () => {
  test("builds derived area view models with a reachable empty current area", () => {
    const areas = desktopAreaItems([
      { segment: { column: 0, row: 0 }, rootItemCount: 2, windowCount: 1 },
      { segment: { column: -1, row: 0 }, rootItemCount: 1, windowCount: 0 },
    ], { column: 1, row: 0 });
    expect(areas).toEqual([
      { segment: { column: -1, row: 0 }, rootItemCount: 1, windowCount: 0, current: false, occupied: true, key: "0:-1", label: "Left", coordinateLabel: "Column -1, row 0" },
      { segment: { column: 0, row: 0 }, rootItemCount: 2, windowCount: 1, current: false, occupied: true, key: "0:0", label: "Home", coordinateLabel: "Column 0, row 0" },
      { segment: { column: 1, row: 0 }, rootItemCount: 0, windowCount: 0, current: true, occupied: false, key: "0:1", label: "Current", coordinateLabel: "Column 1, row 0" },
    ]);
    expect(arrangeableAreaItems(areas).map((area) => area.key)).toEqual(["0:-1", "0:0"]);
  });

  test("derives adjacent coordinates and preserves local placement when moving", () => {
    expect(adjacentArea({ column: 2, row: -1 }, "left")).toEqual({ column: 1, row: -1 });
    expect(adjacentArea({ column: 2, row: -1 }, "down")).toEqual({ column: 2, row: 0 });
    expect(moveLogicalPositionToArea({ x: 412, y: 640 }, { column: -1, row: 2 }, { width: 390, height: 600 })).toEqual({ x: -368, y: 1240 });
  });

  test("reports whether area position persistence committed", async () => {
    const updates = [{ entryId: "one", position: { x: 412, y: 22 } }];
    let persisted = 0;
    expect(await persistAreaPositionUpdates(updates, async (values) => { persisted = values.length; })).toBe(true);
    expect(persisted).toBe(1);
    expect(await persistAreaPositionUpdates(updates, async () => { throw new Error("offline"); })).toBe(false);
  });

  test("reorders logical canvas segments without persisted area identity", () => {
    expect(reorderSurfaceSegments([
      { column: -1, row: 0 },
      { column: 0, row: 0 },
      { column: 2, row: 1 },
    ], "0:-1", 2)).toEqual([
      { source: { column: 0, row: 0 }, target: { column: -1, row: 0 } },
      { source: { column: 2, row: 1 }, target: { column: 0, row: 0 } },
      { source: { column: -1, row: 0 }, target: { column: 2, row: 1 } },
    ]);
  });
  test("derives placement capacity without using it for area membership", () => {
    expect(desktopSlots({ width: 500, height: 500 })).toHaveLength(16);
    expect(desktopSlots({ width: 220, height: 260 })).toHaveLength(2);
    const entries = [file("one"), file("two"), file("three")];
    expect(responsiveDesktop(entries, { width: 220, height: 260 }).segments).toHaveLength(1);
  });

  test("preserves collisions in the same coordinate tile", () => {
    const desktop = responsiveDesktop([file("one", 160, 30), file("two", 160, 30)], { width: 500, height: 500 });
    expect(desktop.segments).toHaveLength(1);
    expect(desktop.positions.get("one")).toEqual({ x: 160, y: 30 });
    expect(desktop.positions.get("two")).toEqual({ x: 160, y: 30 });
  });

  test("places new icons into free slots without moving existing positions", () => {
    const size = { width: 500, height: 500 };
    const slots = desktopSlots(size);
    expect(nextAvailableDesktopSlot(size, [slots[0], slots[2]])).toEqual(slots[1]);
    expect(nextAvailableDesktopSlot(size, slots)).toEqual(slots[0]);
  });

  test("uses themed icon metrics without changing coordinate-based membership", () => {
    const size = { width: 390, height: 600 };
    const entries = [file("origin", 22, 22), file("next", 412, 22)];
    const large = { width: 110, height: 114, stepX: 116, stepY: 124 };
    expect(desktopSlots(size, false, large).length).toBeLessThan(desktopSlots(size).length);
    expect(responsiveDesktop(entries, size, large).segments.map((segment) => segment.key)).toEqual(["0:0", "0:1"]);
    expect(entries.map((entry) => entry.position)).toEqual([{ x: 22, y: 22 }, { x: 412, y: 22 }]);
  });

  test("projects signed viewport boundaries reversibly", () => {
    expect(projectLogicalAxis(0, 390)).toEqual({ segment: 0, local: 0 });
    expect(projectLogicalAxis(389, 390)).toEqual({ segment: 0, local: 389 });
    expect(projectLogicalAxis(390, 390)).toEqual({ segment: 1, local: 0 });
    expect(projectLogicalAxis(-1, 390)).toEqual({ segment: -1, local: 389 });
    expect(projectLogicalAxis(-390, 390)).toEqual({ segment: -1, local: 0 });
    expect(projectLogicalAxis(-391, 390)).toEqual({ segment: -2, local: 389 });

    const values = [{ x: -781, y: 602 }, { x: -1, y: -1 }, { x: 900, y: -1201 }];
    for (const logical of values) {
      const projected = projectLogicalPosition(logical, { width: 390, height: 600 });
      expect(restoreLogicalPosition(projected.local, projected.segment, { width: 390, height: 600 })).toEqual(logical);
    }
  });

  test("retains sparse surface segments without dense reassignment", () => {
    const entries = [file("origin", 22, 22), file("left", -368, 22), file("far", 1192, 1222)];
    const desktop = responsiveDesktop(entries, { width: 390, height: 600 });
    expect(desktop.segments.map((segment) => segment.segment)).toEqual([
      { column: -1, row: 0 },
      { column: 0, row: 0 },
      { column: 3, row: 2 },
    ]);
    expect(desktop.minColumn).toBe(-1);
    expect(desktop.maxColumn).toBe(3);
    expect(desktop.rows).toBe(3);
  });

  test("membership depends only on viewport and coordinates", () => {
    const entries = [file("b", 400, 20), file("a", 20, 20), file("c", 400, 20)];
    const first = responsiveDesktop(entries, { width: 390, height: 600 });
    const reordered = responsiveDesktop([...entries].reverse(), { width: 390, height: 600 });
    expect(first.segments.map((segment) => [segment.key, segment.entries.map((entry) => entry.id)])).toEqual(
      reordered.segments.map((segment) => [segment.key, segment.entries.map((entry) => entry.id)]),
    );
    expect(first.segments.map((segment) => segment.entries.map((entry) => entry.id))).toEqual([["a"], ["b", "c"]]);
  });

  test("reprojects from unchanged coordinates when the viewport changes", () => {
    const entries = [file("near", 22, 22), file("far", 900, 22)];
    expect(responsiveDesktop(entries, { width: 390, height: 600 }).segments).toHaveLength(2);
    expect(responsiveDesktop(entries, { width: 1200, height: 700 }).segments).toHaveLength(1);
    expect(entries[1].position).toEqual({ x: 900, y: 22 });
  });

  test("uses one implicit origin extent for an empty desktop", () => {
    const desktop = responsiveDesktop([], { width: 390, height: 600 });
    expect(desktop.segments).toEqual([]);
    expect(desktop.columns).toBe(1);
    expect(desktop.rows).toBe(1);
  });

  test("reorders desktop segments by translating coordinates", () => {
    const size = { width: 390, height: 600 };
    const entries = [file("one", 22, 22), file("two", 412, 40), file("three", 802, 60)];
    const segments = responsiveDesktop(entries, size).segments;
    const updates = reorderDesktopSegments(segments, "0:0", 2, size);
    expect(updates).toEqual([
      { entryId: "two", position: { x: 22, y: 40 } },
      { entryId: "three", position: { x: 412, y: 60 } },
      { entryId: "one", position: { x: 802, y: 22 } },
    ]);
  });
});
