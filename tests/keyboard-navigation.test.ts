import { describe, expect, test } from "bun:test";
import { linearNavigationIndex, submenuKeyIntent } from "../src/ui/keyboard-navigation";

describe("modal, tab, and submenu keyboard navigation", () => {
  test("wraps modal-style vertical focus and honors Home and End", () => {
    expect(linearNavigationIndex(0, 3, "ArrowUp", "vertical")).toBe(2);
    expect(linearNavigationIndex(2, 3, "ArrowDown", "vertical")).toBe(0);
    expect(linearNavigationIndex(1, 3, "Home", "vertical")).toBe(0);
    expect(linearNavigationIndex(1, 3, "End", "vertical")).toBe(2);
  });

  test("moves horizontal tabs with arrows and ignores vertical arrows", () => {
    expect(linearNavigationIndex(0, 2, "ArrowRight", "horizontal")).toBe(1);
    expect(linearNavigationIndex(0, 2, "ArrowLeft", "horizontal")).toBe(1);
    expect(linearNavigationIndex(0, 2, "ArrowDown", "horizontal")).toBe(0);
  });

  test("opens and closes ARIA submenus with standard keys", () => {
    expect(submenuKeyIntent("ArrowRight", "trigger")).toBe("open");
    expect(submenuKeyIntent("Enter", "trigger")).toBe("open");
    expect(submenuKeyIntent("ArrowLeft", "submenu")).toBe("close");
    expect(submenuKeyIntent("Escape", "submenu")).toBe("close");
    expect(submenuKeyIntent("ArrowDown", "trigger")).toBe("none");
  });
});
