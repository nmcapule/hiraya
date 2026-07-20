import { describe, expect, test } from "bun:test";
import { API_ROUTES } from "../src/lib/api-routes";
import { formatDesktopRoute, parseDesktopRoute } from "../src/lib/routes";

describe("routes", () => {
  test("round-trips encoded desktop IDs", () => {
    const route = { viewId: "view one", explorerFolderId: "folder two", fileId: "file #3" };
    expect(parseDesktopRoute(formatDesktopRoute(route))).toEqual(route);
  });

  test("rejects trailing and malformed route segments", () => {
    expect(parseDesktopRoute("#/views/one/unknown")).toBeNull();
    expect(parseDesktopRoute("#/views/%E0%A4%A")).toBeNull();
  });

  test("encodes API path parameters as one segment", () => {
    expect(API_ROUTES.entry("a/b")).toBe("/api/entries/a%2Fb");
    expect(API_ROUTES.content("a b")).toBe("/api/files/a%20b/content");
  });
});
