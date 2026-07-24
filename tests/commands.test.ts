import { describe, expect, test } from "bun:test";
import { APP_COMMAND_IDS, CommandService, RuntimeCommandContributions, createAppCommandService, runtimeCommandId, type AppCommandContext } from "../src/apps/commands";

describe("command service", () => {
  test("protects namespaced IDs and duplicate registrations", () => {
    const service = new CommandService<object>();
    const dispose = service.register({ id: "test.run", label: "Run", execute: () => undefined });
    expect(() => service.register({ id: "test.run", label: "Again", execute: () => undefined })).toThrow("Command already registered");
    expect(() => service.register({ id: "invalid" as "test.invalid", label: "Invalid", execute: () => undefined })).toThrow("must be namespaced");
    dispose();
    expect(service.list({})).toEqual([]);
    service.register({ id: "test.run", label: "Replacement", execute: () => undefined });
    expect(() => dispose()).not.toThrow();
    expect(service.list({}).map(({ label }) => label)).toEqual(["Replacement"]);
  });

  test("lists visible commands deterministically and resolves enabled state", () => {
    const service = new CommandService<{ allowed: boolean }>();
    service.register({ id: "test.second", order: 20, label: "Second", execute: () => undefined });
    service.register({ id: "test.hidden", order: 5, label: "Hidden", visible: ({ allowed }) => allowed, execute: () => undefined });
    service.register({ id: "test.disabled", order: 10, label: "Disabled", enabled: ({ allowed }) => allowed, execute: () => undefined });
    service.register({ id: "test.first", order: 10, label: "First", execute: () => undefined });

    expect(service.list({ allowed: false }).map(({ id, enabled }) => [id, enabled])).toEqual([
      ["test.disabled", false],
      ["test.first", true],
      ["test.second", true],
    ]);
    expect(service.list({ allowed: true }).map(({ id }) => id)).toEqual(["test.hidden", "test.disabled", "test.first", "test.second"]);
  });

  test("rechecks visibility and enabled predicates when executing", async () => {
    const calls: string[] = [];
    const service = new CommandService<{ allowed: boolean }>();
    service.register({ id: "test.run", label: "Run", visible: ({ allowed }) => allowed, enabled: ({ allowed }) => allowed, execute: () => { calls.push("run"); } });

    expect(service.list({ allowed: true })).toHaveLength(1);
    expect(await service.execute("test.run", { allowed: false })).toBe(false);
    expect(await service.execute("test.missing", { allowed: true })).toBe(false);
    expect(calls).toEqual([]);
    expect(await service.execute("test.run", { allowed: true })).toBe(true);
    expect(calls).toEqual(["run"]);
  });
});

describe("app command contributions", () => {
  test("namespaces runtime commands, emits local IDs, and disposes replacements", async () => {
    const service = new CommandService<object>();
    const invoked: string[] = [];
    const contributions = new RuntimeCommandContributions(service, "test.editor", (id) => invoked.push(id));
    contributions.set([{ id: "format-document", title: "Format" }]);
    expect(service.list({}).map(({ id }) => id)).toEqual([runtimeCommandId("test.editor", "format-document")]);
    expect(await service.execute(runtimeCommandId("test.editor", "format-document"), {})).toBe(true);
    expect(invoked).toEqual(["format-document"]);
    contributions.set([{ id: "save-all", title: "Save all", enabled: false }]);
    expect(service.list({}).map(({ id, enabled }) => [id, enabled])).toEqual([[runtimeCommandId("test.editor", "save-all"), false]]);
    contributions.close();
    expect(service.list({})).toEqual([]);
  });

  test("preserves palette order, visibility, and mutation permissions", async () => {
    const calls: string[] = [];
    const context: AppCommandContext = {
      canMutate: false,
      canOpenTrash: true,
      canOpenSettings: false,
      createFile: () => calls.push("file"),
      createFolder: () => calls.push("folder"),
      uploadFiles: () => calls.push("upload"),
      openSettings: () => calls.push("settings"),
      openPanel: (panel) => calls.push(panel),
    };
    const service = createAppCommandService();

    expect(service.list(context).map(({ id }) => id)).toEqual([
      APP_COMMAND_IDS.newFile,
      APP_COMMAND_IDS.newFolder,
      APP_COMMAND_IDS.upload,
      APP_COMMAND_IDS.trash,
      APP_COMMAND_IDS.windows,
      APP_COMMAND_IDS.shortcuts,
      APP_COMMAND_IDS.sync,
    ]);
    expect(await service.execute(APP_COMMAND_IDS.newFile, context)).toBe(false);
    expect(await service.execute(APP_COMMAND_IDS.trash, context)).toBe(false);
    expect(calls).toEqual([]);

    context.canMutate = true;
    expect(await service.execute(APP_COMMAND_IDS.newFile, context)).toBe(true);
    expect(await service.execute(APP_COMMAND_IDS.trash, context)).toBe(true);
    expect(calls).toEqual(["file", "trash"]);
  });
});
