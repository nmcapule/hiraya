import { describe, expect, test } from "bun:test";
import { createTrashNotification, dismissTrashNotification, updateTrashNotification } from "../src/lib/trash-notifications";

describe("actionable Trash notifications", () => {
  test("stack independently and remain until explicitly dismissed", () => {
    const first = createTrashNotification("desk", "one.txt", ["one"], "first");
    const second = createTrashNotification("desk", "two.txt", ["two"], "second");
    const failed = updateTrashNotification([first, second], "first", "failed", "Restore failed");
    expect(failed).toHaveLength(2);
    expect(failed[0]).toMatchObject({ state: "failed", error: "Restore failed" });
    expect(failed[1].state).toBe("ready");
    expect(dismissTrashNotification(failed, "first")).toEqual([second]);
  });
});
