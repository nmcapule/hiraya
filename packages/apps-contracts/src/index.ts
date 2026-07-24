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
  record(request.params, "RPC request params");
  return { protocolVersion: 1, type: "request", id: text(request.id, "RPC request ID"), method: request.method as ServiceMethod, params: request.params } as RpcRequest;
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
  record(event.payload, "RPC event payload");
  return { protocolVersion: 1, type: "event", event: event.event as ServiceEvent, payload: event.payload } as RpcEvent;
}
