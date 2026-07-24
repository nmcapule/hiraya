import { parseJsonValue, type JsonValue } from "@hiraya/apps-contracts";
import { hasControlCharacters, HostServiceError, type AppInstanceOwner } from "./types";

export const MAX_APP_STORAGE_BYTES = 64 * 1024;
export const MAX_APP_STORAGE_ENTRIES = 128;
export const MAX_APP_STORAGE_KEY_LENGTH = 128;

export interface AppStorageApi {
  get(key: string): Promise<JsonValue | undefined>;
  set(key: string, value: JsonValue): Promise<void>;
  remove(key: string): Promise<void>;
  clear(): Promise<void>;
}

export class AppMemoryStorageService {
  readonly #apps = new Map<string, Map<string, JsonValue>>();

  constructor(private readonly maxBytes = MAX_APP_STORAGE_BYTES) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TypeError("Storage quota must be positive.");
  }

  forInstance(owner: AppInstanceOwner): AppStorageApi {
    return {
      get: async (key) => this.get(owner.appId, key),
      set: async (key, value) => this.set(owner.appId, key, value),
      remove: async (key) => this.remove(owner.appId, key),
      clear: async () => this.clear(owner.appId),
    };
  }

  get(appId: string, key: string): JsonValue | undefined {
    validateKey(key);
    return clone(this.#apps.get(appId)?.get(key));
  }

  set(appId: string, key: string, value: JsonValue): void {
    validateKey(key);
    const parsed = parseJsonValue(value);
    const current = this.#apps.get(appId) ?? new Map<string, JsonValue>();
    if (!current.has(key) && current.size >= MAX_APP_STORAGE_ENTRIES) throw new HostServiceError("App storage entry quota exceeded.", "QUOTA_EXCEEDED");
    const next = new Map(current);
    next.set(key, parsed);
    const bytes = [...next].reduce((total, [entryKey, entryValue]) => total + jsonBytes(entryKey) + jsonBytes(entryValue), 0);
    if (bytes > this.maxBytes) throw new HostServiceError("App storage quota exceeded.", "QUOTA_EXCEEDED");
    this.#apps.set(appId, next);
  }

  remove(appId: string, key: string): void {
    validateKey(key);
    this.#apps.get(appId)?.delete(key);
  }

  clear(appId: string): void {
    this.#apps.delete(appId);
  }
}

function validateKey(key: string): void {
  if (typeof key !== "string" || key.length === 0 || key.length > MAX_APP_STORAGE_KEY_LENGTH || hasControlCharacters(key)) throw new TypeError("App storage key is invalid.");
}

function clone(value: JsonValue | undefined): JsonValue | undefined {
  return value === undefined ? undefined : structuredClone(value);
}

function jsonBytes(value: JsonValue | string): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
