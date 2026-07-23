import type { SeededManifest } from "./seeded-manifest";
import * as storage from "./opfs";
import { assertUniqueName, namesMatch, validateEntryName } from "./entry-validation";
import { API_ROUTES } from "./api-routes";
import { parseLayout, parsePosition, parseRemoteDesktopState, parseRootEntryPositionUpdates, type RemoteDesktopState, type RemoteEntry } from "./contracts";
import type { DesktopEntry, DesktopIdentity, DesktopLayout, RootEntryPositionUpdate, EditorSettings, EntryPosition, FileEntry, FolderEntry } from "../types";
import type { OutboxOperation, OutboxRecord } from "./outbox";
import { desktopPendingOperationProtection, outboxDesktopRetentionIds } from "./outbox";
import { parseCustomTheme, parseThemeState, type CustomTheme } from "./themes";
import type { ClipboardEntrySnapshot } from "./clipboard";
import { parseActivityPage, parseActivityQuery, type ActivityQuery } from "./activity";
import { parseDesktopCatalog } from "./desktop-catalog";

type OutboxOperationInput = OutboxOperation extends infer Operation
  ? Operation extends OutboxOperation ? Omit<Operation, "schemaVersion"> : never
  : never;

export type SyncStatus = "connecting" | "online" | "offline" | "blocked" | "local";
export type DesktopRegistry = { schemaVersion: 1; catalogId: string | null; catalogRevision: number; desktops: DesktopIdentity[]; activeDesktopId: string | null };

export async function fetchServerBuildTimestamp(fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)) {
  const response = await fetchImpl(API_ROUTES.health, { cache: "no-store" });
  if (!response.ok) throw new Error("The Hiraya server is unavailable.");
  const health = await response.json() as unknown;
  if (typeof health !== "object" || health === null || !("buildTimestamp" in health) || typeof health.buildTimestamp !== "string") return null;
  return health.buildTimestamp || null;
}

type StorageBoundary = Pick<typeof storage,
  "applyRemoteDesktop" | "createEntries" | "createFolder" | "createTextFile" | "deleteEntries" | "deleteEntry" | "importFiles" | "loadDesktop" |
  "moveEntries" | "moveEntry" | "readCurrentDesktop" | "captureDesktopState" | "readFile" | "readCachedFile" | "cacheRemoteFile" | "resolveFileByRelativePath" |
  "readDesktopState" |
  "renameEntry" | "saveDesktopLayout" | "saveEditorSettings" | "saveTextFile" | "updateEntryPosition"
  | "updateRootEntryPositions" | "enqueueMutation" | "readOutbox" | "bindOutboxCatalog" |
  "acknowledgeMutation" | "blockMutation" | "readPendingContent" |
  "selectTheme" | "saveCustomTheme" | "deleteCustomTheme"
  | "listActivity"
  | "transferEntries" | "enqueueTransfer"
  | "createDesktop" | "renameDesktop" | "deleteDesktop"
  | "createOfflineDesktop"
  | "listDesktops" | "ensureDesktop"
  | "pruneLocalDesktops"
>;

export type SyncEngineOptions = {
  frontendOnly?: boolean;
  fetch?: typeof fetch;
  eventSource?: typeof EventSource;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
  storage?: StorageBoundary;
};

class SyncRequestError extends Error {
  constructor(message: string, readonly status: number | null, readonly permanent: boolean) {
    super(message);
  }
}

export class VirtualFileUnavailableError extends Error {
  constructor(message = "This file is not available offline yet. Reconnect and try again.") {
    super(message);
    this.name = "VirtualFileUnavailableError";
  }
}

export class VirtualFileChangedError extends Error {
  constructor() {
    super("This file changed while it was loading. Try opening it again.");
    this.name = "VirtualFileChangedError";
  }
}

function localEntry(entry: RemoteEntry): DesktopEntry {
  const { revision: _revision, contentRevision: _contentRevision, ...local } = entry;
  void _revision;
  void _contentRevision;
  return local;
}

function serverEntry(entry: DesktopEntry) {
  return entry;
}

function toSnapshot(remote: RemoteDesktopState): storage.DesktopStateSnapshot {
  const entryRevisions: Record<string, number> = {};
  const contentRevisions: Record<string, number> = {};
  const themeRevisions: Record<string, number> = {};
  for (const entry of remote.entries) {
    entryRevisions[entry.id] = entry.revision;
    if (entry.kind === "file") contentRevisions[entry.id] = entry.contentRevision;
  }
  for (const theme of remote.appearance.customThemes) themeRevisions[theme.id] = theme.revision;
  return {
    entries: remote.entries.map(localEntry),
    layout: remote.layout,
    editorSettings: remote.editorSettings,
    appearance: {
      selectedThemeId: remote.appearance.selectedThemeId,
      customThemes: remote.appearance.customThemes.map(({ id, name, definition }) => ({ id, name, definition })),
    },
    sync: {
      catalogId: remote.catalogId,
      catalogRevision: remote.catalogRevision,
      entryRevisions,
      contentRevisions,
      layoutRevision: remote.layoutRevision,
      settingsRevision: remote.settingsRevision,
      themeSelectionRevision: remote.appearance.selectionRevision,
      themeRevisions,
    },
  };
}

export class SyncEngine {
  private readonly frontendOnly: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly EventSourceImpl: typeof EventSource | undefined;
  private readonly setIntervalImpl: typeof globalThis.setInterval;
  private readonly clearIntervalImpl: typeof globalThis.clearInterval;
  private readonly storage: StorageBoundary;
  private desktop: storage.DesktopStateSnapshot | null = null;
  private status: SyncStatus = "connecting";
  private events: EventSource | null = null;
  private healthTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  private work: Promise<unknown> = Promise.resolve();
  private startPromise: Promise<{ desktop: storage.DesktopStateSnapshot; status: SyncStatus }> | null = null;
  private running = false;
  private generation = 0;
  private desktopId = "";
  private catalogId: string | null = null;
  private catalogRevision = 0;
  private pendingWork = 0;
  private readonly desktopListeners = new Set<(next: storage.DesktopStateSnapshot) => void>();
  private readonly statusListeners = new Set<(next: SyncStatus) => void>();
  private readonly syncWorkListeners = new Set<(syncing: boolean) => void>();
  private readonly activityChangeListeners = new Set<() => void>();
  private readonly catalogListeners = new Set<(catalog: DesktopRegistry) => void>();
  private readonly contentLoads = new Map<string, Promise<File>>();

