import { describe, expect, test } from "bun:test";
import { formatEditorText } from "../src/lib/format-text";

describe("editor formatting", () => {
  test("formats supported web languages", async () => {
    expect(await formatEditorText('{"answer":42}', "json")).toBe('{ "answer": 42 }\n');
    expect(await formatEditorText("# Heading\n\n- one\n- two", "markdown")).toBe("# Heading\n\n- one\n- two\n");
  });

  test("leaves unsupported text unchanged", async () => {
    expect(await formatEditorText("[InternetShortcut]\nURL=https://example.com", "plain")).toBe("[InternetShortcut]\nURL=https://example.com");
  });

  test("rejects invalid supported input instead of rewriting it", async () => {
    await expect(formatEditorText("{", "json")).rejects.toBeDefined();
  });
});
