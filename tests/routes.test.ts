import { describe, expect, test } from "bun:test";
import { API_ROUTES } from "../src/lib/api-routes";
import { formatDesktopRoute, normalizeDesktopRoute, parseDesktopRoute } from "../src/lib/routes";
import type { DesktopEntry } from "../src/types";

const entries: DesktopEntry[] = [
  { id: "folder two", name: "Folder", kind: "folder", parentId: null, modifiedAt: 1, position: { x: 0, y: 0 } },
  { id: "file #3", name: "File", kind: "file", parentId: null, modifiedAt: 1, position: { x: 0, y: 0 }, mimeType: "text/plain", size: 1 },
];

describe("routes", () => {
  test("round-trips a page index and encoded explorer and file IDs", () => {
    const route = { pageIndex: 12, explorerFolderId: "folder two", fileId: "file #3" };
    expect(formatDesktopRoute(route)).toBe("#/workspaces/12/explorer/folder/folder%20two/file/file%20%233");
    expect(parseDesktopRoute(formatDesktopRoute(route))).toEqual(route);
  });

  test("supports root explorer and file suffixes", () => {
    expect(parseDesktopRoute("#/workspaces/0/explorer/root/file/file%20%233")).toEqual({
      pageIndex: 0,
      explorerFolderId: null,
      fileId: "file #3",
    });
    expect(parseDesktopRoute("#/workspaces/2/file/file%20%233")).toEqual({ pageIndex: 2, fileId: "file #3" });
  });

  test("parses noncanonical leading zeroes for canonical replacement", () => {
    const route = parseDesktopRoute("#/workspaces/007");
    expect(route).toEqual({ pageIndex: 7 });
    expect(formatDesktopRoute(route!)).toBe("#/workspaces/7");
  });

  test("migrates legacy view links to page zero while preserving suffixes", () => {
    const route = parseDesktopRoute("#/views/view%20one/explorer/folder/folder%20two/file/file%20%233");
    expect(route).toEqual({ pageIndex: 0, explorerFolderId: "folder two", fileId: "file #3" });
    expect(formatDesktopRoute(route!)).toBe("#/workspaces/0/explorer/folder/folder%20two/file/file%20%233");
  });

  test("rejects invalid page indexes and malformed route segments", () => {
    expect(parseDesktopRoute("#/workspaces/-1")).toBeNull();
    expect(parseDesktopRoute("#/workspaces/1.5")).toBeNull();
    expect(parseDesktopRoute("#/workspaces/9007199254740992")).toBeNull();
    expect(parseDesktopRoute("#/workspaces/1/unknown")).toBeNull();
    expect(parseDesktopRoute("#/workspaces/1/explorer/folder/%E0%A4%A")).toBeNull();
    expect(parseDesktopRoute("#/views/%E0%A4%A")).toBeNull();
  });

  test("normalizes and clamps page indexes", () => {
    expect(normalizeDesktopRoute({ pageIndex: 2 }, entries, 4)).toEqual({ pageIndex: 2 });
    expect(normalizeDesktopRoute({ pageIndex: -3 }, entries, 4)).toEqual({ pageIndex: 0 });
    expect(normalizeDesktopRoute({ pageIndex: 9 }, entries, 4)).toEqual({ pageIndex: 3 });
    expect(normalizeDesktopRoute(null, entries, 4)).toEqual({ pageIndex: 0 });
  });

  test("uses an implicit minimum page count of one", () => {
    expect(normalizeDesktopRoute({ pageIndex: 4 }, entries, 0)).toEqual({ pageIndex: 0 });
    expect(normalizeDesktopRoute({ pageIndex: 4 }, entries, -2)).toEqual({ pageIndex: 0 });
    expect(normalizeDesktopRoute({ pageIndex: 4 }, entries, Number.NaN)).toEqual({ pageIndex: 0 });
  });

  test("preserves only explorer and file targets of the correct kind", () => {
    expect(normalizeDesktopRoute({ pageIndex: 1, explorerFolderId: "folder two", fileId: "file #3" }, entries, 2)).toEqual({
      pageIndex: 1,
      explorerFolderId: "folder two",
      fileId: "file #3",
    });
    expect(normalizeDesktopRoute({ pageIndex: 1, explorerFolderId: "file #3", fileId: "folder two" }, entries, 2)).toEqual({ pageIndex: 1 });
    expect(normalizeDesktopRoute({ pageIndex: 1, explorerFolderId: null }, entries, 2)).toEqual({ pageIndex: 1, explorerFolderId: null });
  });

  test("encodes API path parameters as one segment", () => {
    expect(API_ROUTES.entry("a/b")).toBe("/api/entries/a%2Fb");
    expect(API_ROUTES.content("a b")).toBe("/api/files/a%20b/content");
  });
});