  constructor(options: SyncEngineOptions = {}) {
    this.frontendOnly = options.frontendOnly ?? false;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.EventSourceImpl = options.eventSource ?? globalThis.EventSource;
    this.setIntervalImpl = options.setInterval ?? globalThis.setInterval.bind(globalThis);
    this.clearIntervalImpl = options.clearInterval ?? globalThis.clearInterval.bind(globalThis);
    this.storage = options.storage ?? storage;
  }

  start(desktopId: string, viewport: EntryPosition, seeded: SeededManifest | null = null) {
    if (this.startPromise) return this.startPromise;
    this.running = true;
    const generation = ++this.generation;
    this.desktopId = desktopId;
    this.startPromise = this.startInternal(viewport, seeded, generation).catch((error) => {
      if (this.generation === generation) this.startPromise = null;
      throw error;
    });
    return this.startPromise;
  }

  private async startInternal(viewport: EntryPosition, seeded: SeededManifest | null, generation: number) {
    this.desktop = await this.storage.loadDesktop(viewport, seeded);
    if (!this.running || this.generation !== generation) throw new DOMException("Desktop synchronization was stopped.", "AbortError");
    this.publish(this.desktop);
    if (this.frontendOnly) {
      this.setStatus("local");
      return { desktop: this.desktop, status: this.status };
    }
    this.setStatus("connecting");
    try {
      await this.ensureServer(generation);
      this.setStatus("online");
      await this.replayOutbox(generation).catch((error) => {
        if (error instanceof SyncRequestError && error.permanent) this.setStatus("blocked");
        else throw error;
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      this.setStatus("offline");
    }
    if (this.running && this.generation === generation) this.startEvents();
    return { desktop: this.current(), status: this.status };
  }

  async stop() {
    const starting = this.startPromise;
    this.running = false;
    this.generation += 1;
    this.startPromise = null;
    this.events?.close();
    this.events = null;
    if (this.healthTimer !== null) this.clearIntervalImpl(this.healthTimer);
    this.healthTimer = null;
    this.contentLoads.clear();
    await Promise.all([this.work, starting?.catch(() => undefined)]);
  }

  subscribe(onDesktop: (next: storage.DesktopStateSnapshot) => void, onStatus: (next: SyncStatus) => void, onSyncWork?: (syncing: boolean) => void) {
    this.desktopListeners.add(onDesktop);
    this.statusListeners.add(onStatus);
    if (onSyncWork) this.syncWorkListeners.add(onSyncWork);
    onStatus(this.status);
    onSyncWork?.(!this.frontendOnly && this.pendingWork > 0);
    return () => {
      this.desktopListeners.delete(onDesktop);
      this.statusListeners.delete(onStatus);
      if (onSyncWork) this.syncWorkListeners.delete(onSyncWork);
    };
  }

  subscribeActivityChanges(listener: () => void) {
    this.activityChangeListeners.add(listener);
    return () => {
      this.activityChangeListeners.delete(listener);
    };
  }

  subscribeDesktopCatalog(listener: (catalog: DesktopRegistry) => void) {
    this.catalogListeners.add(listener);
    return () => { this.catalogListeners.delete(listener); };
  }

  private publishCatalog(catalog: DesktopRegistry) {
    for (const listener of this.catalogListeners) listener(catalog);
    return catalog;
  }

  private publishActivityChange() {
    for (const listener of this.activityChangeListeners) listener();
  }

  private setStatus(next: SyncStatus) {
    if (this.status === next) return;
    this.status = next;
    for (const listener of this.statusListeners) listener(next);
  }

  private publish(next: storage.DesktopStateSnapshot) {
    this.desktop = next;
    for (const listener of this.desktopListeners) listener(next);
  }

  private current() {
    if (!this.desktop) throw new Error("The desktop is still loading.");
    return this.desktop;
  }

  private assertActive(generation: number) {
    if (!this.running || this.generation !== generation) {
      throw new DOMException("Desktop synchronization was stopped.", "AbortError");
    }
  }

  private queue<T>(operation: () => Promise<T>) {
    if (!this.frontendOnly) {
      this.pendingWork += 1;
      if (this.pendingWork === 1) {
        for (const listener of this.syncWorkListeners) listener(true);
      }
    }
    const next = this.work.then(operation, operation);
    this.work = next.then(() => undefined, () => undefined);
    return next.finally(() => {
      if (!this.frontendOnly) {
        this.pendingWork -= 1;
        if (this.pendingWork === 0) {
          for (const listener of this.syncWorkListeners) listener(false);
        }
      }
    });
  }

  private async requestJson(input: RequestInfo | URL, init?: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(input, init);
    } catch {
      this.setStatus("offline");
      throw new SyncRequestError("The Hiraya server is unavailable. The change remains queued.", null, false);
    }
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: string } | null;
      throw new SyncRequestError(body?.error || `The Hiraya server rejected the request (${response.status}).`, response.status, response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429);
    }
    return response.json();
  }

  private async requestDesktop(input: RequestInfo | URL, init?: RequestInit) {
    return parseRemoteDesktopState(await this.requestJson(input, init));
  }

  private async fetchDesktop(desktopId = this.desktopId) {
    try {
      return await this.requestDesktop(API_ROUTES.desktop(desktopId), { cache: "no-store" });
    } catch (error) {
      if (error instanceof SyncRequestError && error.status === 404 && desktopId === this.desktopId) await this.refreshCatalog();
      throw error;
    }
  }

  private healthRoute() {
    return API_ROUTES.health;
  }

  private async applyRemoteState(remote: RemoteDesktopState, generation = this.generation, acknowledgedOperationId?: string, desktopId = this.desktopId) {
    this.assertActive(generation);
    const desktop = desktopId === this.desktopId ? this.current() : await this.storage.readDesktopState(desktopId);
    const identityChanged = desktop.sync.catalogId !== remote.catalogId;
    if (!identityChanged && remote.catalogRevision <= desktop.sync.catalogRevision) return desktop;
    const next = toSnapshot(remote);
    this.assertActive(generation);
    const applied = await this.storage.applyRemoteDesktop(next, new Map(), acknowledgedOperationId, desktopId);
    this.assertActive(generation);
    if (desktopId === this.desktopId) this.publish(applied);
    this.publishActivityChange();
    return applied;
  }

  private async ensureServer(generation = this.generation) {
    return this.reconcileActiveWithCreateRecovery(undefined, generation);
  }

  private async reconcile(acknowledgedOperationId?: string, desktopId = this.desktopId) {
    const generation = this.generation;
    const remote = await this.fetchDesktop(desktopId);
    this.assertActive(generation);
    await this.bindOutboxCatalog(remote.catalogId);
    return this.applyRemoteState(remote, generation, acknowledgedOperationId, desktopId);
  }

  private async bindOutboxCatalog(catalogId: string) {
    await this.storage.bindOutboxCatalog(catalogId);
    this.catalogId = catalogId;
  }

  private idempotencyHeaders(record: OutboxRecord, headers?: HeadersInit) {
    const result = new Headers(headers);
    result.set("X-Hiraya-Client-ID", record.clientId);
    result.set("X-Hiraya-Operation-ID", record.operationId);
    return result;
  }

  private async sendOutboxOperation(record: OutboxRecord) {
    const operation = record.operation;
    const desktopId = record.desktopId;
    const headers = (value?: HeadersInit) => this.idempotencyHeaders(record, value);
    switch (operation.kind) {
      case "create-desktop":
        await this.requestJson(API_ROUTES.desktops, { method: "POST", headers: headers({ "Content-Type": "application/json" }), body: JSON.stringify(operation.desktop) });
        return;
      case "rename-desktop":
        await this.requestJson(API_ROUTES.desktop(operation.desktop.id), { method: "PATCH", headers: headers({ "Content-Type": "application/json" }), body: JSON.stringify({ name: operation.desktop.name }) });
        return;
      case "delete-desktop":
        await this.requestJson(API_ROUTES.desktop(operation.desktopId), { method: "DELETE", headers: headers() });
        return;
      case "create": {
        if (operation.entries.length === 1) {
          const entry = operation.entries[0];
          const form = new FormData();
          form.append("entry", JSON.stringify(serverEntry(entry)));
          if (entry.kind === "file") form.append("content", await this.storage.readPendingContent(record.operationId, entry.id), entry.name);
          await this.requestJson(API_ROUTES.desktopEntries(desktopId), { method: "POST", headers: headers(), body: form });
        } else {
          const form = new FormData();
          form.append("entries", JSON.stringify(operation.entries.map(serverEntry)));
          for (const entry of operation.entries) if (entry.kind === "file") form.append(`file-${entry.id}`, await this.storage.readPendingContent(record.operationId, entry.id), entry.name);
          await this.requestJson(API_ROUTES.desktopImports(desktopId), { method: "POST", headers: headers(), body: form });
        }
        return;
      }
      case "update-entry":
        await this.requestJson(API_ROUTES.desktopEntry(desktopId, operation.entry.id), { method: "PATCH", headers: headers({ "Content-Type": "application/json" }), body: JSON.stringify(serverEntry(operation.entry)) });
        return;
      case "delete":
        await this.requestJson(API_ROUTES.desktopEntry(desktopId, operation.entryId), { method: "DELETE", headers: headers() });
        return;
      case "delete-entries":
        await this.requestJson(API_ROUTES.desktopDeleteEntries(desktopId), { method: "POST", headers: headers({ "Content-Type": "application/json" }), body: JSON.stringify({ entryIds: operation.entryIds }) });
        return;
      case "move-entries":
        await this.requestJson(API_ROUTES.desktopMoveEntries(desktopId), { method: "POST", headers: headers({ "Content-Type": "application/json" }), body: JSON.stringify({ entryIds: operation.entryIds, parentId: operation.parentId }) });
        return;
      case "entry-transfer":
        await this.requestJson(API_ROUTES.entryTransfers, { method: "POST", headers: headers({ "Content-Type": "application/json" }), body: JSON.stringify({ sourceDesktopId: desktopId, destinationDesktopId: operation.destinationDesktopId, entryIds: operation.entryIds, parentId: operation.parentId }) });
        return;
      case "save-content":
        await this.requestJson(API_ROUTES.desktopContent(desktopId, operation.entry.id), { method: "PUT", headers: headers({ "Content-Type": operation.entry.mimeType }), body: await this.storage.readPendingContent(record.operationId, operation.entry.id) });
        return;
      case "root-entry-positions":
        await this.requestJson(API_ROUTES.desktopRootEntryPositions(desktopId), { method: "PUT", headers: headers({ "Content-Type": "application/json" }), body: JSON.stringify(operation.positions) });
        return;
      case "layout":
        await this.requestJson(API_ROUTES.desktopLayout(desktopId), { method: "PUT", headers: headers({ "Content-Type": "application/json" }), body: JSON.stringify(operation.layout) });
        return;
      case "editor-settings":
        await this.requestJson(API_ROUTES.desktopEditorSettings(desktopId), { method: "PUT", headers: headers({ "Content-Type": "application/json" }), body: JSON.stringify(operation.settings) });
        return;
      case "select-theme":
        await this.requestJson(API_ROUTES.desktopThemeSelection(desktopId), { method: "PUT", headers: headers({ "Content-Type": "application/json" }), body: JSON.stringify({ themeId: operation.themeId }) });
        return;
      case "upsert-theme":
        await this.requestJson(API_ROUTES.desktopTheme(desktopId, operation.theme.id), { method: "PUT", headers: headers({ "Content-Type": "application/json" }), body: JSON.stringify(operation.theme) });
        return;
      case "delete-theme":
        await this.requestJson(API_ROUTES.desktopTheme(desktopId, operation.themeId), { method: "DELETE", headers: headers() });
    }
  }

  private async replayRecord(record: OutboxRecord, generation: number) {
    this.assertActive(generation);
    if (record.status === "blocked") throw new SyncRequestError(record.error ?? "A pending change is blocked.", 409, true);
    if (!this.catalogId || record.catalogId !== this.catalogId) {
      const message = "Pending changes belong to a different catalog.";
      await this.storage.blockMutation(record.operationId, message);
      throw new SyncRequestError(message, 409, true);
    }
    try {
      await this.sendOutboxOperation(record);
      if (record.operation.kind === "create-desktop" && record.operation.desktop.id === this.desktopId) {
        await this.reconcile(record.operationId, this.desktopId);
      } else if (record.operation.kind === "entry-transfer") {
        await this.reconcile(record.operationId, record.desktopId);
        await this.reconcile(undefined, record.operation.destinationDesktopId);
      } else if (record.operation.kind !== "create-desktop" && record.operation.kind !== "rename-desktop" && record.operation.kind !== "delete-desktop") {
        await this.reconcile(record.operationId, record.desktopId);
      }
      await this.storage.acknowledgeMutation(record.operationId);
    } catch (error) {
      if (error instanceof SyncRequestError && error.permanent) await this.storage.blockMutation(record.operationId, error.message);
      throw error;
    }
  }

  private async replayThroughActiveDesktopCreation(generation: number) {
    const records = await this.storage.readOutbox();
    const createIndex = records.findIndex((record) => record.operation.kind === "create-desktop" && record.operation.desktop.id === this.desktopId);
    if (createIndex < 0) return false;
    for (const record of records.slice(0, createIndex + 1)) {
      const ownerDesktopId = record.desktopId;
      const createsActiveDesktop = record.operation.kind === "create-desktop" && record.operation.desktop.id === this.desktopId;
      if (ownerDesktopId === this.desktopId && !createsActiveDesktop) {
        const message = "A desktop mutation is ordered before its pending desktop creation.";
        await this.storage.blockMutation(record.operationId, message);
        throw new SyncRequestError(message, 409, true);
      }
      await this.replayRecord(record, generation);
    }
    return true;
  }

  private async reconcileActiveWithCreateRecovery(acknowledgedOperationId?: string, generation = this.generation) {
    try {
      return await this.reconcile(acknowledgedOperationId, this.desktopId);
    } catch (error) {
      if (!(error instanceof SyncRequestError) || error.status !== 404 || !await this.replayThroughActiveDesktopCreation(generation)) throw error;
      return this.reconcile(acknowledgedOperationId, this.desktopId);
    }
  }

  private async replayOutbox(generation = this.generation) {
    if (!this.catalogId) {
      const catalog = parseDesktopCatalog(await this.requestJson(API_ROUTES.catalog, { cache: "no-store" }));
      this.catalogRevision = catalog.catalogRevision;
      await this.bindOutboxCatalog(catalog.catalogId);
    } else {
      await this.bindOutboxCatalog(this.catalogId);
    }
    for (const record of await this.storage.readOutbox()) {
      await this.replayRecord(record, generation);
    }
  }

  private startEvents() {
    if (!this.EventSourceImpl) throw new Error("Server events are unavailable in this browser.");
    this.events?.close();
    const events = new this.EventSourceImpl(API_ROUTES.events);
    this.events = events;
    events.onopen = () => {
      if (!this.running) return;
      if (this.status === "blocked") return;
      if (this.status !== "online") this.setStatus("connecting");
      void this.queue(async () => {
        const catalog = await this.refreshCatalog();
        if (catalog.desktops.some((desktop) => desktop.id === this.desktopId)) await this.reconcileActiveWithCreateRecovery();
        return this.replayOutbox();
      }).then(() => {
        if (this.running) this.setStatus("online");
      }).catch((error) => {
        if (this.running) this.setStatus(error instanceof SyncRequestError && error.permanent ? "blocked" : "offline");
      });
    };
    events.onerror = () => { if (this.running && this.status !== "blocked") this.setStatus("offline"); };
    events.addEventListener("catalog", (event) => {
      if (!this.running) return;
      if (this.status === "blocked") return;
      let revision = Number.NaN;
      let catalogId = "";
      try {
        const data = JSON.parse((event as MessageEvent<string>).data) as unknown;
        if (typeof data === "object" && data !== null && "catalogRevision" in data) {
          revision = Number((data as { catalogRevision: unknown }).catalogRevision);
          catalogId = "catalogId" in data && typeof data.catalogId === "string" ? data.catalogId : "";
        }
      } catch {
        return;
      }
      if (!Number.isSafeInteger(revision)) return;
      if (catalogId === this.catalogId && revision <= this.catalogRevision) return;
      this.catalogRevision = revision;
      void this.queue(async () => {
        const catalog = await this.refreshCatalog();
        if (catalog.desktops.some((desktop) => desktop.id === this.desktopId)) await this.reconcileActiveWithCreateRecovery();
        await this.replayOutbox();
      }).catch(() => {
        if (this.running) this.setStatus("offline");
      });
    });
    if (this.healthTimer !== null) this.clearIntervalImpl(this.healthTimer);
    this.healthTimer = this.setIntervalImpl(() => { void this.checkHealth(); }, 5_000);
  }

  private async checkHealth() {
    if (!this.running) return;
    try {
      const response = await this.fetchImpl(this.healthRoute(), { cache: "no-store" });
      if (!response.ok) throw new Error("unhealthy");
      const health = await response.json() as unknown;
      const revision = typeof health === "object" && health !== null && "catalogRevision" in health ? Number((health as { catalogRevision: unknown }).catalogRevision) : Number.NaN;
      const catalogId = typeof health === "object" && health !== null && "catalogId" in health && typeof health.catalogId === "string" ? health.catalogId : "";
      if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("invalid health response");
      if (this.status === "blocked") return;
      const wasOffline = this.status === "offline";
      if (wasOffline) this.setStatus("connecting");
      const changed = catalogId !== this.current().sync.catalogId || revision > this.catalogRevision;
      if (revision > this.catalogRevision) this.catalogRevision = revision;
      if (wasOffline || changed) await this.queue(async () => {
        const catalog = await this.refreshCatalog();
        if (catalog.desktops.some((desktop) => desktop.id === this.desktopId)) await this.reconcileActiveWithCreateRecovery();
        await this.replayOutbox();
      });
      if (this.running) this.setStatus("online");
    } catch (error) {
      if (this.running) this.setStatus(error instanceof SyncRequestError && error.permanent ? "blocked" : "offline");
    }
  }

  private async mutate<T>(operation: OutboxOperationInput, select: (next: storage.DesktopStateSnapshot) => T, contents?: Map<string, Blob>) {
    return this.queue(async () => {
      const queued = await this.storage.enqueueMutation({ ...operation, schemaVersion: 1 } as OutboxOperation, contents);
      this.publish(queued.desktop);
      if (this.status === "online") {
        try {
          await this.replayOutbox();
        } catch (error) {
          if (error instanceof SyncRequestError && (error.status === null || !error.permanent)) return select(this.current());
          if (error instanceof SyncRequestError && error.permanent) this.setStatus("blocked");
          throw error;
        }
      }
      return select(this.current());
    });
  }

  private localMutation<T>(operation: () => Promise<T>, publish = true) {
    return this.queue(async () => {
      const result = await operation();
      const next = await this.storage.readCurrentDesktop();
      if (publish) this.publish(next);
      else this.desktop = next;
      this.publishActivityChange();
      return result;
    });
  }

  private assertParent(parentId: string | null) {
    if (parentId === null) return;
    const parent = this.current().entries.find((entry) => entry.id === parentId);
    if (!parent || parent.kind !== "folder") throw new Error("That parent folder no longer exists.");
  }

  createTextFile(nameValue: string, parentId: string | null, position: EntryPosition) {
    if (this.frontendOnly) return this.localMutation(() => this.storage.createTextFile(nameValue, parentId, position));
    const parsedPosition = parsePosition(position);
    const name = validateEntryName(nameValue);
    this.assertParent(parentId);
    assertUniqueName(this.current().entries, name, parentId);
    const now = Date.now();
    const entry: FileEntry = { kind: "file", id: crypto.randomUUID(), name, parentId, mimeType: "text/plain", size: 0, createdAt: now, modifiedAt: now, position: parsedPosition };
    return this.mutate({ kind: "create", entries: [entry] }, (next) => next.entries.find((item) => item.id === entry.id) as FileEntry, new Map([[entry.id, new Blob([], { type: entry.mimeType })]]));
  }

  createFolder(nameValue: string, parentId: string | null, position: EntryPosition) {
    if (this.frontendOnly) return this.localMutation(() => this.storage.createFolder(nameValue, parentId, position));
    const parsedPosition = parsePosition(position);
    const name = validateEntryName(nameValue);
    this.assertParent(parentId);
    assertUniqueName(this.current().entries, name, parentId);
    const now = Date.now();
    const entry: FolderEntry = { kind: "folder", id: crypto.randomUUID(), name, parentId, createdAt: now, modifiedAt: now, position: parsedPosition };
    return this.mutate({ kind: "create", entries: [entry] }, (next) => next.entries.find((item) => item.id === entry.id) as FolderEntry);
  }

  importFiles(files: File[], parentId: string | null, positions: EntryPosition[]) {
    if (this.frontendOnly) return this.localMutation(() => this.storage.importFiles(files, parentId, positions));
    if (files.length !== positions.length) throw new Error("Each imported file needs a desktop position.");
    const parsedPositions = positions.map(parsePosition);
    this.assertParent(parentId);
    const names = files.map((file) => validateEntryName(file.name));
    for (const [index, name] of names.entries()) {
      assertUniqueName(this.current().entries, name, parentId);
      if (names.slice(0, index).some((candidate) => namesMatch(candidate, name))) throw new Error(`The upload contains more than one file named “${name}”.`);
    }
    const createdAt = Date.now();
    const entries: FileEntry[] = files.map((file, index) => ({ kind: "file", id: crypto.randomUUID(), name: names[index], parentId, mimeType: file.type || "application/octet-stream", size: file.size, createdAt, modifiedAt: file.lastModified || createdAt, position: parsedPositions[index] }));
    return this.mutate({ kind: "create", entries }, (next) => entries.map((entry) => next.entries.find((item) => item.id === entry.id) as FileEntry), new Map(entries.map((entry, index) => [entry.id, files[index]])));
  }

  renameEntry(id: string, nameValue: string) {
    if (this.frontendOnly) return this.localMutation(() => this.storage.renameEntry(id, nameValue));
    const existing = this.current().entries.find((entry) => entry.id === id);
    if (!existing) throw new Error("That entry no longer exists.");
    const name = validateEntryName(nameValue);
    assertUniqueName(this.current().entries, name, existing.parentId, id);
    return this.mutate({ kind: "update-entry", entry: { ...existing, name, modifiedAt: Date.now() } }, (next) => next.entries.find((item) => item.id === id) as DesktopEntry);
  }

  deleteEntry(id: string) {
    if (this.frontendOnly) return this.localMutation(() => this.storage.deleteEntry(id));
    const before = this.current().entries;
    if (!before.some((entry) => entry.id === id)) throw new Error("That entry no longer exists.");
    return this.mutate({ kind: "delete", entryId: id }, (next) => before.filter((entry) => !next.entries.some((item) => item.id === entry.id)));
  }

  deleteEntries(ids: string[]) {
    if (this.frontendOnly) return this.localMutation(() => this.storage.deleteEntries(ids));
    const unique = [...new Set(ids)];
    const before = this.current().entries;
    if (!unique.length || unique.length !== ids.length || unique.some((id) => !before.some((entry) => entry.id === id))) throw new Error("An entry no longer exists.");
    return this.mutate({ kind: "delete-entries", entryIds: unique }, (next) => before.filter((entry) => !next.entries.some((item) => item.id === entry.id)));
  }

  moveEntry(id: string, parentId: string | null, position: EntryPosition) {
    if (this.frontendOnly) return this.localMutation(() => this.storage.moveEntry(id, parentId, position));
    const parsedPosition = parsePosition(position);
    const existing = this.current().entries.find((entry) => entry.id === id);
    if (!existing) throw new Error("That entry no longer exists.");
    this.assertParent(parentId);
    const entry = { ...existing, parentId, position: parsedPosition };
    return this.mutate({ kind: "update-entry", entry }, (next) => next.entries.find((item) => item.id === id) as DesktopEntry);
  }

  moveEntries(ids: string[], parentId: string | null) {
    if (this.frontendOnly) return this.localMutation(() => this.storage.moveEntries(ids, parentId));
    const unique = [...new Set(ids)];
    if (!unique.length || unique.length !== ids.length || unique.some((id) => !this.current().entries.some((entry) => entry.id === id))) throw new Error("An entry no longer exists.");
    this.assertParent(parentId);
    return this.mutate({ kind: "move-entries", entryIds: unique, parentId }, (next) => unique.map((id) => next.entries.find((entry) => entry.id === id) as DesktopEntry));
  }

  transferEntries(destinationDesktopId: string, ids: string[], parentId: string | null) {
    const unique = [...new Set(ids)];
    if (!unique.length || unique.length !== ids.length || unique.some((id) => !this.current().entries.some((entry) => entry.id === id))) throw new Error("An entry no longer exists.");
    return this.queue(async () => {
      const result = this.frontendOnly
        ? await this.storage.transferEntries(this.desktopId, destinationDesktopId, unique, parentId)
        : (await this.storage.enqueueTransfer(this.desktopId, destinationDesktopId, unique, parentId)).desktop;
      this.publish(result);
      if (!this.frontendOnly && this.status === "online") {
        try { await this.replayOutbox(); }
        catch (error) {
          if (error instanceof SyncRequestError && error.permanent) this.setStatus("blocked");
          else if (!(error instanceof SyncRequestError)) throw error;
        }
      }
      return result;
    });
  }

  async createDesktop(name: string) {
    const desktop = await this.storage.createDesktop(name);
    if (!this.frontendOnly) await this.mutate({ kind: "create-desktop", desktop }, () => undefined);
    return desktop;
  }

  async listDesktops(seeded: SeededManifest | null = null) {
    let local = await this.storage.listDesktops(seeded);
    if (this.frontendOnly) {
      if (local.desktops.length === 0) {
        const desktop = await this.storage.createDesktop("Desktop");
        local = { desktops: [desktop], activeDesktopId: desktop.id };
      }
      return { schemaVersion: 1 as const, catalogId: null, catalogRevision: 0, ...local };
    }
    try {
      const catalog = parseDesktopCatalog(await this.requestJson(API_ROUTES.catalog, { cache: "no-store" }));
      this.catalogRevision = catalog.catalogRevision;
      await this.bindOutboxCatalog(catalog.catalogId);
      const remoteIds = new Set(catalog.desktops.map((desktop) => desktop.id));
      const records = (await this.storage.readOutbox()).filter((record) => record.catalogId === catalog.catalogId);
      const retainedLocalIds = outboxDesktopRetentionIds(records, catalog.catalogId);
      const pendingDeletes = new Set(records.flatMap((record) => record.operation.kind === "delete-desktop" ? [record.operation.desktopId] : []));
      const pendingRenames = new Map(records.flatMap((record) => record.operation.kind === "rename-desktop" ? [[record.operation.desktop.id, record.operation.desktop.name] as const] : []));
      for (const desktop of catalog.desktops) if (!pendingDeletes.has(desktop.id)) await this.storage.ensureDesktop(desktop);
      local = await this.storage.listDesktops();
      const remoteDesktops = catalog.desktops
        .filter((desktop) => !pendingDeletes.has(desktop.id))
        .map((desktop) => pendingRenames.has(desktop.id) ? { ...desktop, name: pendingRenames.get(desktop.id)! } : desktop);
      return {
        schemaVersion: 1 as const,
        catalogId: catalog.catalogId,
        catalogRevision: catalog.catalogRevision,
        activeDesktopId: local.activeDesktopId && (remoteIds.has(local.activeDesktopId) || retainedLocalIds.has(local.activeDesktopId))
          ? local.activeDesktopId
          : catalog.desktops[0]?.id ?? null,
        desktops: [...remoteDesktops, ...local.desktops.filter((desktop) => !remoteIds.has(desktop.id) && retainedLocalIds.has(desktop.id))],
      };
    } catch {
      if (local.desktops.length === 0) {
        const created = await this.storage.createOfflineDesktop("Offline desktop");
        local = { desktops: [created.desktop], activeDesktopId: created.desktop.id };
      }
      return { schemaVersion: 1 as const, catalogId: null, catalogRevision: 0, ...local };
    }
  }

  async refreshCatalog() {
    return this.publishCatalog(await this.listDesktops());
  }

  async renameDesktop(desktopId: string, name: string) {
    const desktop = await this.storage.renameDesktop(desktopId, name);
    if (!this.frontendOnly) await this.mutate({ kind: "rename-desktop", desktop }, () => undefined);
    return desktop;
  }

  async deleteDesktop(desktopId: string) {
    if (desktopId === this.desktopId) throw new Error("Switch desktops before deleting the active desktop.");
    const protection = desktopPendingOperationProtection(await this.storage.readOutbox(), desktopId);
    if (protection) throw new Error(protection);
    await this.storage.deleteDesktop(desktopId);
    if (!this.frontendOnly) await this.mutate({ kind: "delete-desktop", desktopId }, () => undefined);
  }

  async captureEntries(rootIds: string[]): Promise<ClipboardEntrySnapshot> {
    return this.queue(async () => {
      const desktop = this.current();
      const roots = [...new Set(rootIds)].map((id) => desktop.entries.find((entry) => entry.id === id));
      if (!roots.length || roots.some((entry) => !entry)) throw new Error("An entry no longer exists.");
      const included = new Set(rootIds);
      for (let changed = true; changed;) {
        changed = false;
        for (const entry of desktop.entries) if (entry.parentId && included.has(entry.parentId) && !included.has(entry.id)) { included.add(entry.id); changed = true; }
      }
      const entries = desktop.entries.filter((entry) => included.has(entry.id)).map((entry) => rootIds.includes(entry.id) ? { ...entry, parentId: null } : { ...entry });
      const contents = new Map<string, Blob>();
      await Promise.all(entries.map(async (entry) => { if (entry.kind === "file") contents.set(entry.id, await this.readFile(entry.id)); }));
      return { selectedRootIds: [...rootIds], entries, contents };
    });
  }

  pasteEntries(snapshot: ClipboardEntrySnapshot, parentId: string | null, rootNames: Map<string, string>, rootPositions: Map<string, EntryPosition>) {
    this.assertParent(parentId);
    const idMap = new Map(snapshot.entries.map((entry) => [entry.id, crypto.randomUUID()]));
    const now = Date.now();
    const entries = snapshot.entries.map((entry): DesktopEntry => {
      const isRoot = snapshot.selectedRootIds.includes(entry.id);
      const name = validateEntryName(isRoot ? rootNames.get(entry.id) ?? entry.name : entry.name);
      const nextParent = isRoot ? parentId : idMap.get(entry.parentId!);
      const position = parsePosition(isRoot ? rootPositions.get(entry.id) ?? entry.position : entry.position);
      return { ...entry, id: idMap.get(entry.id)!, name, parentId: nextParent ?? null, position, createdAt: now, modifiedAt: now };
    });
    const rootEntries = entries.filter((entry) => snapshot.selectedRootIds.some((id) => idMap.get(id) === entry.id));
    for (const [index, entry] of rootEntries.entries()) {
      assertUniqueName(this.current().entries, entry.name, parentId);
      if (rootEntries.slice(0, index).some((candidate) => namesMatch(candidate.name, entry.name))) throw new Error(`More than one copied item is named “${entry.name}”.`);
    }
    const contents = new Map<string, Blob>();
    for (const entry of snapshot.entries) if (entry.kind === "file") {
      const content = snapshot.contents.get(entry.id);
      if (!content || content.size !== entry.size) throw new Error(`The copied contents of “${entry.name}” are unavailable.`);
      contents.set(idMap.get(entry.id)!, content);
    }
    if (this.frontendOnly) return this.localMutation(() => this.storage.createEntries(entries, contents));
    return this.mutate({ kind: "create", entries }, (next) => entries.map((entry) => next.entries.find((item) => item.id === entry.id)!), contents);
  }

  updateEntryPosition(id: string, position: EntryPosition) {
    const parsedPosition = parsePosition(position);
    if (this.frontendOnly) return this.localMutation(() => this.storage.updateEntryPosition(id, position));
    const existing = this.current().entries.find((entry) => entry.id === id);
    if (!existing) throw new Error("That entry no longer exists.");
    const entry = { ...existing, position: parsedPosition };
    return this.mutate({ kind: "update-entry", entry }, (next) => next.entries.find((item) => item.id === id) as DesktopEntry);
  }

  updateRootEntryPositions(positionValues: RootEntryPositionUpdate[]) {
    const positions = parseRootEntryPositionUpdates(positionValues, this.current().entries);
    if (this.frontendOnly) return this.localMutation(() => this.storage.updateRootEntryPositions(positions));
    return this.mutate({ kind: "root-entry-positions", positions }, (next) => positions.map(({ entryId }) => next.entries.find((entry) => entry.id === entryId) as DesktopEntry));
  }

  saveTextFile(id: string, content: string) {
    if (this.frontendOnly) return this.localMutation(() => this.storage.saveTextFile(id, content));
    const existing = this.current().entries.find((entry): entry is FileEntry => entry.id === id && entry.kind === "file");
    if (!existing) throw new Error("That file no longer exists.");
    const entry = { ...existing, size: new Blob([content]).size, modifiedAt: Date.now() };
    return this.mutate({ kind: "save-content", entry }, (next) => next.entries.find((item) => item.id === id) as FileEntry, new Map([[id, new Blob([content], { type: existing.mimeType })]]));
  }

  saveDesktopLayout(layout: DesktopLayout) {
    const parsed = parseLayout(layout);
    if (this.frontendOnly) return this.localMutation(() => this.storage.saveDesktopLayout(parsed), false);
    return this.mutate({ kind: "layout", layout: parsed }, () => undefined);
  }

  saveEditorSettings(settings: EditorSettings) {
    if (this.frontendOnly) return this.localMutation(() => this.storage.saveEditorSettings(settings), false);
    return this.mutate({ kind: "editor-settings", settings }, () => undefined);
  }

  selectTheme(themeId: string) {
    parseThemeState({ ...this.current().appearance, selectedThemeId: themeId });
    if (this.frontendOnly) return this.localMutation(() => this.storage.selectTheme(themeId));
    return this.mutate({ kind: "select-theme", themeId }, (next) => next.appearance);
  }

  saveCustomTheme(value: CustomTheme) {
    const theme = parseCustomTheme(value);
    const exists = this.current().appearance.customThemes.some((item) => item.id === theme.id);
    parseThemeState({
      ...this.current().appearance,
      customThemes: exists
        ? this.current().appearance.customThemes.map((item) => item.id === theme.id ? theme : item)
        : [...this.current().appearance.customThemes, theme],
    });
    if (this.frontendOnly) return this.localMutation(() => this.storage.saveCustomTheme(theme));
    return this.mutate({ kind: "upsert-theme", theme }, (next) => next.appearance.customThemes.find((item) => item.id === theme.id)!);
  }

  deleteCustomTheme(themeId: string) {
    if (!this.current().appearance.customThemes.some((theme) => theme.id === themeId)) throw new Error("That custom theme no longer exists.");
    if (this.frontendOnly) return this.localMutation(() => this.storage.deleteCustomTheme(themeId));
    return this.mutate({ kind: "delete-theme", themeId }, (next) => next.appearance);
  }

  async readFile(id: FileEntry["id"]): Promise<File> {
    const entry = this.current().entries.find((candidate): candidate is FileEntry => candidate.id === id && candidate.kind === "file");
    if (!entry) throw new Error("That file no longer exists.");
    const catalogId = this.current().sync.catalogId;
    if (this.frontendOnly || !catalogId) return this.storage.readFile(id);

    const desktopId = this.desktopId;
    const contentRevision = this.current().sync.contentRevisions[id];
    const generation = this.generation;
    if (!Number.isSafeInteger(contentRevision)) throw new Error("That file has invalid synchronization metadata.");
    const cached = await this.storage.readCachedFile(desktopId, catalogId, id, contentRevision);
    if (cached) return cached;
    if (this.status === "offline") throw new VirtualFileUnavailableError();

    const key = `${desktopId}\n${catalogId}\n${id}\n${contentRevision}`;
    const existing = this.contentLoads.get(key);
    if (existing) return existing;
    const loading = (async () => {
      let response: Response;
      try {
        response = await this.fetchImpl(API_ROUTES.desktopContent(desktopId, id), { cache: "no-store" });
      } catch {
        this.setStatus("offline");
        throw new VirtualFileUnavailableError();
      }
      if (!response.ok) throw new Error(response.status === 404 ? "This file no longer exists on the server." : `The server contents of “${entry.name}” could not be loaded (${response.status}).`);
      const responseRevisionHeader = response.headers.get("X-Hiraya-Revision");
      const responseRevision = responseRevisionHeader === null ? Number.NaN : Number(responseRevisionHeader);
      if (!Number.isSafeInteger(responseRevision) || responseRevision !== contentRevision) throw new VirtualFileChangedError();
      const content = await response.blob();
      if (content.size !== entry.size) throw new Error(`The server contents of “${entry.name}” have an unexpected size.`);
      this.assertActive(generation);
      const stored = await this.storage.cacheRemoteFile(desktopId, catalogId, id, contentRevision, content);
      this.assertActive(generation);
      if (!stored) throw new VirtualFileChangedError();
      return stored;
    })();
    this.contentLoads.set(key, loading);
    try {
      return await loading;
    } finally {
      if (this.contentLoads.get(key) === loading) this.contentLoads.delete(key);
    }
  }

  async readFileByRelativePath(fromFileId: FileEntry["id"], relativePath: string) {
    const file = await this.storage.resolveFileByRelativePath(fromFileId, relativePath);
    return { file, blob: await this.readFile(file.id) };
  }
  async getOutboxStatus() {
    const records = await this.storage.readOutbox();
    return {
      pending: records.filter((record) => record.status === "pending").length,
      blocked: records.filter((record) => record.status === "blocked").length,
      records,
    };
  }

  async listActivity(query: ActivityQuery = {}) {
    const parsed = parseActivityQuery(query);
    if (this.frontendOnly) return parseActivityPage(await this.storage.listActivity(parsed));
    let response: Response;
    try {
      response = await this.fetchImpl(API_ROUTES.activity(parsed), { cache: "no-store" });
    } catch {
      this.setStatus("offline");
      throw new Error("Activity is unavailable while the Hiraya server is offline.");
    }
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(body?.error || `Activity could not be loaded (${response.status}).`);
    }
    return parseActivityPage(await response.json());
  }
}

