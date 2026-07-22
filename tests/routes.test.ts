import { describe, expect, test } from "bun:test";
import { API_ROUTES } from "../src/lib/api-routes";
import { formatDesktopRoute, normalizeDesktopRoute, parseDesktopRoute, resolveOpenFilePath } from "../src/lib/routes";
import type { DesktopEntry } from "../src/types";

const entries: DesktopEntry[] = [
  { id: "folder two", name: "Folder", kind: "folder", parentId: null, modifiedAt: 1, position: { x: 0, y: 0 } },
  { id: "file #3", name: "File", kind: "file", parentId: null, modifiedAt: 1, position: { x: 0, y: 0 }, mimeType: "text/plain", size: 1 },
  { id: "nested file", name: "Notes + Ideas.txt", kind: "file", parentId: "folder two", modifiedAt: 1, position: { x: 0, y: 0 }, mimeType: "text/plain", size: 1 },
];

describe("routes", () => {
  test("round-trips signed surface segments and encoded targets", () => {
    const route = { column: -12, row: 7, explorerFolderId: "folder two", fileId: "file #3" };
    expect(formatDesktopRoute(route)).toBe("#/workspaces/-12/7/explorer/folder/folder%20two/file/file%20%233");
    expect(parseDesktopRoute(formatDesktopRoute(route))).toEqual(route);
  });

  test("supports root explorer and file suffixes", () => {
    expect(parseDesktopRoute("#/workspaces/0/-2/explorer/root/file/file%20%233")).toEqual({
      column: 0,
      row: -2,
      explorerFolderId: null,
      fileId: "file #3",
    });
  });

  test("round-trips the settings app", () => {
    const route = { column: -2, row: 4, settings: true as const };
    expect(formatDesktopRoute(route)).toBe("#/workspaces/-2/4/settings");
    expect(parseDesktopRoute(formatDesktopRoute(route))).toEqual(route);
    expect(normalizeDesktopRoute(route, entries)).toEqual(route);
    expect(parseDesktopRoute("#/workspaces/0/0/file/file%20%233/settings")).toBeNull();
    expect(formatDesktopRoute({ ...route, fileId: "file #3" })).toBe("#/workspaces/-2/4/settings");
  });

  test("canonicalizes leading zeroes", () => {
    const route = parseDesktopRoute("#/workspaces/-007/02");
    expect(route).toEqual({ column: -7, row: 2 });
    expect(formatDesktopRoute(route!)).toBe("#/workspaces/-7/2");
  });

  test("maps legacy dense links onto row zero", () => {
    expect(parseDesktopRoute("#/workspaces/7")).toEqual({ column: 7, row: 0 });
    expect(parseDesktopRoute("#/views/view%20one/file/file%20%233")).toEqual({ column: 0, row: 0, fileId: "file #3" });
  });

  test("rejects malformed coordinates and route segments", () => {
    expect(parseDesktopRoute("#/workspaces/1.5/2")).toBeNull();
    expect(parseDesktopRoute("#/workspaces/1/9007199254740992")).toBeNull();
    expect(parseDesktopRoute("#/workspaces/1/2/unknown")).toBeNull();
    expect(parseDesktopRoute("#/workspaces/1/2/explorer/folder/%E0%A4%A")).toBeNull();
  });

  test("normalizes coordinates without clamping the surface", () => {
    expect(normalizeDesktopRoute({ column: -9, row: 14 }, entries)).toEqual({ column: -9, row: 14 });
    expect(normalizeDesktopRoute(null, entries)).toEqual({ column: 0, row: 0 });
  });

  test("preserves only valid explorer and file targets", () => {
    expect(normalizeDesktopRoute({ column: 1, row: -1, explorerFolderId: "folder two", fileId: "file #3" }, entries)).toEqual({
      column: 1,
      row: -1,
      explorerFolderId: "folder two",
      fileId: "file #3",
    });
    expect(normalizeDesktopRoute({ column: 1, row: 2, explorerFolderId: "file #3", fileId: "folder two" }, entries)).toEqual({ column: 1, row: 2 });
  });

  test("encodes API routes", () => {
    expect(API_ROUTES.entry("a/b")).toBe("/api/entries/a%2Fb");
    expect(API_ROUTES.content("a b")).toBe("/api/files/a%20b/content");
    expect(API_ROUTES.desktopPositions).toBe("/api/desktop-positions");
  });

  test("resolves root-relative file paths using workspace name rules", () => {
    expect(resolveOpenFilePath(entries, "folder/notes + ideas.TXT").id).toBe("nested file");
    expect(resolveOpenFilePath(entries, "File").id).toBe("file #3");
  });

  test("rejects missing, folder, and malformed open paths", () => {
    expect(() => resolveOpenFilePath(entries, "Folder")).toThrow('No file exists at “Folder”.');
    expect(() => resolveOpenFilePath(entries, "Folder/Missing.txt")).toThrow('No file exists at “Folder/Missing.txt”.');
    expect(() => resolveOpenFilePath(entries, "../File")).toThrow('“../File” is not a valid file path.');
    expect(() => resolveOpenFilePath(entries, "/File")).toThrow('“/File” is not a valid file path.');
    expect(() => resolveOpenFilePath(entries, "Folder\\File")).toThrow('“Folder\\File” is not a valid file path.');
  });
});
