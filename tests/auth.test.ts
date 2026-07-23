import { describe, expect, test } from "bun:test";
import { AuthenticationRequiredError, bootstrapSession, loginUrl, parseAuthSession, safeReturnPath } from "../src/lib/auth";

describe("session bootstrap", () => {
  test("validates stable storage identity and display metadata", () => {
    expect(parseAuthSession({ storageId: "opaque-account-1", user: { displayName: "Ada", email: "ada@example.test" } })).toEqual({
      storageId: "opaque-account-1",
      user: { displayName: "Ada", email: "ada@example.test" },
    });
    expect(() => parseAuthSession({ storageId: "", user: { displayName: "Ada" } })).toThrow("storage ID");
  });

  test("keeps login returns root-relative", () => {
    expect(safeReturnPath({ pathname: "/", search: "?open=Notes", hash: "#/desktops/desk" } as Location)).toBe("/?open=Notes#/desktops/desk");
    expect(safeReturnPath({ pathname: "//example.test", search: "", hash: "" } as Location)).toBe("/");
    expect(loginUrl({ pathname: "/desk", search: "", hash: "#area" } as Location)).toBe("/login?returnTo=%2Fdesk%23area");
  });

  test("does not fetch in frontend-only mode", async () => {
    let fetched = false;
    expect(await bootstrapSession(true, (async () => { fetched = true; throw new Error("unexpected"); }) as typeof fetch)).toBeNull();
    expect(fetched).toBe(false);
  });

  test("redirects a 401 through the centralized handler", async () => {
    let redirects = 0;
    await expect(bootstrapSession(false, (async () => new Response(null, { status: 401 })) as typeof fetch, () => { redirects += 1; })).rejects.toBeInstanceOf(AuthenticationRequiredError);
    expect(redirects).toBe(1);
  });
});