const defaultEngine = new SyncEngine({ frontendOnly: import.meta.env.HIRAYA_FRONTEND_ONLY === "true" });

export const initializeDesktop = defaultEngine.start.bind(defaultEngine);
export const stopDesktopSync = defaultEngine.stop.bind(defaultEngine);
export const subscribeToSync = defaultEngine.subscribe.bind(defaultEngine);
export const createTextFile = defaultEngine.createTextFile.bind(defaultEngine);
export const createFolder = defaultEngine.createFolder.bind(defaultEngine);
export const importFiles = defaultEngine.importFiles.bind(defaultEngine);
export const renameEntry = defaultEngine.renameEntry.bind(defaultEngine);
export const deleteEntry = defaultEngine.deleteEntry.bind(defaultEngine);
export const deleteEntries = defaultEngine.deleteEntries.bind(defaultEngine);
export const moveEntry = defaultEngine.moveEntry.bind(defaultEngine);
export const moveEntries = defaultEngine.moveEntries.bind(defaultEngine);
export const transferEntries = defaultEngine.transferEntries.bind(defaultEngine);
export const createDesktop = defaultEngine.createDesktop.bind(defaultEngine);
export const listDesktops = defaultEngine.listDesktops.bind(defaultEngine);
export const subscribeToDesktopCatalog = defaultEngine.subscribeDesktopCatalog.bind(defaultEngine);
export const renameDesktop = defaultEngine.renameDesktop.bind(defaultEngine);
export const deleteDesktop = defaultEngine.deleteDesktop.bind(defaultEngine);
export const captureEntries = defaultEngine.captureEntries.bind(defaultEngine);
export const pasteEntries = defaultEngine.pasteEntries.bind(defaultEngine);
export const updateRootEntryPositions = defaultEngine.updateRootEntryPositions.bind(defaultEngine);
export const updateEntryPosition = defaultEngine.updateEntryPosition.bind(defaultEngine);
export const saveTextFile = defaultEngine.saveTextFile.bind(defaultEngine);
export const saveDesktopLayout = defaultEngine.saveDesktopLayout.bind(defaultEngine);
export const saveEditorSettings = defaultEngine.saveEditorSettings.bind(defaultEngine);
export const selectTheme = defaultEngine.selectTheme.bind(defaultEngine);
export const saveCustomTheme = defaultEngine.saveCustomTheme.bind(defaultEngine);
export const deleteCustomTheme = defaultEngine.deleteCustomTheme.bind(defaultEngine);
export const readFile = defaultEngine.readFile.bind(defaultEngine);
export const readFileByRelativePath = defaultEngine.readFileByRelativePath.bind(defaultEngine);
export const getOutboxStatus = defaultEngine.getOutboxStatus.bind(defaultEngine);
export const listActivity = defaultEngine.listActivity.bind(defaultEngine);
export const subscribeToActivityChanges = defaultEngine.subscribeActivityChanges.bind(defaultEngine);
