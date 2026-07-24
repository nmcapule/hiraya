export const APPS_PROTOCOL_VERSION = 1 as const;

const APP_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const HANDLE = /^(file|folder)_[A-Za-z0-9_-]{16,256}$/;
const SAFE_PATH_SEGMENT = /^(?!\.\.?$)[^/\\]+$/;

export const APP_PERMISSIONS = [
  "files:read",
  "files:write",
  "dialogs",
  "window",
  "commands",
  "notifications",
  "theme",
  "storage",
] as const;

export type AppPermission = (typeof APP_PERMISSIONS)[number];
export type FileHandle = string & { readonly __fileHandle: unique symbol };
export type FolderHandle = string & { readonly __folderHandle: unique symbol };

export interface HirayaAppManifestV1 {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  entrypoint: string;
  description?: string;
  icon?: string;
  permissions: AppPermission[];
  fileTypes?: string[];
}

export interface ThemeTokens {
  mode: "light" | "dark";
  background: string;
  surface: string;
  surfaceElevated: string;
  text: string;
  textMuted: string;
  border: string;
  accent: string;
  accentText: string;
  danger: string;
  focus: string;
}

export interface LaunchContext {
  protocolVersion: 1;
  appId: string;
  launchId: string;
  source: "launcher" | "file" | "command" | "restore";
  files: FileHandle[];
  folders: FolderHandle[];
  arguments: string[];
  theme: ThemeTokens;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface HirayaErrorData {
  code: HirayaErrorCode;
  message: string;
  details?: JsonValue;
}

export const HIRAYA_ERROR_CODES = [
  "INVALID_REQUEST",
  "METHOD_NOT_FOUND",
  "PERMISSION_DENIED",
  "NOT_FOUND",
  "ALREADY_EXISTS",
  "CONFLICT",
  "CANCELLED",
  "OFFLINE",
  "QUOTA_EXCEEDED",
  "TIMEOUT",
  "UNAVAILABLE",
  "INTERNAL",
] as const;

export type HirayaErrorCode = (typeof HIRAYA_ERROR_CODES)[number];

export interface RpcRequest<M extends ServiceMethod = ServiceMethod> {
  protocolVersion: 1;
  type: "request";
  id: string;
  method: M;
  params: ServiceMethods[M]["params"];
}

export type RpcResponse =
  | { protocolVersion: 1; type: "response"; id: string; ok: true; result: unknown }
  | { protocolVersion: 1; type: "response"; id: string; ok: false; error: HirayaErrorData };

export interface RpcEvent<E extends ServiceEvent = ServiceEvent> {
  protocolVersion: 1;
  type: "event";
  event: E;
  payload: ServiceEvents[E];
}

export interface HostInitMessage {
  protocolVersion: 1;
  type: "hiraya:init";
  appId: string;
  nonce: string;
}

export interface AppConnectMessage {
  protocolVersion: 1;
  type: "hiraya:connect";
  appId: string;
}

export interface AppReadyMessage {
  protocolVersion: 1;
  type: "hiraya:ready";
  appId: string;
  nonce: string;
}

export interface FileMetadata {
  handle: FileHandle;
  name: string;
  mimeType: string;
  size: number;
  modifiedAt: number;
  parent: FolderHandle | null;
  contentRevision: number;
}

export interface FolderMetadata {
  handle: FolderHandle;
  name: string;
  modifiedAt: number;
  parent: FolderHandle | null;
}

export type DirectoryEntry =
  | { kind: "file"; metadata: FileMetadata }
  | { kind: "folder"; metadata: FolderMetadata };

export interface WindowState {
  focused: boolean;
  maximized: boolean;
  fullscreen: boolean;
  width: number;
  height: number;
}

export interface CommandDefinition {
  id: string;
  title: string;
  shortcut?: string;
  enabled?: boolean;
}

export interface ServiceMethods {
  "app.getLaunchContext": { params: Record<string, never>; result: LaunchContext };
  "files.stat": { params: { handle: FileHandle | FolderHandle }; result: DirectoryEntry };
  "files.read": { params: { handle: FileHandle }; result: { data: ArrayBuffer; mimeType: string } };
  "files.write": { params: { handle: FileHandle; data: ArrayBuffer; mimeType?: string; expectedRevision?: number }; result: FileMetadata };
  "files.list": { params: { folder: FolderHandle | null }; result: DirectoryEntry[] };
  "files.createFile": { params: { parent: FolderHandle | null; name: string; data?: ArrayBuffer; mimeType?: string }; result: FileMetadata };
  "files.createFolder": { params: { parent: FolderHandle | null; name: string }; result: FolderMetadata };
  "files.rename": { params: { handle: FileHandle | FolderHandle; name: string }; result: DirectoryEntry };
  "files.move": { params: { handle: FileHandle | FolderHandle; parent: FolderHandle | null }; result: DirectoryEntry };
  "files.delete": { params: { handle: FileHandle | FolderHandle; recursive?: boolean }; result: void };
  "dialogs.openFile": { params: { multiple?: boolean; mimeTypes?: string[] }; result: FileHandle[] | null };
  "dialogs.openFolder": { params: Record<string, never>; result: FolderHandle | null };
  "dialogs.saveFile": { params: { suggestedName?: string; mimeType?: string }; result: FileHandle | null };
  "dialogs.confirm": { params: { title: string; message: string; confirmLabel?: string; destructive?: boolean }; result: boolean };
  "window.getState": { params: Record<string, never>; result: WindowState };
  "window.setTitle": { params: { title: string }; result: void };
  "window.setDirty": { params: { dirty: boolean }; result: void };
  "window.setSize": { params: { width: number; height: number }; result: WindowState };
  "window.setFullscreen": { params: { fullscreen: boolean }; result: WindowState };
  "window.close": { params: Record<string, never>; result: void };
  "commands.set": { params: { commands: CommandDefinition[] }; result: void };
  "commands.clear": { params: Record<string, never>; result: void };
  "notifications.show": { params: { title: string; body?: string; tag?: string }; result: { id: string } };
  "notifications.dismiss": { params: { id: string }; result: void };
  "theme.get": { params: Record<string, never>; result: ThemeTokens };
  "storage.get": { params: { key: string }; result: JsonValue | undefined };
  "storage.set": { params: { key: string; value: JsonValue }; result: void };
  "storage.remove": { params: { key: string }; result: void };
  "storage.clear": { params: Record<string, never>; result: void };
}

export type ServiceMethod = keyof ServiceMethods;

export interface ServiceEvents {
  "files.changed": { handles: (FileHandle | FolderHandle)[] };
  "window.stateChanged": WindowState;
  "commands.invoked": { id: string };
  "notifications.clicked": { id: string };
  "theme.changed": ThemeTokens;
}

export type ServiceEvent = keyof ServiceEvents;

const permissionSet = new Set<string>(APP_PERMISSIONS);
const errorCodeSet = new Set<string>(HIRAYA_ERROR_CODES);
const serviceMethodSet = new Set<string>([
  "app.getLaunchContext",
  "files.stat", "files.read", "files.write", "files.list", "files.createFile", "files.createFolder", "files.rename", "files.move", "files.delete",
  "dialogs.openFile", "dialogs.openFolder", "dialogs.saveFile", "dialogs.confirm",
  "window.getState", "window.setTitle", "window.setDirty", "window.setSize", "window.setFullscreen", "window.close",
  "commands.set", "commands.clear", "notifications.show", "notifications.dismiss", "theme.get",
  "storage.get", "storage.set", "storage.remove", "storage.clear",
]);
const serviceEventSet = new Set<string>(["files.changed", "window.stateChanged", "commands.invoked", "notifications.clicked", "theme.changed"]);

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[], label: string) {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !(key in value)) || Object.keys(value).some((key) => !allowed.has(key))) {
    throw new TypeError(`${label} has an unsupported shape.`);
  }
}

