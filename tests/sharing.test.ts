import { describe, expect, test } from "bun:test";
import { parseSharingState } from "../src/lib/sharing";

describe("sharing contracts", () => {
  test("accepts pending invitation aliases and publication tokens", () => {
    const state = parseSharingState({
      members: [{ id: "owner", displayName: "Owner", role: "owner", avatar: null }],
      pendingInvitations: [{ email: "reader@example.test", role: "reader", token: "invite-token", url: "/invite/invite-token" }],
      publication: { token: "public-token" },
      audience: { kind: "authenticated-users", role: "reader" },
    });
    expect(state.members[0]).toMatchObject({ userId: "owner", role: "owner" });
    expect(state.pending[0]).toMatchObject({ token: "invite-token", role: "reader" });
    expect(state.publication).toEqual({ published: true, token: "public-token" });
    expect(state.audience).toEqual({ kind: "authenticated-users", role: "reader" });
  });

  test("rejects owner roles for invitations", () => {
    expect(() => parseSharingState({ members: [], pending: [{ email: "x@example.test", role: "owner" }], publication: {} })).toThrow("invalid role");
  });
});
