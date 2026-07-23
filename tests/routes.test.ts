import { describe, expect, test } from "bun:test";
import { API_ROUTES } from "../src/lib/api-routes";
import { formatDesktopRoute, parseDesktopRoute } from "../src/lib/routes";

describe("canonical routes", () => {
  test("round-trips desktop areas and rejects old hashes", () => {
    const route = { desktopId: "desk one", column: -2, row: 3, fileId: "file #3" };
    expect(formatDesktopRoute(route)).toBe("#/desktops/desk%20one/areas/-2/3/file/file%20%233");
    expect(parseDesktopRoute(formatDesktopRoute(route))).toEqual(route);
    expect(parseDesktopRoute("#/desktops/desk/areas/not-a-column/0")).toBeNull();
  });

  test("constructs only canonical scoped API paths", () => {
    expect(API_ROUTES.catalog).toBe("/api/catalog");
    expect(API_ROUTES.desktopEntries("a/b")).toBe("/api/desktops/a%2Fb/entries");
    expect(API_ROUTES.desktopMoveEntries("d")).toBe("/api/desktops/d/entries/move");
    expect(API_ROUTES.desktopDeleteEntries("d")).toBe("/api/desktops/d/entries/delete");
    expect(API_ROUTES.desktopContent("d", "a/b")).toBe("/api/desktops/d/entries/a%2Fb/content");
    expect(API_ROUTES.desktopBlobMutations("d")).toBe("/api/desktops/d/blob-mutations");
    expect(API_ROUTES.desktopBlobMutationCommit("d", "upload/id")).toBe("/api/desktops/d/blob-mutations/upload%2Fid/commit");
    expect(API_ROUTES.desktopContentAccess("d", "a/b", 7)).toBe("/api/desktops/d/entries/a%2Fb/content-access?revision=7");
    expect(API_ROUTES.desktopRootEntryPositions("d")).toBe("/api/desktops/d/root-entry-positions");
    expect(API_ROUTES.entryTransfers).toBe("/api/entry-transfers");
  });

  test("round-trips explorer, properties, settings, and signed area coordinates", () => {
    expect(parseDesktopRoute("#/desktops/desk/areas/-7/2/explorer/root/file/read%20me")).toEqual({ desktopId: "desk", column: -7, row: 2, explorerFolderId: null, fileId: "read me" });
    expect(formatDesktopRoute({ desktopId: "desk", column: 0, row: -1, propertiesEntryId: "entry" })).toBe("#/desktops/desk/areas/0/-1/properties/entry");
    expect(formatDesktopRoute({ desktopId: "desk", column: 3, row: 4, settings: true })).toBe("#/desktops/desk/areas/3/4/settings");
    expect(parseDesktopRoute("#/desktops/desk/areas/0/0/file/a/properties/b")).toBeNull();
  });
});
