import { describe, expect, test } from "bun:test";
import { publicFolderBackTarget, publicWindowBounds } from "../src/ui/public-desktop-layout";

describe("public desktop window geometry", () => {
  test("fits large and constrained measured surfaces", () => {
    expect(publicWindowBounds({ width: 1200, height: 800 })).toEqual({ x: 28, y: 28, width: 920, height: 680 });
    expect(publicWindowBounds({ width: 390, height: 500 })).toEqual({ x: 12, y: 12, width: 366, height: 476 });
    expect(publicWindowBounds({ width: 280, height: 180 })).toEqual({ x: 0, y: 0, width: 280, height: 180 });
  });

  test("resolves public mobile back navigation without inventing controls", () => {
    const entries = [
      { kind: "folder" as const, id: "parent", name: "Parent", parentId: null, createdAt: 1, modifiedAt: 1, position: { x: 0, y: 0 } },
      { kind: "folder" as const, id: "child", name: "Child", parentId: "parent", createdAt: 1, modifiedAt: 1, position: { x: 0, y: 0 } },
    ];
    expect(publicFolderBackTarget(entries, "child")).toBe("parent");
    expect(publicFolderBackTarget(entries, "parent")).toBeNull();
    expect(publicFolderBackTarget(entries, "missing")).toBeUndefined();
  });
});
