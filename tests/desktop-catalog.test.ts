import { describe, expect, test } from "bun:test";
import { desktopDeleteProtection, parseDesktopCatalog, resolveDesktopContext } from "../src/lib/desktop-catalog";

describe("desktop catalog", () => {
  test("parses strict schema version 1", () => {
    const value = { schemaVersion: 1, catalogId: "catalog-1", catalogRevision: 7, desktops: [{ id: "desk", name: "Desktop" }] };
    expect(parseDesktopCatalog(value)).toEqual(value);
    expect(() => parseDesktopCatalog({ ...value, schemaVersion: 2 })).toThrow("schema version");
    expect(() => parseDesktopCatalog({ ...value, catalogRevision: -1 })).toThrow("revision");
  });

  test("uses tab-local selection and protects only the last desktop", () => {
    const desktops = [{ id: "one", name: "One" }, { id: "two", name: "Two" }];
    expect(resolveDesktopContext("two", desktops)).toBe("two");
    expect(resolveDesktopContext("missing", desktops)).toBe("one");
    expect(desktopDeleteProtection(2)).toBe("");
    expect(desktopDeleteProtection(1)).toContain("last desktop");
  });
});
