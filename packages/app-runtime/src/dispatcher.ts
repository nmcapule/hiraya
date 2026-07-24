import {
  APPS_PROTOCOL_VERSION,
  parseRpcRequest,
  parseServiceEventPayload,
  parseServiceResult,
  type AppPermission,
  type RpcRequest,
  type ServiceMethod,
  type ServiceMethods,
  type ServiceEvent,
  type ServiceEvents,
} from "@hiraya/apps-contracts";

export type RuntimeHostContext = { close(): void; [group: string]: unknown };
export type RuntimeFileService = {
  stat(params: ServiceMethods["files.stat"]["params"]): unknown;
  read(params: ServiceMethods["files.read"]["params"]): unknown;
  write(params: ServiceMethods["files.write"]["params"]): unknown;
  list(params: ServiceMethods["files.list"]["params"]): unknown;
  createFile(params: ServiceMethods["files.createFile"]["params"]): unknown;
  createFolder(params: ServiceMethods["files.createFolder"]["params"]): unknown;
  rename(params: ServiceMethods["files.rename"]["params"]): unknown;
  move(params: ServiceMethods["files.move"]["params"]): unknown;
  delete(params: ServiceMethods["files.delete"]["params"]): unknown;
};

export type RuntimeCommands = {
  set(commands: ServiceMethods["commands.set"]["params"]["commands"]): void | Promise<void>;
  clear(): void | Promise<void>;
  close?(): void;
};

export interface RpcDispatcherOptions {
  permissions: Iterable<AppPermission>;
  host: RuntimeHostContext;
  files: RuntimeFileService;
  commands?: RuntimeCommands;
  maxRequestBytes?: number;
  maxRequestsPerSecond?: number;
  timeoutMs?: number;
}

const METHOD_PERMISSION: Partial<Record<ServiceMethod, AppPermission>> = {
  "files.stat": "files:read", "files.read": "files:read", "files.list": "files:read",
  "files.write": "files:write", "files.createFile": "files:write", "files.createFolder": "files:write", "files.rename": "files:write", "files.move": "files:write", "files.delete": "files:write",
  "dialogs.openFile": "dialogs", "dialogs.openFolder": "dialogs", "dialogs.saveFile": "dialogs", "dialogs.confirm": "dialogs",
  "window.getState": "window", "window.setTitle": "window", "window.setDirty": "window", "window.setSize": "window", "window.setFullscreen": "window", "window.close": "window",
  "commands.set": "commands", "commands.clear": "commands", "notifications.show": "notifications", "notifications.dismiss": "notifications",
  "theme.get": "theme", "storage.get": "storage", "storage.set": "storage", "storage.remove": "storage", "storage.clear": "storage",
};

export class RpcDispatcher {
  readonly #permissions: ReadonlySet<AppPermission>;
  readonly #maxRequestBytes: number;
  readonly #maxRequestsPerSecond: number;
  readonly #timeoutMs: number;
  #port: MessagePort | null = null;
  #closed = false;
  #windowStarted = performance.now();
  #windowRequests = 0;

  constructor(private readonly options: RpcDispatcherOptions) {
    this.#permissions = new Set(options.permissions);
    this.#maxRequestBytes = options.maxRequestBytes ?? 4 * 1024 * 1024;
    this.#maxRequestsPerSecond = options.maxRequestsPerSecond ?? 60;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    if (![this.#maxRequestBytes, this.#maxRequestsPerSecond, this.#timeoutMs].every((value) => Number.isFinite(value) && value > 0)) throw new TypeError("RPC limits must be positive.");
  }