function text(value: unknown, label: string, max = 256): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  })) throw new TypeError(`${label} is invalid.`);
  return value;
}

function stringArray(value: unknown, label: string, maxItems = 64): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new TypeError(`${label} is invalid.`);
  return value.map((item) => text(item, label));
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${label} is invalid.`);
  return value;
}

function number(value: unknown, label: string, options: { integer?: boolean; min?: number; max?: number } = {}): number {
  if (typeof value !== "number" || !Number.isFinite(value) || options.integer && !Number.isInteger(value) || options.min !== undefined && value < options.min || options.max !== undefined && value > options.max) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function arrayBuffer(value: unknown, label: string): ArrayBuffer {
  if (!(value instanceof ArrayBuffer)) throw new TypeError(`${label} must be an ArrayBuffer.`);
  return value;
}

function empty(value: unknown, label: string): Record<string, never> {
  const result = record(value, label);
  exact(result, [], [], label);
  return {};
}

function relativePath(value: unknown, label: string): string {
  const path = text(value, label, 1024);
  if (path.startsWith("/") || path.split("/").some((part) => !SAFE_PATH_SEGMENT.test(part))) throw new TypeError(`${label} is invalid.`);
  return path;
}

export function parsePermission(value: unknown): AppPermission {
  if (typeof value !== "string" || !permissionSet.has(value)) throw new TypeError("App permission is invalid.");
  return value as AppPermission;
}

export function parseFileHandle(value: unknown): FileHandle {
  if (typeof value !== "string" || !HANDLE.test(value) || !value.startsWith("file_")) throw new TypeError("File handle is invalid.");
  return value as FileHandle;
}

export function parseFolderHandle(value: unknown): FolderHandle {
  if (typeof value !== "string" || !HANDLE.test(value) || !value.startsWith("folder_")) throw new TypeError("Folder handle is invalid.");
  return value as FolderHandle;
}

export function parseManifestV1(value: unknown): HirayaAppManifestV1 {
  const manifest = record(value, "App manifest");
  exact(manifest, ["schemaVersion", "id", "name", "version", "entrypoint", "permissions"], ["description", "icon", "fileTypes"], "App manifest");
  if (manifest.schemaVersion !== 1) throw new TypeError("App manifest schema version is unsupported.");
  const id = text(manifest.id, "App ID");
  if (!APP_ID.test(id)) throw new TypeError("App ID is invalid.");
  if (typeof manifest.version !== "string" || !VERSION.test(manifest.version)) throw new TypeError("App version is invalid.");
  if (!Array.isArray(manifest.permissions)) throw new TypeError("App permissions are invalid.");
  const permissions = manifest.permissions.map(parsePermission);
  if (new Set(permissions).size !== permissions.length) throw new TypeError("App permissions contain duplicates.");
  const result: HirayaAppManifestV1 = {
    schemaVersion: 1,
    id,
    name: text(manifest.name, "App name", 80),
    version: manifest.version,
    entrypoint: relativePath(manifest.entrypoint, "App entrypoint"),
    permissions,
  };
  if (manifest.description !== undefined) result.description = text(manifest.description, "App description", 500);
  if (manifest.icon !== undefined) result.icon = relativePath(manifest.icon, "App icon");
  if (manifest.fileTypes !== undefined) {
    const fileTypes = stringArray(manifest.fileTypes, "App file types");
    if (new Set(fileTypes).size !== fileTypes.length) throw new TypeError("App file types contain duplicates.");
    result.fileTypes = fileTypes;
  }
  return result;
}

const themeKeys = ["mode", "background", "surface", "surfaceElevated", "text", "textMuted", "border", "accent", "accentText", "danger", "focus"] as const;

export function parseThemeTokens(value: unknown): ThemeTokens {
  const theme = record(value, "Theme tokens");
  exact(theme, themeKeys, [], "Theme tokens");
  if (theme.mode !== "light" && theme.mode !== "dark") throw new TypeError("Theme mode is invalid.");
  const token = (key: Exclude<(typeof themeKeys)[number], "mode">) => text(theme[key], `Theme token ${key}`, 128);
  return {
    mode: theme.mode,
    background: token("background"), surface: token("surface"), surfaceElevated: token("surfaceElevated"),
    text: token("text"), textMuted: token("textMuted"), border: token("border"), accent: token("accent"),
    accentText: token("accentText"), danger: token("danger"), focus: token("focus"),
  };
}

export function parseLaunchContext(value: unknown): LaunchContext {
  const context = record(value, "Launch context");
  exact(context, ["protocolVersion", "appId", "launchId", "source", "files", "folders", "arguments", "theme"], [], "Launch context");
  const appId = text(context.appId, "Launch app ID");
  if (context.protocolVersion !== 1 || !APP_ID.test(appId)) throw new TypeError("Launch context protocol or app ID is invalid.");
  if (context.source !== "launcher" && context.source !== "file" && context.source !== "command" && context.source !== "restore") throw new TypeError("Launch source is invalid.");
  if (!Array.isArray(context.files) || !Array.isArray(context.folders)) throw new TypeError("Launch handles are invalid.");
  return {
    protocolVersion: 1,
    appId,
    launchId: text(context.launchId, "Launch ID"),
    source: context.source,
    files: context.files.map(parseFileHandle),
    folders: context.folders.map(parseFolderHandle),
    arguments: stringArray(context.arguments, "Launch arguments"),
    theme: parseThemeTokens(context.theme),
  };
}

function parseWindowState(value: unknown): WindowState {
  const state = record(value, "Window state");
  exact(state, ["focused", "maximized", "fullscreen", "width", "height"], [], "Window state");
  return {
    focused: boolean(state.focused, "Window focus"),
    maximized: boolean(state.maximized, "Window maximized state"),
    fullscreen: boolean(state.fullscreen, "Window fullscreen state"),
    width: number(state.width, "Window width", { integer: true, min: 1, max: 16_384 }),
    height: number(state.height, "Window height", { integer: true, min: 1, max: 16_384 }),
  };
}

function parseFileMetadata(value: unknown): FileMetadata {
  const metadata = record(value, "File metadata");
  exact(metadata, ["handle", "name", "mimeType", "size", "modifiedAt", "parent", "contentRevision"], [], "File metadata");
  return {
    handle: parseFileHandle(metadata.handle), name: text(metadata.name, "File name", 255), mimeType: text(metadata.mimeType, "File MIME type", 255),
    size: number(metadata.size, "File size", { integer: true, min: 0 }), modifiedAt: number(metadata.modifiedAt, "File modified time", { min: 0 }),
    parent: metadata.parent === null ? null : parseFolderHandle(metadata.parent), contentRevision: number(metadata.contentRevision, "Content revision", { integer: true, min: 0 }),
  };
}

function parseFolderMetadata(value: unknown): FolderMetadata {
  const metadata = record(value, "Folder metadata");
  exact(metadata, ["handle", "name", "modifiedAt", "parent"], [], "Folder metadata");
  return { handle: parseFolderHandle(metadata.handle), name: text(metadata.name, "Folder name", 255), modifiedAt: number(metadata.modifiedAt, "Folder modified time", { min: 0 }), parent: metadata.parent === null ? null : parseFolderHandle(metadata.parent) };
}

function parseDirectoryEntry(value: unknown): DirectoryEntry {
  const entry = record(value, "Directory entry");
  exact(entry, ["kind", "metadata"], [], "Directory entry");
  if (entry.kind === "file") return { kind: "file", metadata: parseFileMetadata(entry.metadata) };
  if (entry.kind === "folder") return { kind: "folder", metadata: parseFolderMetadata(entry.metadata) };
  throw new TypeError("Directory entry kind is invalid.");
}

function optionalText(value: unknown, label: string, max = 256): string | undefined {
  return value === undefined ? undefined : text(value, label, max);
}

function handle(value: unknown): FileHandle | FolderHandle {
  if (typeof value === "string" && value.startsWith("file_")) return parseFileHandle(value);
  return parseFolderHandle(value);
}

function nullableFolder(value: unknown): FolderHandle | null {
  return value === null ? null : parseFolderHandle(value);
}

export function parseServiceParams<M extends ServiceMethod>(method: M, value: unknown): ServiceMethods[M]["params"] {
  const params = record(value, `${method} params`);
  const shape = (required: readonly string[], optional: readonly string[] = []) => exact(params, required, optional, `${method} params`);
  let result: unknown;
  switch (method) {
    case "app.getLaunchContext": case "dialogs.openFolder": case "window.getState": case "window.close": case "commands.clear": case "storage.clear": result = empty(params, `${method} params`); break;
    case "files.stat": case "files.read": shape(["handle"]); result = { handle: method === "files.read" ? parseFileHandle(params.handle) : handle(params.handle) }; break;
    case "files.write": shape(["handle", "data"], ["mimeType", "expectedRevision"]); result = { handle: parseFileHandle(params.handle), data: arrayBuffer(params.data, "File data"), ...(params.mimeType === undefined ? {} : { mimeType: text(params.mimeType, "File MIME type", 255) }), ...(params.expectedRevision === undefined ? {} : { expectedRevision: number(params.expectedRevision, "Expected revision", { integer: true, min: 0 }) }) }; break;
    case "files.list": shape(["folder"]); result = { folder: nullableFolder(params.folder) }; break;
    case "files.createFile": shape(["parent", "name"], ["data", "mimeType"]); result = { parent: nullableFolder(params.parent), name: text(params.name, "File name", 255), ...(params.data === undefined ? {} : { data: arrayBuffer(params.data, "File data") }), ...(params.mimeType === undefined ? {} : { mimeType: text(params.mimeType, "File MIME type", 255) }) }; break;
    case "files.createFolder": shape(["parent", "name"]); result = { parent: nullableFolder(params.parent), name: text(params.name, "Folder name", 255) }; break;
    case "files.rename": shape(["handle", "name"]); result = { handle: handle(params.handle), name: text(params.name, "Entry name", 255) }; break;
    case "files.move": shape(["handle", "parent"]); result = { handle: handle(params.handle), parent: nullableFolder(params.parent) }; break;
    case "files.delete": shape(["handle"], ["recursive"]); result = { handle: handle(params.handle), ...(params.recursive === undefined ? {} : { recursive: boolean(params.recursive, "Recursive delete") }) }; break;
    case "dialogs.openFile": shape([], ["multiple", "mimeTypes"]); result = { ...(params.multiple === undefined ? {} : { multiple: boolean(params.multiple, "Multiple selection") }), ...(params.mimeTypes === undefined ? {} : { mimeTypes: stringArray(params.mimeTypes, "Dialog MIME types", 32) }) }; break;
    case "dialogs.saveFile": shape([], ["suggestedName", "mimeType"]); result = { ...(params.suggestedName === undefined ? {} : { suggestedName: text(params.suggestedName, "Suggested name", 255) }), ...(params.mimeType === undefined ? {} : { mimeType: text(params.mimeType, "File MIME type", 255) }) }; break;
    case "dialogs.confirm": shape(["title", "message"], ["confirmLabel", "destructive"]); result = { title: text(params.title, "Dialog title", 120), message: text(params.message, "Dialog message", 2_000), ...(params.confirmLabel === undefined ? {} : { confirmLabel: text(params.confirmLabel, "Confirm label", 80) }), ...(params.destructive === undefined ? {} : { destructive: boolean(params.destructive, "Destructive confirmation") }) }; break;
    case "window.setTitle": shape(["title"]); result = { title: text(params.title, "Window title", 120) }; break;
    case "window.setDirty": shape(["dirty"]); result = { dirty: boolean(params.dirty, "Window dirty state") }; break;
    case "window.setSize": shape(["width", "height"]); result = { width: number(params.width, "Window width", { integer: true, min: 1, max: 16_384 }), height: number(params.height, "Window height", { integer: true, min: 1, max: 16_384 }) }; break;
    case "window.setFullscreen": shape(["fullscreen"]); result = { fullscreen: boolean(params.fullscreen, "Window fullscreen state") }; break;
    case "commands.set": shape(["commands"]); if (!Array.isArray(params.commands) || params.commands.length > 64) throw new TypeError("Commands are invalid."); result = { commands: params.commands.map((item) => { const command = record(item, "Command"); exact(command, ["id", "title"], ["shortcut", "enabled"], "Command"); return { id: text(command.id, "Command ID", 128), title: text(command.title, "Command title", 120), ...(command.shortcut === undefined ? {} : { shortcut: text(command.shortcut, "Command shortcut", 64) }), ...(command.enabled === undefined ? {} : { enabled: boolean(command.enabled, "Command enabled state") }) }; }) }; break;
    case "notifications.show": shape(["title"], ["body", "tag"]); result = { title: text(params.title, "Notification title", 120), ...(params.body === undefined ? {} : { body: optionalText(params.body, "Notification body", 1_000) }), ...(params.tag === undefined ? {} : { tag: text(params.tag, "Notification tag", 128) }) }; break;
    case "notifications.dismiss": shape(["id"]); result = { id: text(params.id, "Notification ID") }; break;
    case "theme.get": result = empty(params, "theme.get params"); break;
    case "storage.get": case "storage.remove": shape(["key"]); result = { key: text(params.key, "Storage key", 128) }; break;
    case "storage.set": shape(["key", "value"]); result = { key: text(params.key, "Storage key", 128), value: parseJsonValue(params.value) }; break;
    default: throw new TypeError("RPC method is invalid.");
  }
  return result as ServiceMethods[M]["params"];
}

export function parseServiceResult<M extends ServiceMethod>(method: M, value: unknown): ServiceMethods[M]["result"] {
  let result: unknown;
  switch (method) {
    case "app.getLaunchContext": result = parseLaunchContext(value); break;
    case "files.stat": case "files.rename": case "files.move": result = parseDirectoryEntry(value); break;
    case "files.read": { const item = record(value, "File read result"); exact(item, ["data", "mimeType"], [], "File read result"); result = { data: arrayBuffer(item.data, "File data"), mimeType: text(item.mimeType, "File MIME type", 255) }; break; }
    case "files.write": case "files.createFile": result = parseFileMetadata(value); break;
    case "files.list": if (!Array.isArray(value) || value.length > 10_000) throw new TypeError("File list result is invalid."); result = value.map(parseDirectoryEntry); break;
    case "files.createFolder": result = parseFolderMetadata(value); break;
    case "dialogs.openFile": if (value !== null && !Array.isArray(value)) throw new TypeError("File dialog result is invalid."); result = value === null ? null : value.map(parseFileHandle); break;
    case "dialogs.openFolder": case "dialogs.saveFile": result = value === null ? null : method === "dialogs.openFolder" ? parseFolderHandle(value) : parseFileHandle(value); break;
    case "dialogs.confirm": result = boolean(value, "Confirmation result"); break;
    case "window.getState": case "window.setSize": case "window.setFullscreen": result = parseWindowState(value); break;
    case "notifications.show": { const item = record(value, "Notification result"); exact(item, ["id"], [], "Notification result"); result = { id: text(item.id, "Notification ID") }; break; }
    case "theme.get": result = parseThemeTokens(value); break;
    case "storage.get": result = value === undefined ? undefined : parseJsonValue(value); break;
    case "files.delete": case "window.setTitle": case "window.setDirty": case "window.close": case "commands.set": case "commands.clear": case "notifications.dismiss": case "storage.set": case "storage.remove": case "storage.clear": if (value !== undefined) throw new TypeError(`${method} result must be undefined.`); result = undefined; break;
    default: throw new TypeError("RPC method is invalid.");
  }
  return result as ServiceMethods[M]["result"];
}

export function parseServiceEventPayload<E extends ServiceEvent>(event: E, value: unknown): ServiceEvents[E] {
  if (event === "window.stateChanged") return parseWindowState(value) as ServiceEvents[E];
  if (event === "theme.changed") return parseThemeTokens(value) as ServiceEvents[E];
  const payload = record(value, `${event} payload`);
  if (event === "files.changed") { exact(payload, ["handles"], [], `${event} payload`); if (!Array.isArray(payload.handles) || payload.handles.length > 10_000) throw new TypeError("Changed handles are invalid."); return { handles: payload.handles.map(handle) } as ServiceEvents[E]; }
  exact(payload, ["id"], [], `${event} payload`);
  return { id: text(payload.id, `${event} ID`, 128) } as ServiceEvents[E];
}

export function parseHostInit(value: unknown): HostInitMessage {
  const message = record(value, "Host init");
  exact(message, ["protocolVersion", "type", "appId", "nonce"], [], "Host init");
  const appId = text(message.appId, "Host app ID");
  if (message.protocolVersion !== 1 || message.type !== "hiraya:init" || !APP_ID.test(appId)) throw new TypeError("Host init protocol or app ID is invalid.");
  const nonce = text(message.nonce, "Host nonce", 128);
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) throw new TypeError("Host nonce is invalid.");
  return { protocolVersion: 1, type: "hiraya:init", appId, nonce };
}

export function parseAppConnect(value: unknown): AppConnectMessage {
  const message = record(value, "App connect");
  exact(message, ["protocolVersion", "type", "appId"], [], "App connect");
  const appId = text(message.appId, "App connect ID");
  if (message.protocolVersion !== 1 || message.type !== "hiraya:connect" || !APP_ID.test(appId)) throw new TypeError("App connect protocol or app ID is invalid.");
  return { protocolVersion: 1, type: "hiraya:connect", appId };
}

export function parseAppReady(value: unknown): AppReadyMessage {
  const message = record(value, "App ready");
  exact(message, ["protocolVersion", "type", "appId", "nonce"], [], "App ready");
  const init = parseHostInit({ ...message, type: "hiraya:init" });
  if (message.type !== "hiraya:ready") throw new TypeError("App ready protocol is invalid.");
  return { ...init, type: "hiraya:ready" };
}

export function parseHirayaError(value: unknown): HirayaErrorData {
  const error = record(value, "RPC error");
  exact(error, ["code", "message"], ["details"], "RPC error");
  if (typeof error.code !== "string" || !errorCodeSet.has(error.code)) throw new TypeError("RPC error code is invalid.");
  const result: HirayaErrorData = { code: error.code as HirayaErrorCode, message: text(error.message, "RPC error message", 1000) };
  if (error.details !== undefined) result.details = parseJsonValue(error.details);
  return result;
}

export function parseJsonValue(value: unknown, depth = 0): JsonValue {
  if (depth > 32) throw new TypeError("JSON value is too deeply nested.");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item) => parseJsonValue(item, depth + 1));
  const object = record(value, "JSON value");
  const parsed: { [key: string]: JsonValue } = {};
  for (const [key, item] of Object.entries(object)) parsed[key] = parseJsonValue(item, depth + 1);
  return parsed;
}

export function parseRpcRequest(value: unknown): RpcRequest {
  const request = record(value, "RPC request");
  exact(request, ["protocolVersion", "type", "id", "method", "params"], [], "RPC request");
  if (request.protocolVersion !== 1 || request.type !== "request") throw new TypeError("RPC request protocol is invalid.");
  if (typeof request.method !== "string" || !serviceMethodSet.has(request.method)) throw new TypeError("RPC method is invalid.");
  const method = request.method as ServiceMethod;
  return { protocolVersion: 1, type: "request", id: text(request.id, "RPC request ID"), method, params: parseServiceParams(method, request.params) } as RpcRequest;
}

export function parseRpcResponse(value: unknown): RpcResponse {
  const response = record(value, "RPC response");
  if (response.ok === true) {
    exact(response, ["protocolVersion", "type", "id", "ok", "result"], [], "RPC response");
    if (response.protocolVersion !== 1 || response.type !== "response") throw new TypeError("RPC response protocol is invalid.");
    return { protocolVersion: 1, type: "response", id: text(response.id, "RPC response ID"), ok: true, result: response.result };
  }
  exact(response, ["protocolVersion", "type", "id", "ok", "error"], [], "RPC response");
  if (response.protocolVersion !== 1 || response.type !== "response" || response.ok !== false) throw new TypeError("RPC response protocol is invalid.");
  return { protocolVersion: 1, type: "response", id: text(response.id, "RPC response ID"), ok: false, error: parseHirayaError(response.error) };
}

export function parseRpcEvent(value: unknown): RpcEvent {
  const event = record(value, "RPC event");
  exact(event, ["protocolVersion", "type", "event", "payload"], [], "RPC event");
  if (event.protocolVersion !== 1 || event.type !== "event" || typeof event.event !== "string" || !serviceEventSet.has(event.event)) throw new TypeError("RPC event protocol is invalid.");
  const eventName = event.event as ServiceEvent;
  return { protocolVersion: 1, type: "event", event: eventName, payload: parseServiceEventPayload(eventName, event.payload) } as RpcEvent;
}
