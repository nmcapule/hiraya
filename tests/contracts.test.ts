import { describe, expect, test } from "bun:test";
import { isValidId, parseRemoteWorkspace } from "../src/lib/contracts";
import { namesMatch, validateEntryName } from "../src/lib/entry-validation";
import { remoteWorkspace } from "./fixtures";

describe("workspace contracts", () => {
  test("parses a complete server workspace without retaining unknown fields", () => {
    const input = remoteWorkspace();
    const parsed = parseRemoteWorkspace({ ...input, ignored: true });
    expect(parsed).toEqual(input);
    expect("ignored" in parsed).toBe(false);
  });

  test("rejects malformed remote revisions and hierarchy", () => {
    expect(() => parseRemoteWorkspace({ ...remoteWorkspace(), revision: 1.5 })).toThrow("revision");
    const input = remoteWorkspace();
    input.entries[0].viewId = "missing";
    expect(() => parseRemoteWorkspace(input)).toThrow("missing view");
  });

  test("accepts the intentionally empty shape of an uninitialized server", () => {
    expect(parseRemoteWorkspace({
      schemaVersion: 1,
      workspaceId: "workspace-1",
      initialized: false,
      revision: 0,
      entries: [],
      layout: { views: [], columns: 0, snapToGrid: false, wallpaper: "dusk" },
      layoutRevision: 0,
      editorSettings: { autoSave: true, fontSize: 13, language: "auto" },
      settingsRevision: 0,
    })).toEqual({ schemaVersion: 1, workspaceId: "workspace-1", initialized: false, revision: 0 });
  });

  test("uses deterministic Go-aligned ID and sibling-name rules", () => {
    expect(isValidId("entry-1")).toBe(true);
    expect(isValidId(`bad${String.fromCharCode(127)}`)).toBe(false);
    expect(isValidId("é".repeat(91))).toBe(false);
    expect(namesMatch("Report.TXT", "report.txt")).toBe(true);
    expect(validateEntryName("  report.txt  ")).toBe("report.txt");
    expect(() => validateEntryName(`bad${String.fromCharCode(127)}`)).toThrow();
  });
});
