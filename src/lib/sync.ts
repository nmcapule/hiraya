import type { SeededManifest } from "./seeded-manifest";
import * as storage from "./opfs";
import { assertUniqueName, namesMatch, validateEntryName } from "./entry-validation";
import { API_ROUTES } from "./api-routes";
import { parseLayout, parsePosition, parseRemoteWorkspace, parseRootDesktopPositions, type InitializedRemoteWorkspace, type RemoteEntry, type RemoteWorkspace } from "./contracts";
import type { DesktopEntry, DesktopLayout, DesktopPositionUpdate, EditorSettings, EntryPosition, FileEntry, FolderEntry } from "../types";
import type { OutboxOperation, OutboxRecord } from "./outbox";

export type SyncStatus = "connecting" | "online" | "offline" | "blocked" | "local";

type StorageBoundary = Pick<typeof storage,
  "applyRemoteDesktop" | "createFolder" | "createTextFile" | "deleteEntry" | "importFiles" | "loadDesktop" |
  "moveEntry" | "readCurrentDesktop" | "readDesktopSnapshot" | "readFile" | "readFileByRelativePath" |
  "renameEntry" | "saveDesktopLayout" | "saveEditorSettings" | "saveTextFile" | "updateEntryPosition"
  | "updateDesktopPositions" | "enqueueMutation" | "readOutbox" | "bindOutboxWorkspace" |
  "acknowledgeMutation" | "blockMutation" | "readPendingContent"
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

function localEntry(entry: RemoteEntry): DesktopEntry {
  const { revision: _revision, contentRevision: _contentRevision, ...local } = entry;
  void _revision;
  void _contentRevision;
  return local;
}

