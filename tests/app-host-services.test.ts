import { describe, expect, test } from "bun:test";
import type { LaunchContext, WindowState } from "../packages/apps-contracts/src/index";
import { BUILTIN_THEMES } from "../src/lib/themes";
import {
  AppHostServices,
  AppLifecycleService,
  AppMemoryStorageService,
  AppPersistentStorageService,
  AppNotificationService,
  AppThemeService,
  HostServiceError,
  MAX_NOTIFICATIONS_PER_INSTANCE,
  mapThemeTokens,
} from "../src/apps/host";

const windowState: WindowState = { focused: true, maximized: false, fullscreen: false, width: 640, height: 480 };
const themeDefinition = BUILTIN_THEMES["hiraya-dusk"].definition;

function launch(appId = "test.editor", launchId = "launch-1"): LaunchContext {
  return { protocolVersion: 1, appId, launchId, source: "launcher", files: [], folders: [], arguments: [], theme: mapThemeTokens(themeDefinition) };
}

describe("app host context", () => {
  test("binds service calls to an instance and cleans up transient work on close", async () => {
    const lifecycle = new AppLifecycleService();
    const host = new AppHostServices(lifecycle, new AppThemeService(themeDefinition));
    const context = host.openInstance({ instanceId: "one", launch: launch(), window: windowState, title: "Editor" });
    const dialog = context.dialogs.confirm({ title: "Continue?", message: "There are changes." });
    const notification = await context.notifications.show({ title: "Saved" });

    expect(host.dialogs.requests()).toHaveLength(1);
    expect(host.notifications.list()[0]?.owner).toEqual(context.owner);
    context.close();

    expect(host.dialogs.requests()).toEqual([]);
    expect(host.notifications.list()).toEqual([]);
    expect(dialog).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(context.notifications.dismiss(notification.id)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(context.dialogs.openFolder()).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(context.notifications.show({ title: "Late" })).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(context.storage.get("late")).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(context.window.getState()).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  test("publishes FIFO dialog requests for a future renderer", async () => {
    const host = new AppHostServices(new AppLifecycleService(), new AppThemeService(themeDefinition));
    const context = host.openInstance({ instanceId: "one", launch: launch(), window: windowState, title: "Editor" });
    const snapshots: string[][] = [];
    host.dialogs.subscribe((requests) => snapshots.push(requests.map(({ kind }) => kind)));

    const first = context.dialogs.openFile({ multiple: true });
    const second = context.dialogs.confirm({ title: "Open?", message: "Open selected files?" });
    const [firstRequest, secondRequest] = host.dialogs.requests();
    host.dialogs.respond(firstRequest.id, null);
    host.dialogs.respond(secondRequest.id, true);

    expect(await first).toBeNull();
    expect(await second).toBe(true);
    expect(snapshots).toEqual([[], ["openFile"], ["openFile", "confirm"], ["confirm"], []]);
  });
});

describe("app lifecycle", () => {
  test("tracks generic dirty state and honors close/save handlers", async () => {
    const closed: string[] = [];
    const service = new AppLifecycleService(100, ({ instanceId }) => { closed.push(instanceId); });
    const owner = { appId: "test.editor", instanceId: "one" };
    const api = service.open(owner, windowState, "Editor");
    let saves = 0;
    api.setDirty(true);
    api.onBeforeClose(() => false);
    api.onSave(() => { saves += 1; });

    expect(service.snapshot(owner).dirty).toBe(true);
    expect(await service.requestClose(owner)).toBe(false);
    expect(await api.requestSave()).toBe(true);
    expect(saves).toBe(1);
    api.onBeforeClose(() => true);
    expect(await service.requestClose(owner)).toBe(true);
    expect(closed).toEqual(["one"]);
    expect(api.setTitle("x".repeat(121))).rejects.toBeInstanceOf(TypeError);
  });

  test("times out handlers and rejects in-flight work when the owner closes", async () => {
    const service = new AppLifecycleService(10);
    const first = { appId: "test.editor", instanceId: "first" };
    const firstApi = service.open(first, windowState, "Editor");
    firstApi.onSave(() => new Promise(() => undefined));
    expect(firstApi.requestSave()).rejects.toMatchObject({ code: "TIMEOUT" });

    const second = { appId: "test.editor", instanceId: "second" };
    const secondApi = service.open(second, windowState, "Editor");
    secondApi.onSave(() => new Promise(() => undefined));
    const saving = secondApi.requestSave();
    service.closeInstance(second);
    expect(saving).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
});

describe("bounded app services", () => {
  test("routes persistent storage by app identity and preserves quota errors", async () => {
    const values = new Map<string, unknown>();
    const storage = new AppPersistentStorageService({
      get: async (appId, key) => values.get(`${appId}:${key}`) as never,
      set: async (appId, key, value, maxBytes) => {
        if (JSON.stringify(value).length > maxBytes) throw new Error("App storage quota exceeded.");
        values.set(`${appId}:${key}`, structuredClone(value));
      },
      remove: async (appId, key) => { values.delete(`${appId}:${key}`); },
      clear: async (appId) => { for (const key of values.keys()) if (key.startsWith(`${appId}:`)) values.delete(key); },
    }, 12);
    const first = storage.forInstance({ appId: "test.editor", instanceId: "one" });
    const second = storage.forInstance({ appId: "test.viewer", instanceId: "one" });
    await first.set("state", { ok: true });
    expect(await first.get("state")).toEqual({ ok: true });
    expect(await second.get("state")).toBeUndefined();
    expect(first.set("large", "x".repeat(20))).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    await first.clear();
    expect(await first.get("state")).toBeUndefined();
  });

  test("shares isolated app-scoped storage without leaking object references", async () => {
    const storage = new AppMemoryStorageService(80);
    const first = storage.forInstance({ appId: "test.editor", instanceId: "one" });
    const second = storage.forInstance({ appId: "test.editor", instanceId: "two" });
    const other = storage.forInstance({ appId: "test.viewer", instanceId: "one" });
    const value = { nested: [1] };
    await first.set("settings", value);
    value.nested.push(2);

    expect(await second.get("settings")).toEqual({ nested: [1] });
    expect(await other.get("settings")).toBeUndefined();
    expect(first.set("large", "x".repeat(100))).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    expect(await first.get("large")).toBeUndefined();
  });

  test("bounds notifications and enforces instance ownership", async () => {
    const service = new AppNotificationService();
    const first = service.forInstance({ appId: "test.editor", instanceId: "one" });
    const second = service.forInstance({ appId: "test.editor", instanceId: "two" });
    const { id } = await first.show({ title: "One" });
    expect(second.dismiss(id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    for (let index = 1; index < MAX_NOTIFICATIONS_PER_INSTANCE; index += 1) await first.show({ title: `Notice ${index}` });
    expect(first.show({ title: "Overflow" })).rejects.toBeInstanceOf(HostServiceError);
    expect(first.show({ title: "x".repeat(121) })).rejects.toBeInstanceOf(TypeError);
  });

  test("maps desktop definitions to stable light and dark app tokens", () => {
    expect(mapThemeTokens(BUILTIN_THEMES["hiraya-dusk"].definition)).toMatchObject({ mode: "light", focus: "#96651d" });
    expect(mapThemeTokens(BUILTIN_THEMES["midnight-glass"].definition)).toMatchObject({ mode: "dark", surface: "#17222d" });
  });
});
