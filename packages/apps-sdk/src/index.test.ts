import { describe, expect, test } from "bun:test";
import { connectHiraya, HirayaSdkError, type FileHandle } from "./index";

describe("apps SDK", () => {
  test("waits for one exact parent init and ignores hostile frames", async () => {
    const listeners = new Set<(event: MessageEvent<unknown>) => void>();
    const connectMessages: unknown[] = [];
    const parent = { postMessage: (message: unknown) => connectMessages.push(message) };
    const fakeWindow = {
      parent,
      addEventListener: (_type: string, listener: (event: MessageEvent<unknown>) => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: (event: MessageEvent<unknown>) => void) => listeners.delete(listener),
    };
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", { configurable: true, value: fakeWindow });
    const hostile = new MessageChannel();
    const channel = new MessageChannel();
    try {
      const connecting = connectHiraya({ appId: "dev.hiraya.test", handshakeTimeoutMs: 100 });
      expect(connectMessages).toEqual([{ protocolVersion: 1, type: "hiraya:connect", appId: "dev.hiraya.test" }]);
      for (const listener of listeners) listener({ source: {}, data: { protocolVersion: 1, type: "hiraya:init", appId: "dev.hiraya.test", nonce: "0123456789abcdef" }, ports: [hostile.port1] } as unknown as MessageEvent<unknown>);
      expect(listeners.size).toBe(1);
      const ready = new Promise<unknown>((resolve) => { channel.port2.onmessage = ({ data }) => resolve(data); });
      for (const listener of listeners) listener({ source: parent, data: { protocolVersion: 1, type: "hiraya:init", appId: "dev.hiraya.test", nonce: "0123456789abcdef" }, ports: [channel.port1] } as unknown as MessageEvent<unknown>);
      const client = await connecting;
      expect(await ready).toEqual({ protocolVersion: 1, type: "hiraya:ready", appId: "dev.hiraya.test", nonce: "0123456789abcdef" });
      expect(listeners.size).toBe(0);
      client.close();
    } finally {
      hostile.port1.close(); hostile.port2.close(); channel.port2.close();
      if (descriptor) Object.defineProperty(globalThis, "window", descriptor); else delete (globalThis as { window?: unknown }).window;
    }
  });

  test("dispatches typed requests and remote errors", async () => {
    const channel = new MessageChannel();
    channel.port2.onmessage = ({ data }) => {
      const result = data.method === "storage.get" ? "value" : undefined;
      channel.port2.postMessage({ protocolVersion: 1, type: "response", id: data.id, ok: true, result });
    };
    const client = await connectHiraya({ port: channel.port1 });
    expect(await client.storage.get("key")).toBe("value");
    client.close();
    channel.port2.close();

    const deniedChannel = new MessageChannel();
    deniedChannel.port2.onmessage = ({ data }) => deniedChannel.port2.postMessage({
      protocolVersion: 1,
      type: "response",
      id: data.id,
      ok: false,
      error: { code: "PERMISSION_DENIED", message: "Denied" },
    });
    const deniedClient = await connectHiraya({ port: deniedChannel.port1 });
    await expect(deniedClient.theme.get()).rejects.toEqual(expect.objectContaining({ name: "HirayaSdkError", code: "PERMISSION_DENIED" }));
    deniedClient.close();
    deniedChannel.port2.close();
  });

  test("exposes launch, revision-safe write, and dirty window requests", async () => {
    const channel = new MessageChannel();
    const requests: unknown[] = [];
    channel.port2.onmessage = ({ data }) => {
      requests.push(data);
      channel.port2.postMessage({ protocolVersion: 1, type: "response", id: data.id, ok: true, result: data.method === "app.getLaunchContext" ? {
        protocolVersion: 1, appId: "dev.hiraya.test", launchId: "launch-1", source: "launcher", files: [], folders: [], arguments: [],
        theme: { mode: "dark", background: "#000", surface: "#111", surfaceElevated: "#222", text: "#fff", textMuted: "#aaa", border: "#333", accent: "#fc0", accentText: "#000", danger: "#f00", focus: "#ff0" },
      } : data.method === "files.write" ? { handle: data.params.handle, name: "test.txt", mimeType: "text/plain", size: 0, modifiedAt: 1, parent: null, contentRevision: 8 } : undefined });
    };
    const client = await connectHiraya({ port: channel.port1 });
    await client.app.getLaunchContext();
    await client.files.write("file_0123456789abcdef" as FileHandle, new ArrayBuffer(0), { expectedRevision: 7, mimeType: "text/plain" });
    await client.window.setDirty(true);
    expect(requests).toEqual([
      expect.objectContaining({ method: "app.getLaunchContext", params: {} }),
      expect.objectContaining({ method: "files.write", params: expect.objectContaining({ expectedRevision: 7, mimeType: "text/plain" }) }),
      expect.objectContaining({ method: "window.setDirty", params: { dirty: true } }),
    ]);
    client.close();
    channel.port2.close();
  });

  test("supports event unsubscribe", async () => {
    const channel = new MessageChannel();
    const client = await connectHiraya({ port: channel.port1 });
    const received: string[] = [];
    const unsubscribe = client.on("commands.invoked", ({ id }) => received.push(id));
    channel.port2.postMessage({ protocolVersion: 1, type: "event", event: "commands.invoked", payload: { id: "save" } });
    await Bun.sleep(0);
    unsubscribe();
    channel.port2.postMessage({ protocolVersion: 1, type: "event", event: "commands.invoked", payload: { id: "open" } });
    await Bun.sleep(0);
    expect(received).toEqual(["save"]);
    client.close();
    channel.port2.close();
  });

  test("rejects requests on abort, timeout, and close", async () => {
    const channel = new MessageChannel();
    const client = await connectHiraya({ port: channel.port1, requestTimeoutMs: 10 });
    const controller = new AbortController();
    const aborted = client.storage.get("key", { signal: controller.signal });
    controller.abort();
    await expect(aborted).rejects.toEqual(expect.objectContaining({ code: "CANCELLED" }));
    await expect(client.storage.get("key")).rejects.toEqual(expect.objectContaining({ code: "TIMEOUT" }));
    const pending = client.storage.get("key", { timeoutMs: 1_000 });
    client.close();
    await expect(pending).rejects.toBeInstanceOf(HirayaSdkError);
    await expect(client.storage.get("key")).rejects.toEqual(expect.objectContaining({ code: "UNAVAILABLE" }));
    channel.port2.close();
  });
});
