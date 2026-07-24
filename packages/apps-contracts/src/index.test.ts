import { describe, expect, test } from "bun:test";
import {
  parseFileHandle,
  parseLaunchContext,
  parseManifestV1,
  parseRpcEvent,
  parseRpcRequest,
  parseRpcResponse,
  parseServiceResult,
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

  test("strictly validates method params, results, and event payloads", () => {
    expect(parseRpcRequest({ protocolVersion: 1, type: "request", id: "r1", method: "window.setDirty", params: { dirty: true } })).toEqual(expect.objectContaining({ params: { dirty: true } }));
    expect(() => parseRpcRequest({ protocolVersion: 1, type: "request", id: "r1", method: "window.setDirty", params: { dirty: "true" } })).toThrow("dirty");
    expect(() => parseRpcRequest({ protocolVersion: 1, type: "request", id: "r1", method: "storage.get", params: { key: "x", extra: true } })).toThrow("unsupported shape");
    expect(parseServiceResult("dialogs.confirm", true)).toBe(true);
    expect(() => parseServiceResult("dialogs.confirm", "yes")).toThrow("Confirmation");
    expect(parseRpcEvent({ protocolVersion: 1, type: "event", event: "commands.invoked", payload: { id: "save" } })).toEqual(expect.objectContaining({ payload: { id: "save" } }));
    expect(() => parseRpcEvent({ protocolVersion: 1, type: "event", event: "commands.invoked", payload: { id: 1 } })).toThrow("ID");
  });
});
