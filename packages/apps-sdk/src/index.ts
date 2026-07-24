import {
  APPS_PROTOCOL_VERSION,
  parseRpcEvent,
  parseRpcResponse,
  type CommandDefinition,
  type FileHandle,
  type FolderHandle,
  type HirayaErrorCode,
  type JsonValue,
  type ServiceEvent,
  type ServiceEvents,
  type ServiceMethod,
  type ServiceMethods,
} from "@hiraya/apps-contracts";

export type * from "@hiraya/apps-contracts";

export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ConnectOptions {
  port?: MessagePort;
  targetOrigin?: string;
  appId?: string;
  requestTimeoutMs?: number;
}

type PendingRequest = {
  resolve(value: unknown): void;
  reject(reason: unknown): void;
  cleanup(): void;
};

export class HirayaSdkError extends Error {
  constructor(
    message: string,
    public readonly code: HirayaErrorCode,
    public readonly details?: JsonValue,
  ) {
    super(message);
    this.name = "HirayaSdkError";
  }
}

export class HirayaClient {
  readonly app = {
    getLaunchContext: (options?: RequestOptions) => this.request("app.getLaunchContext", {}, options),
  };

  readonly files = {
    stat: (handle: FileHandle | FolderHandle, options?: RequestOptions) => this.request("files.stat", { handle }, options),
    read: (handle: FileHandle, options?: RequestOptions) => this.request("files.read", { handle }, options),
    write: (handle: FileHandle, data: ArrayBuffer, options?: RequestOptions & { mimeType?: string; expectedRevision?: number }) => this.request("files.write", {
      handle,
      data,
      ...(options?.mimeType === undefined ? {} : { mimeType: options.mimeType }),
      ...(options?.expectedRevision === undefined ? {} : { expectedRevision: options.expectedRevision }),
    }, options),
    list: (folder: FolderHandle | null = null, options?: RequestOptions) => this.request("files.list", { folder }, options),
    createFile: (params: ServiceMethods["files.createFile"]["params"], options?: RequestOptions) => this.request("files.createFile", params, options),
    createFolder: (parent: FolderHandle | null, name: string, options?: RequestOptions) => this.request("files.createFolder", { parent, name }, options),
    rename: (handle: FileHandle | FolderHandle, name: string, options?: RequestOptions) => this.request("files.rename", { handle, name }, options),
    move: (handle: FileHandle | FolderHandle, parent: FolderHandle | null, options?: RequestOptions) => this.request("files.move", { handle, parent }, options),
    delete: (handle: FileHandle | FolderHandle, recursive = false, options?: RequestOptions) => this.request("files.delete", { handle, recursive }, options),
  };

  readonly dialogs = {
    openFile: (params: ServiceMethods["dialogs.openFile"]["params"] = {}, options?: RequestOptions) => this.request("dialogs.openFile", params, options),
    openFolder: (options?: RequestOptions) => this.request("dialogs.openFolder", {}, options),
    saveFile: (params: ServiceMethods["dialogs.saveFile"]["params"] = {}, options?: RequestOptions) => this.request("dialogs.saveFile", params, options),
    confirm: (params: ServiceMethods["dialogs.confirm"]["params"], options?: RequestOptions) => this.request("dialogs.confirm", params, options),
  };

  readonly window = {
    getState: (options?: RequestOptions) => this.request("window.getState", {}, options),
    setTitle: (title: string, options?: RequestOptions) => this.request("window.setTitle", { title }, options),
    setDirty: (dirty: boolean, options?: RequestOptions) => this.request("window.setDirty", { dirty }, options),
    setSize: (width: number, height: number, options?: RequestOptions) => this.request("window.setSize", { width, height }, options),
    setFullscreen: (fullscreen: boolean, options?: RequestOptions) => this.request("window.setFullscreen", { fullscreen }, options),
    close: (options?: RequestOptions) => this.request("window.close", {}, options),
  };

  readonly commands = {
    set: (commands: CommandDefinition[], options?: RequestOptions) => this.request("commands.set", { commands }, options),
    clear: (options?: RequestOptions) => this.request("commands.clear", {}, options),
  };

  readonly notifications = {
    show: (params: ServiceMethods["notifications.show"]["params"], options?: RequestOptions) => this.request("notifications.show", params, options),
    dismiss: (id: string, options?: RequestOptions) => this.request("notifications.dismiss", { id }, options),
  };

  readonly theme = {
    get: (options?: RequestOptions) => this.request("theme.get", {}, options),
  };

  readonly storage = {
    get: (key: string, options?: RequestOptions) => this.request("storage.get", { key }, options),
    set: (key: string, value: JsonValue, options?: RequestOptions) => this.request("storage.set", { key, value }, options),
    remove: (key: string, options?: RequestOptions) => this.request("storage.remove", { key }, options),
    clear: (options?: RequestOptions) => this.request("storage.clear", {}, options),
  };

