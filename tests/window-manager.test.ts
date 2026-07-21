import { describe, expect, test } from "bun:test";
import {
  clampWindowBounds,
  initialWindowBounds,
  resizeWindowBounds,
} from "../src/ui/window-manager";

describe("window manager geometry", () => {
  test("staggered initial bounds stay inside the viewport", () => {
    const viewport = { width: 1200, height: 800 };
    const first = initialWindowBounds(viewport, { width: 600, height: 400, index: 0 });
    const second = initialWindowBounds(viewport, { width: 600, height: 400, index: 1 });

    expect(first).toEqual({ x: 28, y: 28, width: 600, height: 400 });
    expect(second).toEqual({ x: 56, y: 56, width: 600, height: 400 });
    expect(initialWindowBounds({ width: 280, height: 180 }, { index: 8 })).toEqual({
      x: 0,
      y: 0,
      width: 280,
      height: 180,
    });
  });

  test("clamps position, size, and minimums to the available viewport", () => {
    expect(clampWindowBounds(
      { x: -40, y: 500, width: 900, height: 100 },
      { width: 800, height: 600 },
      { minWidth: 300, minHeight: 240 },
    )).toEqual({ x: 0, y: 360, width: 800, height: 240 });

    expect(clampWindowBounds(
      { x: 10, y: 10, width: 50, height: 50 },
      { width: 200, height: 120 },
    )).toEqual({ x: 0, y: 0, width: 200, height: 120 });
  });

  test("resizes each edge while preserving the opposite edge", () => {
    const viewport = { width: 1000, height: 700 };
    const bounds = { x: 200, y: 150, width: 500, height: 350 };
    const minimum = { minWidth: 300, minHeight: 200 };

    expect(resizeWindowBounds(bounds, "w", { x: 100, y: 0 }, viewport, minimum))
      .toEqual({ x: 300, y: 150, width: 400, height: 350 });
    expect(resizeWindowBounds(bounds, "n", { x: 0, y: -100 }, viewport, minimum))
      .toEqual({ x: 200, y: 50, width: 500, height: 450 });
    expect(resizeWindowBounds(bounds, "se", { x: 500, y: 500 }, viewport, minimum))
      .toEqual({ x: 200, y: 150, width: 800, height: 550 });
  });

  test("corner resizing respects minimum size and viewport edges", () => {
    expect(resizeWindowBounds(
      { x: 100, y: 100, width: 500, height: 400 },
      "nw",
      { x: 1000, y: 1000 },
      { width: 900, height: 700 },
      { minWidth: 320, minHeight: 220 },
    )).toEqual({ x: 280, y: 280, width: 320, height: 220 });
  });
});
