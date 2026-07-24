import { describe, expect, test } from "bun:test";
import { canMutateDesktop, localDesktopIdentity, OWNER_CAPABILITIES, READ_ONLY_CAPABILITIES, sharedOfflineMessage } from "../src/lib/permissions";
import type { DesktopIdentity } from "../src/types";

function shared(role: DesktopIdentity["role"], capabilities: DesktopIdentity["capabilities"]): DesktopIdentity {
  return { id: "shared", name: "Shared", ownership: "shared", role, owner: { id: "owner", displayName: "Owner", avatar: null }, capabilities, authorityCatalogId: "owner-catalog" };
}

describe("desktop permissions", () => {
  test("keeps browser-local desktops as owners", () => {
    expect(localDesktopIdentity("desk", "Desktop")).toMatchObject({ ownership: "owned", role: "owner", capabilities: OWNER_CAPABILITIES });
  });

  test("requires write capability and disables shared offline mutation", () => {
    const writer = shared("writer", { ...READ_ONLY_CAPABILITIES, write: true });
    expect(canMutateDesktop(writer, "online")).toBe(true);
    expect(canMutateDesktop(writer, "offline")).toBe(false);
    expect(sharedOfflineMessage(writer, "offline")).toContain("unavailable offline");
    expect(canMutateDesktop(shared("reader", READ_ONLY_CAPABILITIES), "online")).toBe(false);
  });

  test("preserves owned offline queue behavior", () => {
    expect(canMutateDesktop(localDesktopIdentity("desk", "Desktop"), "offline")).toBe(true);
    expect(canMutateDesktop(localDesktopIdentity("desk", "Desktop"), "connecting")).toBe(false);
  });
});
