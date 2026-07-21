import { describe, expect, test } from "bun:test";
import type { DesktopEntry } from "../src/types";
import { desktopSlots, responsiveDesktop } from "../src/ui/desktop-geometry";

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

  test("preserves fitting positions and relocates collisions", () => {
    const entries = [file("one", 160, 30), file("two", 160, 30)];
    const desktop = responsiveDesktop(entries, ["one", "two"], { width: 500, height: 500 });
    expect(desktop.positions.get("one")).toEqual({ x: 160, y: 30 });
    expect(desktop.positions.get("two")).not.toEqual({ x: 160, y: 30 });
  });

  test("repaginates the same order for a smaller device", () => {
    const entries = Array.from({ length: 20 }, (_, index) => file(`file-${index}`, 22 + index * 104, 22));
    const order = entries.map((entry) => entry.id);
    expect(responsiveDesktop(entries, order, { width: 1200, height: 700 }).pages).toHaveLength(1);
    expect(responsiveDesktop(entries, order, { width: 390, height: 600 }).pages.length).toBeGreaterThan(1);
  });

  test("uses one implicit page without creating an empty workspace", () => {
    const desktop = responsiveDesktop([], [], { width: 390, height: 600 });
    expect(desktop.pages).toEqual([]);
    expect(desktop.columns).toBe(1);
    expect(desktop.rows).toBe(1);
  });
});
