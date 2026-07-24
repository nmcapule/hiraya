import { describe, expect, test } from "bun:test";
import { boundedNotificationVisibility } from "../src/ui/notifications";

describe("notification visibility", () => {
  test("caps rows and reserves an expandable drawer for durable overflow", () => {
    expect(boundedNotificationVisibility({ error: true, notice: true, trash: 2, apps: 3 })).toEqual({
      total: 7,
      showError: true,
      visibleTrash: 1,
      showNotice: false,
      visibleApps: 0,
      hidden: 5,
    });
  });

  test("uses all rows when no drawer is required", () => {
    expect(boundedNotificationVisibility({ error: false, notice: true, trash: 1, apps: 1 })).toEqual({
      total: 3,
      showError: false,
      visibleTrash: 1,
      showNotice: true,
      visibleApps: 1,
      hidden: 0,
    });
  });
});
