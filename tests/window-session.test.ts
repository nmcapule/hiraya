import { describe, expect, test } from "bun:test";
import type { DesktopEntry } from "../src/types";
import { parseWindowSession, parseWindowTargets, restoreWindowSession } from "../src/lib/window-session";

const entries: DesktopEntry[] = [
  { id: "folder", name: "Folder", kind: "folder", parentId: null, modifiedAt: 1, position: { x: 0, y: 0 } },
  { id: "file", name: "File.txt", kind: "file", parentId: "folder", modifiedAt: 1, position: { x: 0, y: 0 }, mimeType: "text/plain", size: 1 },
];

describe("window sessions", () => {
  test("parses version 2 sessions with finite logical geometry", () => {
    const session = {
      version: 2,
      apps: [
        { kind: "settings", bounds: { x: -1599, y: 602, width: 500, height: 400 }, minimized: false, zIndex: 3 },
        { kind: "explorer", folderId: null, bounds: { x: 802, y: -597, width: 500, height: 400 }, minimized: true, zIndex: 1 },
        { kind: "file", fileId: "file", bounds: { x: 3, y: 4, width: 500, height: 400 }, minimized: false, zIndex: 2 },
      ],
    };
    expect(parseWindowSession(session)).toEqual(session);
    expect(() => parseWindowSession({ version: 2, apps: [{ ...session.apps[0], bounds: { ...session.apps[0].bounds, x: Number.POSITIVE_INFINITY } }] })).toThrow("invalid bounds");
  });

  test("rejects duplicate targets in persisted sessions", () => {
    const app = { kind: "settings", bounds: { x: 0, y: 0, width: 500, height: 400 }, minimized: false, zIndex: 1 };
    expect(() => parseWindowSession({ version: 1, apps: [app, app] })).toThrow("duplicate apps");
    expect(() => parseWindowSession({ version: 2, apps: [app, app] })).toThrow("duplicate apps");
  });

  test("migrates version 1 local bounds from a signed active segment", () => {
    const restored = restoreWindowSession(parseWindowSession({
      version: 1,
      apps: [
        { kind: "file", fileId: "file", bounds: { x: -20, y: 900, width: 100, height: 100 }, minimized: true, zIndex: 8 },
        { kind: "explorer", folderId: "folder", bounds: { x: 10, y: 20, width: 500, height: 400 }, minimized: false, zIndex: 3 },
      ],
    }), entries, { column: -2, row: 1 }, { width: 800, height: 600 });

    expect(restored).toEqual([
      { kind: "explorer", folderId: "folder", bounds: { x: -1590, y: 620, width: 500, height: 400 }, minimized: false, zIndex: 1 },
      { kind: "file", fileId: "file", bounds: { x: -1600, y: 880, width: 420, height: 320 }, minimized: true, zIndex: 2 },
    ]);
  });

  test("filters stale targets and clamps version 2 bounds within their logical tiles", () => {
    const restored = restoreWindowSession(parseWindowSession({
      version: 2,
      apps: [
        { kind: "file", fileId: "missing", bounds: { x: 0, y: 0, width: 500, height: 400 }, minimized: false, zIndex: 1 },
        { kind: "file", fileId: "file", bounds: { x: -810, y: 1250, width: 100, height: 100 }, minimized: true, zIndex: 8 },
        { kind: "explorer", folderId: "folder", bounds: { x: 810, y: -580, width: 500, height: 400 }, minimized: false, zIndex: 3 },
      ],
    }), entries, { column: 9, row: 9 }, { width: 800, height: 600 });

    expect(restored).toEqual([
      { kind: "explorer", folderId: "folder", bounds: { x: 810, y: -580, width: 500, height: 400 }, minimized: false, zIndex: 1 },
      { kind: "file", fileId: "file", bounds: { x: -1220, y: 1250, width: 420, height: 320 }, minimized: true, zIndex: 2 },
    ]);
  });

  test("validates route history app targets", () => {
    const targets = [
      { kind: "explorer", folderId: null },
      { kind: "file", fileId: "file" },
      { kind: "settings" },
    ];
    expect(parseWindowTargets(targets)).toEqual(targets);
    expect(() => parseWindowTargets([...targets, { kind: "file", fileId: "file" }])).toThrow("duplicate apps");
    expect(() => parseWindowTargets([{ kind: "file", fileId: "" }])).toThrow("invalid app");
    expect(() => parseWindowTargets(Array.from({ length: 101 }, () => ({ kind: "settings" })))).toThrow("unsupported app list");
  });

  test("preserves explicit text editor mode", () => {
    expect(parseWindowTargets([{ kind: "file", fileId: "file", editMode: true }])).toEqual([{ kind: "file", fileId: "file", editMode: true }]);
    expect(parseWindowSession({
      version: 3,
      apps: [{ kind: "file", fileId: "file", editMode: true, bounds: { x: 0, y: 0, width: 500, height: 400 }, minimized: false, zIndex: 1 }],
    }).apps[0]).toMatchObject({ kind: "file", fileId: "file", editMode: true });
  });
});
