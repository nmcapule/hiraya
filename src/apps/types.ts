export type BuiltinAppKind = "file" | "explorer" | "properties" | "settings";

export type FileAppTarget = { kind: "file"; fileId: string; editMode?: boolean };
export type ExplorerAppTarget = { kind: "explorer"; folderId: string | null };
export type PropertiesAppTarget = { kind: "properties"; entryId: string };
export type SettingsAppTarget = { kind: "settings" };

export type BuiltinAppTarget = FileAppTarget | ExplorerAppTarget | PropertiesAppTarget | SettingsAppTarget;

export type BuiltinAppWindow = {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
};

export type BuiltinAppEntryDependency = {
  entryId: string;
  kind: "entry" | "file" | "folder";
};

export type BuiltinAppDefinition<TTarget extends BuiltinAppTarget> = {
  window: BuiltinAppWindow;
  maximizeRestoreWindow: BuiltinAppWindow;
  extractTarget: (value: Record<string, unknown>) => TTarget | null;
  targetId: (target: TTarget) => string;
  entryDependency: (target: TTarget) => BuiltinAppEntryDependency | null;
};
