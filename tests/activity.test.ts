import { describe, expect, test } from "bun:test";
import { activityRecord, parseActivityPage, parseActivityQuery } from "../src/lib/activity";
import { API_ROUTES } from "../src/lib/api-routes";

describe("activity contracts", () => {
  test("validates newest-first pages and strips unknown fields", () => {
    expect(parseActivityPage({
      activities: [
        { revision: 3, timestamp: 20, action: "move", source: "api", summary: "Renamed file", details: ["From: a.txt", "To: b.txt"], ignored: true },
        { revision: 1, timestamp: 10, action: "create", source: "api", summary: "Created file", details: ["File: a.txt"] },
      ],
      nextBefore: 1,
      ignored: true,
    })).toEqual({
      activities: [
        { revision: 3, timestamp: 20, action: "move", source: "api", summary: "Renamed file", details: ["From: a.txt", "To: b.txt"] },
        { revision: 1, timestamp: 10, action: "create", source: "api", summary: "Created file", details: ["File: a.txt"] },
      ],
      nextBefore: 1,
    });
    expect(() => parseActivityPage({ activities: [
      { revision: 1, timestamp: 1, action: "a", source: "api", summary: "A", details: [] },
      { revision: 2, timestamp: 2, action: "b", source: "api", summary: "B", details: [] },
    ], nextBefore: null })).toThrow("newest-first");
  });

  test("isolates malformed records with valid revisions", () => {
    expect(parseActivityPage({
      activities: [
        { revision: 3, timestamp: 20, action: "move", source: "api", summary: "Moved file", details: [] },
        { revision: 2, timestamp: 10, action: "update", source: "api", summary: "Broken details", details: null },
        { revision: 1, broken: true, action: "broken", source: "storage", timestamp: 0, summary: "Unreadable", details: [] },
      ],
      nextBefore: null,
    })).toEqual({
      activities: [
        { revision: 3, timestamp: 20, action: "move", source: "api", summary: "Moved file", details: [] },
        { revision: 2, broken: true },
        { revision: 1, broken: true },
      ],
      nextBefore: null,
    });
    expect(() => parseActivityPage({
      activities: [{ revision: "broken", timestamp: 10, action: "update", source: "api", summary: "Broken revision", details: [] }],
      nextBefore: null,
    })).toThrow("invalid revision");
  });

  test("normalizes queries and builds the server route", () => {
    const query = parseActivityQuery({ q: "  report final  ", before: 42, limit: 25 });
    expect(query).toEqual({ q: "report final", before: 42, limit: 25 });
    expect(API_ROUTES.activity(query)).toBe("/api/activity?q=report+final&before=42&limit=25");
    expect(() => parseActivityQuery({ limit: 0 })).toThrow("positive integer");
  });

  test("constructs bounded local records", () => {
    expect(activityRecord("Created folder", ["Folder: Plans"], 123)).toEqual({ timestamp: 123, action: "create", source: "frontend", summary: "Created folder", details: ["Folder: Plans"] });
    expect(activityRecord("Renamed file", ["From: a", "To: b"], 123).action).toBe("rename");
    expect(activityRecord("Moved desktop item", ["File: a"], 123).action).toBe("positions");
    expect(() => activityRecord("", [], 123)).toThrow("unsupported format");
  });
});