  private readonly pending = new Map<string, PendingRequest>();
  private readonly subscriptions = new Map<ServiceEvent, Set<(payload: never) => void>>();
  private nextId = 0;
  private closed = false;

  constructor(
    private readonly port: MessagePort,
    private readonly defaultTimeoutMs = 15_000,
  ) {
    if (!Number.isFinite(defaultTimeoutMs) || defaultTimeoutMs <= 0) throw new TypeError("Request timeout must be positive.");
    port.addEventListener("message", this.handleMessage);
    port.addEventListener("messageerror", this.handleMessageError);
    port.start();
  }

  request<M extends ServiceMethod>(method: M, params: ServiceMethods[M]["params"], options: RequestOptions = {}): Promise<ServiceMethods[M]["result"]> {
    if (this.closed) return Promise.reject(new HirayaSdkError("The Hiraya connection is closed.", "UNAVAILABLE"));
    if (options.signal?.aborted) return Promise.reject(new HirayaSdkError("The request was aborted.", "CANCELLED"));
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new TypeError("Request timeout must be positive."));

    const id = `${Date.now().toString(36)}-${(++this.nextId).toString(36)}`;
    return new Promise<ServiceMethods[M]["result"]>((resolve, reject) => {
      const onAbort = () => finish(() => reject(new HirayaSdkError("The request was aborted.", "CANCELLED")));
      const timer = setTimeout(() => finish(() => reject(new HirayaSdkError(`Hiraya request timed out after ${timeoutMs} ms.`, "TIMEOUT"))), timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
      };
      const finish = (settle: () => void) => {
        if (!this.pending.has(id)) return;
        cleanup();
        settle();
      };
      this.pending.set(id, {
        resolve: (value) => finish(() => resolve(value as ServiceMethods[M]["result"])),
        reject: (reason) => finish(() => reject(reason)),
        cleanup,
      });
      options.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        this.port.postMessage({ protocolVersion: APPS_PROTOCOL_VERSION, type: "request", id, method, params });
      } catch (error) {
        finish(() => reject(error));
      }
    });
  }

  on<E extends ServiceEvent>(event: E, listener: (payload: ServiceEvents[E]) => void): () => void {
    if (this.closed) throw new HirayaSdkError("The Hiraya connection is closed.", "UNAVAILABLE");
    const listeners = this.subscriptions.get(event) ?? new Set<(payload: never) => void>();
    listeners.add(listener as (payload: never) => void);
    this.subscriptions.set(event, listeners);
    return () => {
      listeners.delete(listener as (payload: never) => void);
      if (listeners.size === 0) this.subscriptions.delete(event);
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.port.removeEventListener("message", this.handleMessage);
    this.port.removeEventListener("messageerror", this.handleMessageError);
    this.port.close();
    const error = new HirayaSdkError("The Hiraya connection was closed.", "UNAVAILABLE");
    for (const pending of [...this.pending.values()]) pending.reject(error);
    this.pending.clear();
    this.subscriptions.clear();
  }

  private readonly handleMessage = (message: MessageEvent<unknown>) => {
    try {
      if (isMessageType(message.data, "response")) {
        const response = parseRpcResponse(message.data);
        const pending = this.pending.get(response.id);
        if (!pending) return;
        if (response.ok) pending.resolve(response.result);
        else pending.reject(new HirayaSdkError(response.error.message, response.error.code, response.error.details));
        return;
      }
      if (isMessageType(message.data, "event")) {
        const event = parseRpcEvent(message.data);
        for (const listener of this.subscriptions.get(event.event) ?? []) listener(event.payload as never);
      }
    } catch (error) {
      const id = messageId(message.data);
      if (id !== undefined) this.pending.get(id)?.reject(error);
    }
  };

  private readonly handleMessageError = () => {
    this.close();
  };
}

export function connectHiraya(options: ConnectOptions = {}): HirayaClient {
  let port = options.port;
  if (port === undefined) {
    if (options.targetOrigin === undefined) throw new TypeError("targetOrigin is required for the Hiraya parent handshake.");
    if (typeof window === "undefined" || window.parent === window) throw new HirayaSdkError("Hiraya must run inside its host or receive a MessagePort.", "UNAVAILABLE");
    const channel = new MessageChannel();
    port = channel.port1;
    const handshake = { type: "hiraya:connect", protocolVersion: APPS_PROTOCOL_VERSION, ...(options.appId === undefined ? {} : { appId: options.appId }) };
    window.parent.postMessage(handshake, options.targetOrigin, [channel.port2]);
  }
  return new HirayaClient(port, options.requestTimeoutMs);
}

function isMessageType(value: unknown, type: "response" | "event"): boolean {
  return typeof value === "object" && value !== null && "type" in value && value.type === type;
}

function messageId(value: unknown): string | undefined {
  return typeof value === "object" && value !== null && "id" in value && typeof value.id === "string" ? value.id : undefined;
}