function toSnapshot(workspace: InitializedRemoteWorkspace): storage.DesktopSnapshot {
  const entryRevisions: Record<string, number> = {};
  const contentRevisions: Record<string, number> = {};
  for (const entry of workspace.entries) {
    entryRevisions[entry.id] = entry.revision;
    if (entry.kind === "file") contentRevisions[entry.id] = entry.contentRevision;
  }
  return {
    entries: workspace.entries.map(localEntry),
    layout: workspace.layout,
    editorSettings: workspace.editorSettings,
    sync: {
      workspaceId: workspace.workspaceId,
      revision: workspace.revision,
      entryRevisions,
      contentRevisions,
      layoutRevision: workspace.layoutRevision,
      settingsRevision: workspace.settingsRevision,
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
  private desktop: storage.DesktopSnapshot | null = null;
  private status: SyncStatus = "connecting";
  private events: EventSource | null = null;
  private healthTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  private work: Promise<unknown> = Promise.resolve();
  private startPromise: Promise<{ desktop: storage.DesktopSnapshot; status: SyncStatus }> | null = null;
  private running = false;
  private generation = 0;
  private pendingWork = 0;
  private readonly desktopListeners = new Set<(next: storage.DesktopSnapshot) => void>();
  private readonly statusListeners = new Set<(next: SyncStatus) => void>();
  private readonly activityListeners = new Set<(syncing: boolean) => void>();

  constructor(options: SyncEngineOptions = {}) {
    this.frontendOnly = options.frontendOnly ?? false;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.EventSourceImpl = options.eventSource ?? globalThis.EventSource;
    this.setIntervalImpl = options.setInterval ?? globalThis.setInterval.bind(globalThis);
    this.clearIntervalImpl = options.clearInterval ?? globalThis.clearInterval.bind(globalThis);
    this.storage = options.storage ?? storage;
  }

  start(viewport: EntryPosition, seeded: SeededManifest | null = null) {
    if (this.startPromise) return this.startPromise;
    this.running = true;
    const generation = ++this.generation;
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

  stop() {
    this.running = false;
    this.generation += 1;
    this.startPromise = null;
    this.events?.close();
    this.events = null;
    if (this.healthTimer !== null) this.clearIntervalImpl(this.healthTimer);
    this.healthTimer = null;
  }

  subscribe(onDesktop: (next: storage.DesktopSnapshot) => void, onStatus: (next: SyncStatus) => void, onActivity?: (syncing: boolean) => void) {
    this.desktopListeners.add(onDesktop);
    this.statusListeners.add(onStatus);
    if (onActivity) this.activityListeners.add(onActivity);
    onStatus(this.status);
    onActivity?.(!this.frontendOnly && this.pendingWork > 0);
    return () => {
      this.desktopListeners.delete(onDesktop);
      this.statusListeners.delete(onStatus);
      if (onActivity) this.activityListeners.delete(onActivity);
    };
  }

  private setStatus(next: SyncStatus) {
    if (this.status === next) return;
    this.status = next;
    for (const listener of this.statusListeners) listener(next);
  }

  private publish(next: storage.DesktopSnapshot) {
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
        for (const listener of this.activityListeners) listener(true);
      }
    }
    const next = this.work.then(operation, operation);
    this.work = next.then(() => undefined, () => undefined);
    return next.finally(() => {
      if (!this.frontendOnly) {
        this.pendingWork -= 1;
        if (this.pendingWork === 0) {
          for (const listener of this.activityListeners) listener(false);
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
      throw new SyncRequestError("The sync server is unavailable. The change remains queued.", null, false);
    }
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: string } | null;
      throw new SyncRequestError(body?.error || `The sync server rejected the request (${response.status}).`, response.status, response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429);
    }
    return response.json();
  }

  private async requestWorkspace(input: RequestInfo | URL, init?: RequestInit) {
    return parseRemoteWorkspace(await this.requestJson(input, init));
  }

  private fetchWorkspace() {
    return this.requestWorkspace(API_ROUTES.workspace, { cache: "no-store" });
  }

  private async applyWorkspace(workspace: RemoteWorkspace, generation = this.generation, acknowledgedOperationId?: string) {
    this.assertActive(generation);
    const desktop = this.current();
    if (!workspace.initialized) return desktop;
    const identityChanged = desktop.sync.workspaceId !== workspace.workspaceId;
    if (!identityChanged && workspace.revision <= desktop.sync.revision) return desktop;
    const next = toSnapshot(workspace);
    const contents = new Map<string, Blob>();
    await Promise.all(workspace.entries.map(async (entry) => {
      if (entry.kind !== "file" || (!identityChanged && desktop.sync.contentRevisions[entry.id] === entry.contentRevision)) return;
      const response = await this.fetchImpl(API_ROUTES.content(entry.id), { cache: "no-store" });
      if (!response.ok) throw new Error(`The server contents of “${entry.name}” could not be loaded.`);
      const blob = await response.blob();
      if (blob.size !== entry.size) throw new Error(`The server contents of “${entry.name}” have an unexpected size.`);
      contents.set(entry.id, blob);
    }));
    this.assertActive(generation);
    const applied = await this.storage.applyRemoteDesktop(next, contents, acknowledgedOperationId);
    this.assertActive(generation);
    this.publish(applied);
    return applied;
  }

  private async bootstrap(generation = this.generation) {
    this.assertActive(generation);
    const snapshot = await this.storage.readDesktopSnapshot();
    const pending = await this.storage.readOutbox();
    const form = new FormData();
    form.append("workspace", JSON.stringify({ entries: snapshot.entries, layout: snapshot.layout, editorSettings: snapshot.editorSettings }));
    for (const entry of snapshot.entries) {
      if (entry.kind !== "file") continue;
      const content = snapshot.contents.get(entry.id);
      if (!content) throw new Error(`The contents of “${entry.name}” could not be read for initial sync.`);
      form.append(`file-${entry.id}`, content, entry.name);
    }
    const lastPending = pending.at(-1);
    const workspace = await this.requestWorkspace(API_ROUTES.bootstrap, {
      method: "POST",
      headers: lastPending ? this.idempotencyHeaders(lastPending) : undefined,
      body: form,
    });
    this.assertActive(generation);
    if (!workspace.initialized) throw new Error("The sync server did not initialize the workspace.");
    for (const record of pending) await this.storage.acknowledgeMutation(record.operationId);
    return this.applyWorkspace(workspace, generation);
  }

  private async ensureServer(generation = this.generation) {
    const workspace = await this.fetchWorkspace();
    this.assertActive(generation);
    if (!workspace.initialized) return this.bootstrap(generation);
    await this.storage.bindOutboxWorkspace(workspace.workspaceId);
    return this.applyWorkspace(workspace, generation);
  }

  private async reconcile(acknowledgedOperationId?: string) {
    const generation = this.generation;
    const workspace = await this.fetchWorkspace();
    this.assertActive(generation);
    if (!workspace.initialized) return this.bootstrap(generation);
    await this.storage.bindOutboxWorkspace(workspace.workspaceId);
    return this.applyWorkspace(workspace, generation, acknowledgedOperationId);
  }

  private idempotencyHeaders(record: OutboxRecord, headers?: HeadersInit) {
    const result = new Headers(headers);
    result.set("X-Hiraya-Client-ID", record.clientId);
    result.set("X-Hiraya-Operation-ID", record.operationId);
    return result;
  }

  private async sendOutboxOperation(record: OutboxRecord) {
    const operation = record.operation;
    const headers = (value?: HeadersInit) => this.idempotencyHeaders(record, value);
    switch (operation.kind) {
      case "create": {
        if (operation.entries.length === 1) {
          const entry = operation.entries[0];
          const form = new FormData();
          form.append("entry", JSON.stringify(entry));
          if (entry.kind === "file") form.append("content", await this.storage.readPendingContent(record.operationId, entry.id), entry.name);
          await this.requestJson(API_ROUTES.entries, { method: "POST", headers: headers(), body: form });
        } else {
          const form = new FormData();
          form.append("entries", JSON.stringify(operation.entries));
          for (const entry of operation.entries) if (entry.kind === "file") form.append(`file-${entry.id}`, await this.storage.readPendingContent(record.operationId, entry.id), entry.name);
          await this.requestJson(API_ROUTES.imports, { method: "POST", headers: headers(), body: form });
        }
        return;
      }
      case "update-entry":
        await this.requestJson(API_ROUTES.entry(operation.entry.id), { method: "PATCH", headers: headers({ "Content-Type": "application/json" }), body: JSON.stringify(operation.entry) });
        return;
      case "delete":
        await this.requestJson(API_ROUTES.entry(operation.entryId), { method: "DELETE", headers: headers() });
        return;
      case "save-content":
        await this.requestJson(API_ROUTES.content(operation.entry.id), { method: "PUT", headers: headers({ "Content-Type": operation.entry.mimeType }), body: await this.storage.readPendingContent(record.operationId, operation.entry.id) });
        return;
      case "desktop-positions":
        await this.requestJson(API_ROUTES.desktopPositions, { method: "PUT", headers: headers({ "Content-Type": "application/json" }), body: JSON.stringify(operation.positions) });
        return;
      case "layout":
        await this.requestJson(API_ROUTES.layout, { method: "PUT", headers: headers({ "Content-Type": "application/json" }), body: JSON.stringify(operation.layout) });
        return;
      case "editor-settings":
        await this.requestJson(API_ROUTES.editorSettings, { method: "PUT", headers: headers({ "Content-Type": "application/json" }), body: JSON.stringify(operation.settings) });
    }
  }

  private async replayOutbox(generation = this.generation) {
    for (const record of await this.storage.readOutbox()) {
      this.assertActive(generation);
      if (record.status === "blocked") throw new SyncRequestError(record.error ?? "A pending change is blocked.", 409, true);
      try {
        await this.sendOutboxOperation(record);
        await this.reconcile(record.operationId);
        await this.storage.acknowledgeMutation(record.operationId);
      } catch (error) {
        if (error instanceof SyncRequestError && error.permanent) await this.storage.blockMutation(record.operationId, error.message);
        throw error;
      }
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
      void this.queue(() => this.reconcile()).then(() => {
        return this.replayOutbox();
      }).then(() => {
        if (this.running) this.setStatus("online");
      }).catch((error) => {
        if (this.running) this.setStatus(error instanceof SyncRequestError && error.permanent ? "blocked" : "offline");
      });
    };
    events.onerror = () => { if (this.running && this.status !== "blocked") this.setStatus("offline"); };
    events.addEventListener("workspace", (event) => {
      if (!this.running) return;
      if (this.status === "blocked") return;
      let revision = Number.NaN;
      let workspaceId = "";
      try {
        const data = JSON.parse((event as MessageEvent<string>).data) as unknown;
        if (typeof data === "object" && data !== null && "revision" in data) {
          revision = Number((data as { revision: unknown }).revision);
          workspaceId = "workspaceId" in data && typeof data.workspaceId === "string" ? data.workspaceId : "";
        }
      } catch {
        return;
      }
      if (!Number.isSafeInteger(revision) || (workspaceId === this.current().sync.workspaceId && revision <= this.current().sync.revision)) return;
      void this.queue(() => this.reconcile()).catch(() => {
        if (this.running) this.setStatus("offline");
      });
    });
    if (this.healthTimer !== null) this.clearIntervalImpl(this.healthTimer);
    this.healthTimer = this.setIntervalImpl(() => { void this.checkHealth(); }, 5_000);
  }

  private async checkHealth() {
    if (!this.running) return;
    try {
      const response = await this.fetchImpl(API_ROUTES.health, { cache: "no-store" });
      if (!response.ok) throw new Error("unhealthy");
      const health = await response.json() as unknown;
      const revision = typeof health === "object" && health !== null && "revision" in health ? Number((health as { revision: unknown }).revision) : Number.NaN;
      const workspaceId = typeof health === "object" && health !== null && "workspaceId" in health && typeof health.workspaceId === "string" ? health.workspaceId : "";
      if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("invalid health response");
      if (this.status === "blocked") return;
      const wasOffline = this.status === "offline";
      if (wasOffline) this.setStatus("connecting");
      if (wasOffline || workspaceId !== this.current().sync.workspaceId || revision > this.current().sync.revision) await this.queue(async () => {
        await this.reconcile();
        await this.replayOutbox();
      });
      if (this.running) this.setStatus("online");
    } catch (error) {
      if (this.running) this.setStatus(error instanceof SyncRequestError && error.permanent ? "blocked" : "offline");
    }
  }

  private async mutate<T>(operation: OutboxOperation, select: (next: storage.DesktopSnapshot) => T, contents?: Map<string, Blob>) {
    return this.queue(async () => {
      const queued = await this.storage.enqueueMutation(operation, contents);
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
    const entry: FileEntry = { kind: "file", id: crypto.randomUUID(), name, parentId, mimeType: "text/plain", size: 0, modifiedAt: Date.now(), position: parsedPosition };
    return this.mutate({ kind: "create", entries: [entry] }, (next) => next.entries.find((item) => item.id === entry.id) as FileEntry, new Map([[entry.id, new Blob([], { type: entry.mimeType })]]));
  }

  createFolder(nameValue: string, parentId: string | null, position: EntryPosition) {
    if (this.frontendOnly) return this.localMutation(() => this.storage.createFolder(nameValue, parentId, position));
    const parsedPosition = parsePosition(position);
    const name = validateEntryName(nameValue);
    this.assertParent(parentId);
    assertUniqueName(this.current().entries, name, parentId);
    const entry: FolderEntry = { kind: "folder", id: crypto.randomUUID(), name, parentId, modifiedAt: Date.now(), position: parsedPosition };
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
    const entries: FileEntry[] = files.map((file, index) => ({ kind: "file", id: crypto.randomUUID(), name: names[index], parentId, mimeType: file.type || "application/octet-stream", size: file.size, modifiedAt: file.lastModified || Date.now(), position: parsedPositions[index] }));
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

  moveEntry(id: string, parentId: string | null, position: EntryPosition) {
    if (this.frontendOnly) return this.localMutation(() => this.storage.moveEntry(id, parentId, position));
    const parsedPosition = parsePosition(position);
    const existing = this.current().entries.find((entry) => entry.id === id);
    if (!existing) throw new Error("That entry no longer exists.");
    this.assertParent(parentId);
    const entry = { ...existing, parentId, position: parsedPosition };
    return this.mutate({ kind: "update-entry", entry }, (next) => next.entries.find((item) => item.id === id) as DesktopEntry);
  }

  updateEntryPosition(id: string, position: EntryPosition) {
    const parsedPosition = parsePosition(position);
    if (this.frontendOnly) return this.localMutation(() => this.storage.updateEntryPosition(id, position));
    const existing = this.current().entries.find((entry) => entry.id === id);
    if (!existing) throw new Error("That entry no longer exists.");
    const entry = { ...existing, position: parsedPosition };
    return this.mutate({ kind: "update-entry", entry }, (next) => next.entries.find((item) => item.id === id) as DesktopEntry);
  }

  updateDesktopPositions(positionValues: DesktopPositionUpdate[]) {
    const positions = parseRootDesktopPositions(positionValues, this.current().entries);
    if (this.frontendOnly) return this.localMutation(() => this.storage.updateDesktopPositions(positions));
    return this.mutate({ kind: "desktop-positions", positions }, (next) => positions.map(({ entryId }) => next.entries.find((entry) => entry.id === entryId) as DesktopEntry));
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

  readFile(id: FileEntry["id"]) { return this.storage.readFile(id); }
  readFileByRelativePath(fromFileId: FileEntry["id"], relativePath: string) { return this.storage.readFileByRelativePath(fromFileId, relativePath); }
  async getOutboxStatus() {
    const records = await this.storage.readOutbox();
    return {
      pending: records.filter((record) => record.status === "pending").length,
      blocked: records.filter((record) => record.status === "blocked").length,
      records,
    };
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
export const moveEntry = defaultEngine.moveEntry.bind(defaultEngine);
export const updateDesktopPositions = defaultEngine.updateDesktopPositions.bind(defaultEngine);
export const updateEntryPosition = defaultEngine.updateEntryPosition.bind(defaultEngine);
export const saveTextFile = defaultEngine.saveTextFile.bind(defaultEngine);
export const saveDesktopLayout = defaultEngine.saveDesktopLayout.bind(defaultEngine);
export const saveEditorSettings = defaultEngine.saveEditorSettings.bind(defaultEngine);
export const readFile = defaultEngine.readFile.bind(defaultEngine);
export const readFileByRelativePath = defaultEngine.readFileByRelativePath.bind(defaultEngine);
export const getOutboxStatus = defaultEngine.getOutboxStatus.bind(defaultEngine);
