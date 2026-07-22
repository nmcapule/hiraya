import { describe, expect, test } from "bun:test";
import {
  parseInternetShortcut,
  parseShortcutUrl,
} from "../src/lib/internet-shortcut";
import { fileCapabilities } from "../src/ui/file-capabilities";

describe("internet shortcuts", () => {
  test("parses BOM, case-insensitive sections, CRLF, and equals signs", () => {
    const shortcut = parseInternetShortcut("\uFEFF[internetshortcut]\r\nurl=https://example.com/search?q=a=b\r\n");
    expect(shortcut).toEqual({ url: "https://example.com/search?q=a=b", scheme: "https", sensitive: false });
  });

  test("ignores URL settings outside the InternetShortcut section", () => {
    const content = "[Other]\nURL=https://wrong.example\n[InternetShortcut]\nURL=mailto:user@example.com\n";
    expect(parseInternetShortcut(content).url).toBe("mailto:user@example.com");
  });

  test("accepts custom schemes and marks executable or local schemes sensitive", () => {
    expect(parseShortcutUrl("steam://run/123")).toMatchObject({ scheme: "steam", sensitive: false });
    for (const url of ["javascript:alert(1)", "data:text/plain,hello", "blob:https://example.com/id", "file:///tmp/file.txt"]) {
      expect(parseShortcutUrl(url).sensitive).toBe(true);
    }
  });

  test("rejects missing, relative, and malformed URLs", () => {
    expect(() => parseInternetShortcut("[InternetShortcut]\nURL=\n")).toThrow("complete URL");
    expect(() => parseShortcutUrl("example.com")).toThrow("complete URL");
    expect(() => parseShortcutUrl("https://exa mple.com")).toThrow("valid URL");
  });

  test("recognizes URL shortcuts without relying on their MIME type", () => {
    const capabilities = fileCapabilities({
      kind: "file",
      id: "shortcut",
      name: "Website.URL",
      parentId: null,
      mimeType: "application/octet-stream",
      size: 0,
      modifiedAt: 1,
      position: { x: 0, y: 0 },
    });
    expect(capabilities).toEqual({ editable: true, preview: "url", icon: "url" });
  });

  test("renders Markdown by default while keeping it text-editable", () => {
    for (const [name, mimeType] of [["README.md", "application/octet-stream"], ["README.markdown", "text/plain"], ["README", "text/markdown; charset=utf-8"]]) {
      expect(fileCapabilities({
        kind: "file",
        id: name,
        name,
        parentId: null,
        mimeType,
        size: 0,
        modifiedAt: 1,
        position: { x: 0, y: 0 },
      }).preview).toBe("markdown");
    }
  });
});
