export type CommandId = `${string}.${string}`;

export type CommandDescriptor<Context, Id extends CommandId = CommandId> = {
  id: Id;
  label: string;
  detail?: string;
  keywords?: readonly string[];
  order?: number;
  visible?: (context: Context) => boolean;
  enabled?: (context: Context) => boolean;
  execute: (context: Context) => void | Promise<void>;
};

export type CommandItem<Id extends CommandId = CommandId> = Pick<CommandDescriptor<unknown, Id>, "id" | "label" | "detail" | "keywords"> & {
  enabled: boolean;
};

const COMMAND_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;

export class CommandService<Context, Id extends CommandId = CommandId> {
  readonly #commands = new Map<Id, CommandDescriptor<Context, Id>>();

  register(command: CommandDescriptor<Context, Id>): () => void {
    if (!COMMAND_ID_PATTERN.test(command.id)) throw new Error(`Command ID must be namespaced: ${command.id}`);
    if (this.#commands.has(command.id)) throw new Error(`Command already registered: ${command.id}`);
    this.#commands.set(command.id, command);

    return () => {
      if (this.#commands.get(command.id) === command) this.#commands.delete(command.id);
    };
  }

  list(context: Context): CommandItem<Id>[] {
    return [...this.#commands.values()]
      .filter((command) => command.visible?.(context) ?? true)
      .sort((left, right) => (left.order ?? 0) - (right.order ?? 0) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
      .map((command) => ({
        id: command.id,
        label: command.label,
        detail: command.detail,
        keywords: command.keywords,
        enabled: command.enabled?.(context) ?? true,
      }));
  }

  async execute(id: Id, context: Context): Promise<boolean> {
    const command = this.#commands.get(id);
    if (!command || !(command.visible?.(context) ?? true) || !(command.enabled?.(context) ?? true)) return false;
    await command.execute(context);
    return true;
  }
}

export const APP_COMMAND_IDS = {
  newFile: "desktop.new-file",
  newFolder: "desktop.new-folder",
  upload: "desktop.upload",
  trash: "desktop.trash",
  settings: "desktop.settings",
  windows: "desktop.windows",
  shortcuts: "desktop.shortcuts",
  sync: "desktop.sync",
} as const satisfies Record<string, CommandId>;

export type AppCommandId = typeof APP_COMMAND_IDS[keyof typeof APP_COMMAND_IDS];
export type AppCommandPanel = "trash" | "windows" | "shortcuts" | "sync";

export type AppCommandContext = {
  canMutate: boolean;
  canOpenTrash: boolean;
  canOpenSettings: boolean;
  createFile: () => void;
  createFolder: () => void;
  uploadFiles: () => void;
  openSettings: () => void;
  openPanel: (panel: AppCommandPanel) => void;
};

export function createAppCommandService(): CommandService<AppCommandContext, AppCommandId> {
  const service = new CommandService<AppCommandContext, AppCommandId>();
  const commands: CommandDescriptor<AppCommandContext, AppCommandId>[] = [
    { id: APP_COMMAND_IDS.newFile, order: 10, label: "New text file", keywords: ["create"], enabled: ({ canMutate }) => canMutate, execute: ({ createFile }) => createFile() },
    { id: APP_COMMAND_IDS.newFolder, order: 20, label: "New folder", keywords: ["create directory"], enabled: ({ canMutate }) => canMutate, execute: ({ createFolder }) => createFolder() },
    { id: APP_COMMAND_IDS.upload, order: 30, label: "Upload files", keywords: ["import add"], enabled: ({ canMutate }) => canMutate, execute: ({ uploadFiles }) => uploadFiles() },
    { id: APP_COMMAND_IDS.trash, order: 40, label: "Open Trash", keywords: ["deleted restore"], visible: ({ canOpenTrash }) => canOpenTrash, enabled: ({ canMutate }) => canMutate, execute: ({ openPanel }) => openPanel("trash") },
    { id: APP_COMMAND_IDS.settings, order: 50, label: "Open Settings", visible: ({ canOpenSettings }) => canOpenSettings, execute: ({ openSettings }) => openSettings() },
    { id: APP_COMMAND_IDS.windows, order: 60, label: "Show all windows", keywords: ["areas"], execute: ({ openPanel }) => openPanel("windows") },
    { id: APP_COMMAND_IDS.shortcuts, order: 70, label: "Show keyboard shortcuts", keywords: ["keys help"], execute: ({ openPanel }) => openPanel("shortcuts") },
    { id: APP_COMMAND_IDS.sync, order: 80, label: "Show sync status", keywords: ["offline queue issues"], execute: ({ openPanel }) => openPanel("sync") },
  ];
  for (const command of commands) service.register(command);
  return service;
}