  attach(port: MessagePort): void {
    if (this.#closed || this.#port) throw new Error("RPC dispatcher can only attach one channel.");
    this.#port = port;
    port.addEventListener("message", this.#onMessage);
    port.addEventListener("messageerror", this.#onMessageError);
    port.start();
  }

  dispose(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#port) {
      this.#port.removeEventListener("message", this.#onMessage);
      this.#port.removeEventListener("messageerror", this.#onMessageError);
      this.#port.close();
      this.#port = null;
    }
    this.options.commands?.close?.();
    this.options.host.close();
  }

  emit<E extends ServiceEvent>(event: E, payload: ServiceEvents[E]): void {
    const parsed = parseServiceEventPayload(event, payload);
    this.#post({ protocolVersion: APPS_PROTOCOL_VERSION, type: "event", event, payload: parsed });
  }

  async dispatch(value: unknown): Promise<void> {
    let request: RpcRequest | null = null;
    try {
      if (estimateBytes(value) > this.#maxRequestBytes) throw rpcError("INVALID_REQUEST", "The request exceeds the size limit.");
      this.#takeRateToken();
      request = parseRpcRequest(value);
      const permission = METHOD_PERMISSION[request.method];
      if (permission && !this.#permissions.has(permission)) throw rpcError("PERMISSION_DENIED", "The app does not have permission for this operation.");
      const result = await withTimeout(this.#invoke(request), this.#timeoutMs);
      const parsed = parseServiceResult(request.method, result);
      this.#post({ protocolVersion: APPS_PROTOCOL_VERSION, type: "response", id: request.id, ok: true, result: parsed });
    } catch (error) {
      const id = request?.id ?? requestId(value);
      if (id) this.#post({ protocolVersion: APPS_PROTOCOL_VERSION, type: "response", id, ok: false, error: sanitizeError(error) });
    }
  }

  #invoke(request: RpcRequest): unknown {
    const [group, name] = request.method.split(".");
    if (group === "files") return this.options.files[name as keyof RuntimeFileService](request.params as never);
    if (group === "commands") {
      if (!this.options.commands) throw rpcError("UNAVAILABLE", "App commands are not supported by this host.");
      return name === "set" ? this.options.commands.set((request.params as ServiceMethods["commands.set"]["params"]).commands) : this.options.commands.clear();
    }
    const api = this.options.host[group] as object | undefined;
    const method = api ? (api as Record<string, unknown>)[name] as ((...args: unknown[]) => unknown) | undefined : undefined;
    if (!method) throw rpcError("METHOD_NOT_FOUND", "The requested method is not available.");
    const params = request.params as Record<string, unknown>;
    if (Object.keys(params).length === 0) return method.call(api);
    if (group === "window" && name === "setTitle") return method.call(api, params.title);
    if (group === "window" && name === "setDirty") return method.call(api, params.dirty);
    if (group === "window" && name === "setSize") return method.call(api, params.width, params.height);
    if (group === "window" && name === "setFullscreen") return method.call(api, params.fullscreen);
    if (group === "notifications" && name === "dismiss") return method.call(api, params.id);
    if (group === "storage" && name === "get" || group === "storage" && name === "remove") return method.call(api, params.key);
    if (group === "storage" && name === "set") return method.call(api, params.key, params.value);
    return method.call(api, params);
  }

  #takeRateToken(): void {
    const now = performance.now();
    if (now - this.#windowStarted >= 1_000) { this.#windowStarted = now; this.#windowRequests = 0; }
    if (++this.#windowRequests > this.#maxRequestsPerSecond) throw rpcError("QUOTA_EXCEEDED", "The app is sending requests too quickly.");
  }

  #post(value: unknown): void {
    if (!this.#closed) this.#port?.postMessage(value);
  }

  readonly #onMessage = (event: MessageEvent<unknown>) => { void this.dispatch(event.data); };
  readonly #onMessageError = () => this.dispose();
}

function rpcError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

function sanitizeError(error: unknown) {
  const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" && ["INVALID_REQUEST", "METHOD_NOT_FOUND", "PERMISSION_DENIED", "NOT_FOUND", "ALREADY_EXISTS", "CONFLICT", "CANCELLED", "OFFLINE", "QUOTA_EXCEEDED", "TIMEOUT", "UNAVAILABLE", "INTERNAL"].includes(error.code) ? error.code : error instanceof TypeError ? "INVALID_REQUEST" : "INTERNAL";
  const safe = code === "INTERNAL" ? "The app request could not be completed." : error instanceof Error ? error.message.slice(0, 1_000) : "The app request could not be completed.";
  return { code, message: safe };
}

function requestId(value: unknown): string | null {
  return typeof value === "object" && value !== null && "id" in value && typeof value.id === "string" && value.id.length <= 256 ? value.id : null;
}

function estimateBytes(value: unknown, seen = new Set<object>()): number {
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (typeof value === "string") return value.length * 2;
  if (value === null || typeof value !== "object") return 8;
  if (seen.has(value)) return Number.POSITIVE_INFINITY;
  seen.add(value);
  let size = 0;
  for (const [key, item] of Object.entries(value)) size += key.length * 2 + estimateBytes(item, seen);
  return size;
}

async function withTimeout<T>(operation: T | Promise<T>, timeoutMs: number): Promise<T> {
  let timer = 0;
  try {
    return await Promise.race([Promise.resolve(operation), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(rpcError("TIMEOUT", "The app request timed out.")), timeoutMs) as unknown as number; })]);
  } finally { clearTimeout(timer); }
}
