import { isValidId } from "../lib/contracts";
import type {
  BuiltinAppDefinition,
  BuiltinAppEntryDependency,
  BuiltinAppKind,
  BuiltinAppTarget,
  BuiltinAppWindow,
  ExplorerAppTarget,
  FileAppTarget,
  PropertiesAppTarget,
  SettingsAppTarget,
} from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export const BUILTIN_APP_REGISTRY = {
  file: {
    window: { width: 920, height: 680, minWidth: 420, minHeight: 320 },
    maximizeRestoreWindow: { width: 920, height: 680, minWidth: 420, minHeight: 320 },
    extractTarget: (value) => value.kind === "file" && isValidId(value.fileId) && (value.editMode === undefined || typeof value.editMode === "boolean")
      ? { kind: "file", fileId: value.fileId, ...(value.editMode ? { editMode: true } : {}) }
      : null,
    targetId: (target) => `file:${target.fileId}`,
    entryDependency: (target) => ({ entryId: target.fileId, kind: "file" }),
  } satisfies BuiltinAppDefinition<FileAppTarget>,
  explorer: {
    window: { width: 760, height: 590, minWidth: 360, minHeight: 280 },
    maximizeRestoreWindow: { width: 720, height: 590, minWidth: 360, minHeight: 280 },
    extractTarget: (value) => value.kind === "explorer" && (value.folderId === null || isValidId(value.folderId))
      ? { kind: "explorer", folderId: value.folderId as string | null }
      : null,
    targetId: (target) => `explorer:${target.folderId ?? "root"}`,
    entryDependency: (target) => target.folderId === null ? null : { entryId: target.folderId, kind: "folder" },
  } satisfies BuiltinAppDefinition<ExplorerAppTarget>,
  properties: {
    window: { width: 520, height: 570, minWidth: 360, minHeight: 320 },
    maximizeRestoreWindow: { width: 720, height: 590, minWidth: 360, minHeight: 280 },
    extractTarget: (value) => value.kind === "properties" && isValidId(value.entryId)
      ? { kind: "properties", entryId: value.entryId }
      : null,
    targetId: (target) => `properties:${target.entryId}`,
    entryDependency: (target) => ({ entryId: target.entryId, kind: "entry" }),
  } satisfies BuiltinAppDefinition<PropertiesAppTarget>,
  settings: {
    window: { width: 720, height: 700, minWidth: 360, minHeight: 280 },
    maximizeRestoreWindow: { width: 720, height: 590, minWidth: 360, minHeight: 280 },
    extractTarget: (value) => value.kind === "settings" ? { kind: "settings" } : null,
    targetId: () => "settings",
    entryDependency: () => null,
  } satisfies BuiltinAppDefinition<SettingsAppTarget>,
} as const;

export function builtinAppWindow(kind: BuiltinAppKind): BuiltinAppWindow {
  return BUILTIN_APP_REGISTRY[kind].window;
}

export function builtinAppMaximizeRestoreWindow(kind: BuiltinAppKind): BuiltinAppWindow {
  return BUILTIN_APP_REGISTRY[kind].maximizeRestoreWindow;
}

export function extractBuiltinAppTarget(value: unknown): BuiltinAppTarget | null {
  if (!isRecord(value)) return null;
  if (value.kind === "file") return BUILTIN_APP_REGISTRY.file.extractTarget(value);
  if (value.kind === "explorer") return BUILTIN_APP_REGISTRY.explorer.extractTarget(value);
  if (value.kind === "properties") return BUILTIN_APP_REGISTRY.properties.extractTarget(value);
  if (value.kind === "settings") return BUILTIN_APP_REGISTRY.settings.extractTarget(value);
  return null;
}

export function builtinAppTargetId(target: BuiltinAppTarget): string {
  if (target.kind === "file") return BUILTIN_APP_REGISTRY.file.targetId(target);
  if (target.kind === "explorer") return BUILTIN_APP_REGISTRY.explorer.targetId(target);
  if (target.kind === "properties") return BUILTIN_APP_REGISTRY.properties.targetId(target);
  return BUILTIN_APP_REGISTRY.settings.targetId();
}

export function builtinAppEntryDependency(target: BuiltinAppTarget): BuiltinAppEntryDependency | null {
  if (target.kind === "file") return BUILTIN_APP_REGISTRY.file.entryDependency(target);
  if (target.kind === "explorer") return BUILTIN_APP_REGISTRY.explorer.entryDependency(target);
  if (target.kind === "properties") return BUILTIN_APP_REGISTRY.properties.entryDependency(target);
  return BUILTIN_APP_REGISTRY.settings.entryDependency();
}
