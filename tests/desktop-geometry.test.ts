import { describe, expect, test } from "bun:test";
import type { DesktopEntry, DesktopLayout } from "../src/types";
import { createEdgeWorkspaceLayout, desktopSlots, destinationSurfaceSegment, moveEntryToWorkspaceLayout, nextAvailableDesktopSlot, projectLogicalAxis, projectLogicalPosition, responsiveDesktop, restoreLogicalPosition } from "../src/ui/desktop-geometry";

function file(id: string, x = 22, y = 22): DesktopEntry {
  return { kind: "file", id, name: `${id}.txt`, parentId: null, modifiedAt: 1, position: { x, y }, mimeType: "text/plain", size: 0 };
}

describe("responsive desktop geometry", () => {
  test("derives capacity from both viewport dimensions", () => {
    expect(desktopSlots({ width: 500, height: 500 })).toHaveLength(16);
    expect(desktopSlots({ width: 220, height: 260 })).toHaveLength(2);
  });

  test("creates another page only after available slots are exhausted", () => {
    const entries = [file("one"), file("two"), file("three")];
    const two = responsiveDesktop(entries.slice(0, 2), ["one", "two"], { width: 220, height: 260 });
    const three = responsiveDesktop(entries, ["one", "two", "three"], { width: 220, height: 260 });
    expect(two.pages).toHaveLength(1);
    expect(three.pages.length).toBeGreaterThan(1);
    expect(three.pages.every((page) => page.entries.length > 0)).toBeTrue();
  });

  test("preserves fitting positions and collisions", () => {
    const entries = [file("one", 160, 30), file("two", 160, 30)];
    const desktop = responsiveDesktop(entries, ["one", "two"], { width: 500, height: 500 });
    expect(desktop.positions.get("one")).toEqual({ x: 160, y: 30 });
    expect(desktop.positions.get("two")).toEqual({ x: 160, y: 30 });
  });

  test("places new icons into free slots without moving existing positions", () => {
    const size = { width: 500, height: 500 };
    const slots = desktopSlots(size);
    expect(nextAvailableDesktopSlot(size, [slots[0], slots[2]])).toEqual(slots[1]);
    expect(nextAvailableDesktopSlot(size, slots)).toEqual(slots[0]);
  });

  test("projects exact boundaries into reversible logical segments", () => {
    expect(projectLogicalAxis(0, 390, 98)).toEqual({ segment: 0, local: 0 });
    expect(projectLogicalAxis(292, 390, 98)).toEqual({ segment: 0, local: 292 });
    expect(projectLogicalAxis(293, 390, 98)).toEqual({ segment: 1, local: 1 });
    expect(projectLogicalAxis(584, 390, 98)).toEqual({ segment: 1, local: 292 });
    expect(projectLogicalAxis(585, 390, 98)).toEqual({ segment: 2, local: 1 });
    expect(projectLogicalAxis(25, 80, 98)).toEqual({ segment: 0, local: 0 });

    const logical = { x: 585, y: 520 };
    const projected = projectLogicalPosition(logical, { width: 390, height: 600 });
    expect(projected).toEqual({ segment: { column: 2, row: 1 }, local: { x: 1, y: 22 } });
    expect(restoreLogicalPosition(projected.local, projected.segment, { width: 390, height: 600 })).toEqual(logical);
  });

  test("extends the continuous surface when adjacent views share a logical segment", () => {
    const origin = { column: 0, row: 0 };
    expect(destinationSurfaceSegment(origin, origin, origin, "right")).toEqual({ column: 1, row: 0 });
    expect(destinationSurfaceSegment({ column: 1, row: 0 }, origin, origin, "right")).toEqual({ column: 2, row: 0 });
    expect(destinationSurfaceSegment(origin, origin, origin, "left")).toEqual({ column: 1, row: 0 });
    expect(destinationSurfaceSegment(origin, origin, { column: 4, row: 1 }, "right")).toEqual({ column: 4, row: 1 });
  });

  test("moves overflowing coordinates to occupied workspaces without rearranging them", () => {
    const entries = [file("near", 22, 22), file("right", 314, 22), file("down", 22, 520), file("far", 900, 22)];
    const small = responsiveDesktop(entries, entries.map((entry) => entry.id), { width: 390, height: 600 });
    expect(small.pages.map((page) => page.entries.map((entry) => entry.id))).toEqual([["near"], ["right"], ["far"], ["down"]]);
    expect(small.pages.map((page) => page.segment)).toEqual([
      { column: 0, row: 0 },
      { column: 1, row: 0 },
      { column: 3, row: 0 },
      { column: 0, row: 1 },
    ]);
    expect(small.positions.get("right")).toEqual({ x: 22, y: 22 });
    expect(small.positions.get("far")).toEqual({ x: 24, y: 22 });
    expect(small.positions.get("down")).toEqual({ x: 22, y: 22 });

    const large = responsiveDesktop(entries, entries.map((entry) => entry.id), { width: 1200, height: 700 });
    expect(large.pages).toHaveLength(1);
    expect(large.positions.get("far")).toEqual({ x: 900, y: 22 });
  });

  test("repaginates the same order for a smaller device", () => {
    const entries = Array.from({ length: 20 }, (_, index) => file(`file-${index}`, 22 + index * 104, 22));
    const order = entries.map((entry) => entry.id);
    expect(responsiveDesktop(entries, order, { width: 2500, height: 700 }).pages).toHaveLength(1);
    expect(responsiveDesktop(entries, order, { width: 390, height: 600 }).pages.length).toBeGreaterThan(1);
  });

  test("uses one implicit page without creating an empty workspace", () => {
    const desktop = responsiveDesktop([], [], { width: 390, height: 600 });
    expect(desktop.pages).toEqual([]);
    expect(desktop.columns).toBe(1);
    expect(desktop.rows).toBe(1);
  });

  test("keeps adaptive breaks at their creation capacity and merges them on roomier devices", () => {
    const entries = [file("one"), file("two")];
    const breaks = [{ entryId: "two", maxCapacity: 16 }];
    const desktop = responsiveDesktop(entries, ["one", "two"], { width: 500, height: 500 }, breaks);
    expect(desktop.pages).toHaveLength(2);
    expect(desktop.pages.map((page) => page.segment)).toEqual([{ column: 0, row: 0 }, { column: 1, row: 0 }]);
    expect(desktop.breakCapacity).toBe(16);
    expect(desktop.capacity).toBeLessThan(desktop.breakCapacity);
    expect(responsiveDesktop(entries, ["one", "two"], { width: 1200, height: 700 }, breaks).pages).toHaveLength(1);
  });

  test("creates non-empty workspaces before and after the active page", () => {
    const entries = [file("one"), file("two"), file("three")];
    const layout: DesktopLayout = { rootOrder: ["one", "two", "three"], workspaceBreaks: [], snapToGrid: false, wallpaper: "dusk" };
    const pages = responsiveDesktop(entries, layout.rootOrder, { width: 500, height: 500 }).pages;
    const after = createEdgeWorkspaceLayout(layout, pages, "two", 0, false, 16);
    const before = createEdgeWorkspaceLayout(layout, pages, "two", 0, true, 16);
    expect(after.rootOrder).toEqual(["one", "three", "two"]);
    expect(after.workspaceBreaks).toEqual([{ entryId: "two", maxCapacity: 16 }]);
    expect(before.rootOrder).toEqual(["two", "one", "three"]);
    expect(before.workspaceBreaks).toEqual([{ entryId: "one", maxCapacity: 16 }]);
  });

  test("does not represent an empty source workspace when moving its only icon", () => {
    const entry = file("only");
    const layout: DesktopLayout = { rootOrder: [entry.id], workspaceBreaks: [], snapToGrid: false, wallpaper: "dusk" };
    const pages = responsiveDesktop([entry], layout.rootOrder, { width: 500, height: 500 }).pages;
    const next = createEdgeWorkspaceLayout(layout, pages, entry.id, 0, false, 16);
    expect(next).toEqual(layout);
  });

  test("moves an icon by destination identity when removing its source shifts page indexes", () => {
    const entries = [file("one"), file("two"), file("three")];
    const layout: DesktopLayout = {
      rootOrder: ["one", "two", "three"],
      workspaceBreaks: [{ entryId: "two", maxCapacity: 16 }, { entryId: "three", maxCapacity: 16 }],
      snapToGrid: false,
      wallpaper: "dusk",
    };
    const desktop = responsiveDesktop(entries, layout.rootOrder, { width: 500, height: 500 }, layout.workspaceBreaks);
    const next = moveEntryToWorkspaceLayout(layout, desktop.pages, "one", 2, desktop.breakCapacity);
    expect(next.rootOrder).toEqual(["two", "three", "one"]);
    expect(next.workspaceBreaks).toEqual([{ entryId: "three", maxCapacity: 16 }]);
  });

  test("moves an icon backward without leaving an empty source workspace", () => {
    const entries = [file("one"), file("two"), file("three")];
    const layout: DesktopLayout = {
      rootOrder: ["one", "two", "three"],
      workspaceBreaks: [{ entryId: "two", maxCapacity: 16 }, { entryId: "three", maxCapacity: 16 }],
      snapToGrid: false,
      wallpaper: "dusk",
    };
    const desktop = responsiveDesktop(entries, layout.rootOrder, { width: 500, height: 500 }, layout.workspaceBreaks);
    const next = moveEntryToWorkspaceLayout(layout, desktop.pages, "three", 0, desktop.breakCapacity);
    expect(next.rootOrder).toEqual(["one", "three", "two"]);
    expect(next.workspaceBreaks).toEqual([{ entryId: "two", maxCapacity: 16 }]);
  });
});
