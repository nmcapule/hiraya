import { describe, expect, test } from "bun:test";
import { RpcDispatcher } from "./dispatcher";
import { initializeSandboxFrame, isAppPackageName, ObjectUrlLease } from "./sandbox";

function host() {
  let closed = false;
  return {
    value: {
      app: { getLaunchContext: async () => ({ protocolVersion: 1, appId: "dev.hiraya.test", launchId: "launch-1", source: "launcher", files: [], folders: [], arguments: [], theme: { mode: "dark", background: "#000", surface: "#111", surfaceElevated: "#222", text: "#fff", textMuted: "#aaa", border: "#333", accent: "#fc0", accentText: "#000", danger: "#f00", focus: "#ff0" } }) },
      storage: { get: async () => "stored" },
      close: () => { closed = true; },
    },
    closed: () => closed,
  };
}

const files = new Proxy({}, { get: () => async () => undefined }) as never;

describe("app runtime", () => {
  test("creates the channel only after the launched frame requests a connection", async () => {
    const listeners = new Set<(event: MessageEvent<unknown>) => void>();
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const service = host();
    const dispatcher = new RpcDispatcher({ permissions: [], host: service.value, files });
    let appPort: MessagePort | undefined;
    let init: { appId: string; nonce: string } | undefined;
    const child = {
      postMessage: (message: { appId: string; nonce: string }, _origin: string, ports: MessagePort[]) => {
        init = message;
        appPort = ports[0];
      },
    };
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      addEventListener: (_type: string, listener: (event: MessageEvent<unknown>) => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: (event: MessageEvent<unknown>) => void) => listeners.delete(listener),
    } });
    try {
      const dispose = initializeSandboxFrame({ contentWindow: child } as unknown as HTMLIFrameElement, "dev.hiraya.test", dispatcher);
      expect(appPort).toBeUndefined();
      for (const listener of listeners) listener({ source: {}, data: { protocolVersion: 1, type: "hiraya:connect", appId: "dev.hiraya.test" } } as unknown as MessageEvent<unknown>);
      expect(appPort).toBeUndefined();
      for (const listener of listeners) listener({ source: child, data: { protocolVersion: 1, type: "hiraya:connect", appId: "dev.hiraya.test" } } as unknown as MessageEvent<unknown>);
      expect(init?.appId).toBe("dev.hiraya.test");
      appPort!.postMessage({ protocolVersion: 1, type: "hiraya:ready", appId: init!.appId, nonce: init!.nonce });
      await Bun.sleep(0);
      const response = new Promise<unknown>((resolve) => { appPort!.onmessage = ({ data }) => resolve(data); });
      appPort!.postMessage({ protocolVersion: 1, type: "request", id: "launch", method: "app.getLaunchContext", params: {} });
      expect(await response).toEqual(expect.objectContaining({ id: "launch", ok: true }));
      dispose();
      expect(listeners.size).toBe(0);
    } finally {
      appPort?.close();
      dispatcher.dispose();
      if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else delete (globalThis as { window?: unknown }).window;
    }
  });

  test("validates requests, applies permissions, and disposes", async () => {
    const service = host();
    const dispatcher = new RpcDispatcher({ permissions: [], host: service.value, files });
    const channel = new MessageChannel();
    const responses: unknown[] = [];
    channel.port2.onmessage = ({ data }) => responses.push(data);
    dispatcher.attach(channel.port1);
    channel.port2.postMessage({ protocolVersion: 1, type: "request", id: "launch", method: "app.getLaunchContext", params: {} });
    channel.port2.postMessage({ protocolVersion: 1, type: "request", id: "storage", method: "storage.get", params: { key: "x" } });
    channel.port2.postMessage({ protocolVersion: 1, type: "request", id: "invalid", method: "window.setDirty", params: { dirty: "yes" } });
    await Bun.sleep(10);
    expect(responses).toContainEqual(expect.objectContaining({ id: "launch", ok: true }));
    expect(responses).toContainEqual(expect.objectContaining({ id: "storage", ok: false, error: expect.objectContaining({ code: "PERMISSION_DENIED" }) }));
    expect(responses).toContainEqual(expect.objectContaining({ id: "invalid", ok: false, error: expect.objectContaining({ code: "INVALID_REQUEST" }) }));
    dispatcher.dispose();
    expect(service.closed()).toBe(true);
    channel.port2.close();
  });

  test("revokes every package URL exactly once", () => {
    const revoked: string[] = [];
    let id = 0;
    const lease = new ObjectUrlLease({ createObjectURL: () => `blob:${++id}`, revokeObjectURL: (url) => revoked.push(url) });
    lease.create(new Blob(["a"]));
    lease.create(new Blob(["b"]));
    lease.revoke();
    lease.revoke();
    expect(revoked).toEqual(["blob:1", "blob:2"]);
    expect(() => lease.create(new Blob())).toThrow("closed");
  });

  test("recognizes only the exact package extension", () => {
    expect(isAppPackageName("Hello.HIRAYA.APP")).toBe(true);
    expect(isAppPackageName("index.html")).toBe(false);
    expect(isAppPackageName("fake.hiraya.app.txt")).toBe(false);
  });
});
