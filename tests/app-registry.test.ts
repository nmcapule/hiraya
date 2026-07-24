import { describe, expect, test } from "bun:test";
import {
  BUILTIN_APP_REGISTRY,
  builtinAppEntryDependency,
  builtinAppMaximizeRestoreWindow,
  builtinAppTargetId,
  builtinAppWindow,
  extractBuiltinAppTarget,
} from "../src/apps/registry";

describe("built-in app registry", () => {
  test("contains only the persisted phase 1 app kinds", () => {
    expect(Object.keys(BUILTIN_APP_REGISTRY)).toEqual(["file", "explorer", "properties", "settings"]);
  });

  test("extracts normalized targets from runtime app state", () => {
    expect(extractBuiltinAppTarget({ kind: "file", fileId: "file", editMode: true, blob: new Blob() })).toEqual({ kind: "file", fileId: "file", editMode: true });
    expect(extractBuiltinAppTarget({ kind: "file", fileId: "file", editMode: false })).toEqual({ kind: "file", fileId: "file" });
    expect(extractBuiltinAppTarget({ kind: "explorer", folderId: null, bounds: {} })).toEqual({ kind: "explorer", folderId: null });
    expect(extractBuiltinAppTarget({ kind: "properties", entryId: "entry", transient: true })).toEqual({ kind: "properties", entryId: "entry" });
    expect(extractBuiltinAppTarget({ kind: "settings", page: "themes" })).toEqual({ kind: "settings" });
  });

  test("rejects unknown and malformed runtime targets", () => {
    for (const value of [null, [], { kind: "trash" }, { kind: "file", fileId: "" }, { kind: "file", fileId: "file", editMode: "yes" }, { kind: "explorer" }, { kind: "explorer", folderId: 4 }, { kind: "properties", entryId: "" }]) {
      expect(extractBuiltinAppTarget(value)).toBeNull();
    }
  });

  test("owns stable target IDs and entry dependencies", () => {
    expect(builtinAppTargetId({ kind: "file", fileId: "alpha" })).toBe("file:alpha");
    expect(builtinAppTargetId({ kind: "explorer", folderId: null })).toBe("explorer:root");
    expect(builtinAppTargetId({ kind: "explorer", folderId: "folder" })).toBe("explorer:folder");
    expect(builtinAppTargetId({ kind: "properties", entryId: "alpha" })).toBe("properties:alpha");
    expect(builtinAppTargetId({ kind: "settings" })).toBe("settings");

    expect(builtinAppEntryDependency({ kind: "file", fileId: "alpha" })).toEqual({ entryId: "alpha", kind: "file" });
    expect(builtinAppEntryDependency({ kind: "explorer", folderId: "folder" })).toEqual({ entryId: "folder", kind: "folder" });
    expect(builtinAppEntryDependency({ kind: "properties", entryId: "alpha" })).toEqual({ entryId: "alpha", kind: "entry" });
    expect(builtinAppEntryDependency({ kind: "explorer", folderId: null })).toBeNull();
    expect(builtinAppEntryDependency({ kind: "settings" })).toBeNull();
  });

  test("owns launch, minimum, and behavior-compatible maximize restore dimensions", () => {
    expect(builtinAppWindow("file")).toEqual({ width: 920, height: 680, minWidth: 420, minHeight: 320 });
    expect(builtinAppWindow("explorer")).toEqual({ width: 760, height: 590, minWidth: 360, minHeight: 280 });
    expect(builtinAppWindow("properties")).toEqual({ width: 520, height: 570, minWidth: 360, minHeight: 320 });
    expect(builtinAppWindow("settings")).toEqual({ width: 720, height: 700, minWidth: 360, minHeight: 280 });
    expect(builtinAppMaximizeRestoreWindow("properties")).toEqual({ width: 720, height: 590, minWidth: 360, minHeight: 280 });
  });
});
