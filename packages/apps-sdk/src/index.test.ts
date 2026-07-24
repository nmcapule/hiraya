import { describe, expect, test } from "bun:test";
import { connectHiraya, HirayaSdkError, type FileHandle } from "./index";

describe("apps SDK", () => {
  test("dispatches typed requests and remote errors", async () => {
    const channel = new MessageChannel();
    channel.port2.onmessage = ({ data }) => {
      const result = data.method === "storage.get" ? "value" : undefined;
      channel.port2.postMessage({ protocolVersion: 1, type: "response", id: data.id, ok: true, result });
    };
    const client = connectHiraya({ port: channel.port1 });
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
    const deniedClient = connectHiraya({ port: deniedChannel.port1 });
    await expect(deniedClient.theme.get()).rejects.toEqual(expect.objectContaining({ name: "HirayaSdkError", code: "PERMISSION_DENIED" }));
    deniedClient.close();
    deniedChannel.port2.close();
  });

  test("exposes launch, revision-safe write, and dirty window requests", async () => {
    const channel = new MessageChannel();
    const requests: unknown[] = [];
    channel.port2.onmessage = ({ data }) => {
      requests.push(data);
      channel.port2.postMessage({ protocolVersion: 1, type: "response", id: data.id, ok: true, result: data.method === "app.getLaunchContext" ? { source: "launcher" } : undefined });
    };
    const client = connectHiraya({ port: channel.port1 });
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
    const client = connectHiraya({ port: channel.port1 });
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
    const client = connectHiraya({ port: channel.port1, requestTimeoutMs: 10 });
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
