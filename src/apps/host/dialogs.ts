import type { FileHandle, FolderHandle, ServiceMethods } from "@hiraya/apps-contracts";
import { hasControlCharacters, HostServiceError, instanceKey, unavailable, type AppInstanceOwner } from "./types";

export const MAX_QUEUED_DIALOGS_PER_INSTANCE = 8;

type DialogParams = {
  openFile: ServiceMethods["dialogs.openFile"]["params"];
  openFolder: ServiceMethods["dialogs.openFolder"]["params"];
  saveFile: ServiceMethods["dialogs.saveFile"]["params"];
  confirm: ServiceMethods["dialogs.confirm"]["params"];
};

type DialogResults = {
  openFile: FileHandle[] | null;
  openFolder: FolderHandle | null;
  saveFile: FileHandle | null;
  confirm: boolean;
};

export type DialogKind = keyof DialogParams;
export type DialogRequest = {
  [K in DialogKind]: Readonly<{ id: string; owner: AppInstanceOwner; kind: K; params: DialogParams[K] }>
}[DialogKind];

type PendingDialog = {
  request: DialogRequest;
  resolve(value: DialogResults[DialogKind]): void;
  reject(reason: unknown): void;
};

export interface AppDialogApi {
  openFile(params?: DialogParams["openFile"]): Promise<DialogResults["openFile"]>;
  openFolder(): Promise<DialogResults["openFolder"]>;
  saveFile(params?: DialogParams["saveFile"]): Promise<DialogResults["saveFile"]>;
  confirm(params: DialogParams["confirm"]): Promise<DialogResults["confirm"]>;
}

export class AppDialogService {
  readonly #pending: PendingDialog[] = [];
  readonly #listeners = new Set<(requests: readonly DialogRequest[]) => void>();
  #nextId = 0;

  forInstance(owner: AppInstanceOwner): AppDialogApi {
    return {
      openFile: (params = {}) => this.#enqueue(owner, "openFile", params),
      openFolder: () => this.#enqueue(owner, "openFolder", {}),
      saveFile: (params = {}) => this.#enqueue(owner, "saveFile", params),
      confirm: (params) => this.#enqueue(owner, "confirm", params),
    };
  }

  requests(): readonly DialogRequest[] {
    return this.#pending.map(({ request }) => request);
  }

  subscribe(listener: (requests: readonly DialogRequest[]) => void): () => void {
    this.#listeners.add(listener);
    listener(this.requests());
    return () => this.#listeners.delete(listener);
  }

  respond<K extends DialogKind>(id: string, result: DialogResults[K]): void {
    const index = this.#pending.findIndex(({ request }) => request.id === id);
    if (index < 0) throw new HostServiceError("Dialog request was not found.", "NOT_FOUND");
    const [pending] = this.#pending.splice(index, 1);
    pending.resolve(result as DialogResults[DialogKind]);
    this.#publish();
  }

  reject(id: string, reason: unknown = new HostServiceError("Dialog was cancelled.", "CANCELLED")): void {
    const index = this.#pending.findIndex(({ request }) => request.id === id);
    if (index < 0) return;
    const [pending] = this.#pending.splice(index, 1);
    pending.reject(reason);
    this.#publish();
  }

  closeInstance(owner: AppInstanceOwner): void {
    const key = instanceKey(owner);
    const error = unavailable(owner);
    let changed = false;
    for (let index = this.#pending.length - 1; index >= 0; index -= 1) {
      if (instanceKey(this.#pending[index].request.owner) !== key) continue;
      this.#pending.splice(index, 1)[0].reject(error);
      changed = true;
    }
    if (changed) this.#publish();
  }

  #enqueue<K extends DialogKind>(owner: AppInstanceOwner, kind: K, params: DialogParams[K]): Promise<DialogResults[K]> {
    const ownedCount = this.#pending.filter(({ request }) => instanceKey(request.owner) === instanceKey(owner)).length;
    if (ownedCount >= MAX_QUEUED_DIALOGS_PER_INSTANCE) return Promise.reject(new HostServiceError("Too many dialogs are queued.", "QUOTA_EXCEEDED"));
    validateDialog(kind, params);
    const request = { id: `dialog-${++this.#nextId}`, owner, kind, params } as DialogRequest;
    return new Promise<DialogResults[K]>((resolve, reject) => {
      this.#pending.push({ request, resolve: resolve as (value: DialogResults[DialogKind]) => void, reject });
      this.#publish();
    });
  }

  #publish(): void {
    const requests = this.requests();
    for (const listener of this.#listeners) listener(requests);
  }
}

function validateDialog(kind: DialogKind, params: DialogParams[DialogKind]): void {
  if (kind === "confirm") {
    const value = params as DialogParams["confirm"];
    boundedText(value.title, "Dialog title", 120);
    boundedText(value.message, "Dialog message", 2_000);
    if (value.confirmLabel !== undefined) boundedText(value.confirmLabel, "Dialog confirm label", 80);
  } else if (kind === "saveFile") {
    const value = params as DialogParams["saveFile"];
    if (value.suggestedName !== undefined) boundedText(value.suggestedName, "Suggested file name", 255);
  } else if (kind === "openFile") {
    const value = params as DialogParams["openFile"];
    if (value.mimeTypes !== undefined && (!Array.isArray(value.mimeTypes) || value.mimeTypes.length > 32)) throw new TypeError("Dialog MIME types are invalid.");
  }
}

function boundedText(value: string, label: string, max: number): void {
  if (typeof value !== "string" || value.length === 0 || value.length > max || hasControlCharacters(value)) throw new TypeError(`${label} is invalid.`);
}
