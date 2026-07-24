import { describe, expect, test } from "bun:test";
import { HELP_SECTIONS, guideMarkdown, validateGuideLinks } from "../src/lib/help";

const headingIds = new Set(Array.from(guideMarkdown.matchAll(/^#{1,6}\s+.+?\s+\{#([a-z][a-z0-9-]*)\}\s*$/gm), (match) => match[1]));

describe("bundled user guide", () => {
  test("imports the checked-in Markdown and exposes stable section metadata", () => {
    expect(guideMarkdown.startsWith("# Hiraya User Guide")).toBe(true);
    expect(HELP_SECTIONS.map((section) => section.id)).toEqual([
      "start-here",
      "files-and-folders",
      "desktops-and-areas",
      "sharing",
      "offline",
      "installation-and-updates",
      "apps-and-permissions",
      "export-backup-and-recovery",
      "troubleshooting",
    ]);
    for (const section of HELP_SECTIONS) expect(headingIds.has(section.id)).toBe(true);
  });

  test("allows only known internal fragment links", () => {
    expect(validateGuideLinks(guideMarkdown, headingIds)).toEqual(["#desktops-and-areas"]);
    for (const unsafe of [
      "[file](guide.md)",
      "[file](file:///tmp/guide.md)",
      "[network](//example.test/help)",
      "[data](data:text/plain,help)",
      "[script](javascript:alert(1))",
      "[protocol](https://example.test/help)",
      "[unknown](#missing)",
      "[malformed](#bad%fragment)",
      "![asset](asset.png)",
      "[reference][help]\n\n[help]: #start-here",
      "<https://example.test/help>",
    ]) expect(() => validateGuideLinks(unsafe, headingIds)).toThrow();
  });

  test("covers the required user and troubleshooting topics", () => {
    const required = [
      "server is the authoritative",
      "Import folder",
      "named workspace",
      "derived from item and window coordinates",
      "Manager",
      "public link",
      "clearing site data",
      "Shared desktops have stricter offline rules",
      "Install Hiraya",
      "Automatic updates",
      ".hiraya.app",
      "requested permissions",
      "Hiraya does not provide an in-product import or restore path",
      "Full synchronized recovery requires a server operator",
      "docs/BACKUP_AND_RECOVERY.md",
      "Sync blocked",
      "Offline file unavailable",
      "Browser storage full",
      "Permission denied",
      "Folder import unsupported",
      "Installation unavailable",
    ];
    for (const phrase of required) expect(guideMarkdown).toContain(phrase);
  });

  test("does not depend on external assets, scripts, or fonts", () => {
    expect(guideMarkdown).not.toMatch(/!\[[^\]]*\]\(/i);
    expect(guideMarkdown).not.toMatch(/<\s*(?:script|link|iframe)\b/i);
    expect(guideMarkdown).not.toMatch(/https?:\/\//i);
  });
});
