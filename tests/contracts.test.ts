import { describe, expect, test } from "bun:test";
import { isValidId, normalizeDesktopName, parseDesktopList, parseEntries, parseLayout, parsePosition, parseRemoteWorkspace, parseRootDesktopPositions } from "../src/lib/contracts";
import { namesMatch, validateEntryName } from "../src/lib/entry-validation";
import { remoteWorkspace } from "./fixtures";
import { BUILTIN_THEMES } from "../src/lib/themes";

describe("workspace contracts", () => {
  test("parses a complete server workspace without retaining unknown fields", () => {
    const input = remoteWorkspace();
    const parsed = parseRemoteWorkspace({ ...input, ignored: true });
    expect(parsed).toEqual(input);
    expect("ignored" in parsed).toBe(false);
  });

  test("accepts desktop metadata alongside a directly parseable workspace", () => {
    const input = remoteWorkspace();
    expect(parseRemoteWorkspace({ ...input, id: "desktop-1", name: "Projects" })).toEqual(input);
  });

  test("rejects malformed remote revisions and hierarchy", () => {
    expect(() => parseRemoteWorkspace({ ...remoteWorkspace(), revision: 1.5 })).toThrow("revision");
    const input = remoteWorkspace();
    input.entries[0].parentId = "missing";
    expect(() => parseRemoteWorkspace(input)).toThrow("missing parent");
  });

  test("normalizes missing creation dates and validates present dates", () => {
    const entry = { kind: "folder", id: "a", name: "A", parentId: null, modifiedAt: 1, position: { x: 0, y: 0 } };
    expect(parseEntries([entry])[0].createdAt).toBeNull();
    expect(parseEntries([{ ...entry, createdAt: 0 }])[0].createdAt).toBe(0);
    expect(() => parseEntries([{ ...entry, createdAt: -1 }])).toThrow("creation date");
    expect(() => parseEntries([{ ...entry, createdAt: Number.MAX_SAFE_INTEGER + 1 }])).toThrow("creation date");
  });

  test("validates revisioned remote appearance", () => {
    const input = remoteWorkspace();
    input.appearance.selectionRevision = -1;
    expect(() => parseRemoteWorkspace(input)).toThrow("selection");

    const duplicate = remoteWorkspace();
    const definition = structuredClone(BUILTIN_THEMES["hiraya-dusk"].definition);
    duplicate.appearance.customThemes = [
      { id: "custom", name: "Custom", definition, revision: 1 },
      { id: "custom", name: "Copy", definition, revision: 2 },
    ];
    duplicate.appearance.selectedThemeId = "custom";
    expect(() => parseRemoteWorkspace(duplicate)).toThrow("duplicate");
  });

  test("accepts the intentionally empty shape of an uninitialized server", () => {
    expect(parseRemoteWorkspace({
      schemaVersion: 5,
      workspaceId: "workspace-1",
      initialized: false,
      revision: 0,
      entries: [],
      layout: { snapToGrid: false, wallpaper: "dusk" },
      layoutRevision: 0,
      editorSettings: { autoSave: true, fontSize: 13, language: "auto" },
      settingsRevision: 0,
    })).toEqual({ schemaVersion: 5, workspaceId: "workspace-1", initialized: false, revision: 0 });
    expect(() => parseRemoteWorkspace({ schemaVersion: 4, workspaceId: "workspace-1", initialized: false, revision: 0 })).toThrow("schema version");
  });

  test("parses only coordinate-independent layout preferences", () => {
    expect(parseLayout({ rootOrder: ["ignored"], workspaceBreaks: [{}], snapToGrid: true, wallpaper: "grove" })).toEqual({ snapToGrid: true, wallpaper: "grove" });
  });

  test("accepts signed finite positions and validates root batches", () => {
    expect(parsePosition({ x: -120.5, y: 30 })).toEqual({ x: -120.5, y: 30 });
    expect(() => parsePosition({ x: Number.POSITIVE_INFINITY, y: 0 })).toThrow("position");
    const entries = [{ kind: "folder" as const, id: "a", name: "A", parentId: null, modifiedAt: 1, position: { x: 0, y: 0 } }];
    expect(parseRootDesktopPositions([{ entryId: "a", position: { x: -1, y: -2 } }], entries)).toEqual([{ entryId: "a", position: { x: -1, y: -2 } }]);
    expect(() => parseRootDesktopPositions([], entries)).toThrow("At least one");
    expect(() => parseRootDesktopPositions([{ entryId: "a", position: { x: 0, y: 0 } }, { entryId: "a", position: { x: 1, y: 1 } }], entries)).toThrow("duplicate");
  });

  test("uses deterministic Go-aligned ID and sibling-name rules", () => {
    expect(isValidId("entry-1")).toBe(true);
    expect(isValidId(`bad${String.fromCharCode(127)}`)).toBe(false);
    expect(isValidId("é".repeat(91))).toBe(false);
    expect(namesMatch("Report.TXT", "report.txt")).toBe(true);
    expect(validateEntryName("  report.txt  ")).toBe("report.txt");
    expect(() => validateEntryName(`bad${String.fromCharCode(127)}`)).toThrow();
  });

  test("validates stable desktop identities and names", () => {
    expect(normalizeDesktopName("  Projects  ")).toBe("Projects");
    expect(parseDesktopList([{ id: "desk-1", name: "Projects" }])).toEqual([{ id: "desk-1", name: "Projects" }]);
    expect(() => parseDesktopList([])).toThrow("At least one desktop");
    expect(() => parseDesktopList([{ id: "desk-1", name: "One" }, { id: "desk-1", name: "Two" }])).toThrow("duplicate");
  });
});
