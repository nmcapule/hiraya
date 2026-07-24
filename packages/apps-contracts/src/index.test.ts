import { describe, expect, test } from "bun:test";
import {
  parseFileHandle,
  parseLaunchContext,
  parseManifestV1,
  parseRpcResponse,
  parseThemeTokens,
} from "./index";

const theme = {
  mode: "dark",
  background: "#10201c",
  surface: "#172a25",
  surfaceElevated: "#20352f",
  text: "#f4efe2",
  textMuted: "#b8b4a8",
  border: "#43554e",
  accent: "#d99b43",
  accentText: "#17120b",
  danger: "#d66b62",
  focus: "#f1bd69",
} as const;

describe("apps contracts", () => {
  test("strictly parses manifest v1", () => {
    const manifest = {
      schemaVersion: 1,
      id: "dev.hiraya.notes",
      name: "Notes",
      version: "1.2.0",
      entrypoint: "dist/index.html",
      permissions: ["files:read", "storage"],
    };
    expect(parseManifestV1(manifest)).toEqual(manifest);
    expect(() => parseManifestV1({ ...manifest, extra: true })).toThrow("unsupported shape");
    expect(() => parseManifestV1({ ...manifest, permissions: ["files:read", "files:read"] })).toThrow("duplicates");
    expect(() => parseManifestV1({ ...manifest, entrypoint: "../index.html" })).toThrow("entrypoint");
  });

  test("brands only opaque typed handles", () => {
    expect(parseFileHandle("file_0123456789abcdef")).toBe("file_0123456789abcdef");
    expect(() => parseFileHandle("folder_0123456789abcdef")).toThrow("File handle");
    expect(() => parseFileHandle("file/project/readme")).toThrow("File handle");
  });

  test("strictly parses launch and theme contracts", () => {
    const context = {
      protocolVersion: 1,
      appId: "dev.hiraya.notes",
      launchId: "launch-1",
      source: "file",
      files: ["file_0123456789abcdef"],
      folders: ["folder_0123456789abcdef"],
      arguments: ["readonly"],
      theme,
    };
    expect(parseLaunchContext(context)).toEqual(context);
    expect(() => parseThemeTokens({ ...theme, unknown: "#fff" })).toThrow("unsupported shape");
  });

  test("rejects loose RPC responses and errors", () => {
    const response = { protocolVersion: 1, type: "response", id: "r1", ok: false, error: { code: "NOT_FOUND", message: "Missing" } };
    expect(parseRpcResponse(response)).toEqual(response);
    expect(() => parseRpcResponse({ ...response, result: null })).toThrow("unsupported shape");
    expect(() => parseRpcResponse({ ...response, error: { code: "NOPE", message: "Missing" } })).toThrow("code");
  });
});
