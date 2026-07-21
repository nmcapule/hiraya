import type { SeededManifest } from "./seeded-manifest";
import * as storage from "./opfs";
import { assertUniqueName, namesMatch, validateEntryName } from "./entry-validation";
import { API_ROUTES } from "./api-routes";
import { parseLayout, parsePosition, parseRemoteWorkspace, parseRootDesktopPositions, type InitializedRemoteWorkspace, type RemoteEntry, type RemoteWorkspace } from "./contracts";
import type { DesktopEntry, DesktopLayout, DesktopPositionUpdate, EditorSettings, EntryPosition, FileEntry, FolderEntry } from "../types";

export type SyncStatus = "connecting" | "online" | "offline" | "local";

type StorageBoundary = Pick<typeof storage,
  "applyRemoteDesktop" | "createFolder" | "createTextFile" | "deleteEntry" | "importFiles" | "loadDesktop" |
  "moveEntry" | "readCurrentDesktop" | "readDesktopSnapshot" | "readFile" | "readFileByRelativePath" |
  "renameEntry" | "saveDesktopLayout" | "saveEditorSettings" | "saveTextFile" | "updateEntryPosition"
  | "updateDesktopPositions"
>;

export type SyncEngineOptions = {
  frontendOnly?: boolean;
  fetch?: typeof fetch;
  eventSource?: typeof EventSource;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
  storage?: StorageBoundary;
};

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
  private initialized = false;
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
      this.initialized = true;
      this.setStatus("local");
      return { desktop: this.desktop, status: this.status };
    }
    this.setStatus("connecting");
    try {
      await this.ensureServer(generation);
      this.setStatus("online");
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
      throw new Error("The sync server is unavailable. Changes are disabled until it reconnects.");
    }
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(body?.error || `The sync server rejected the request (${response.status}).`);
    }
    return response.json();
  }

  private async requestWorkspace(input: RequestInfo | URL, init?: RequestInit) {
    return parseRemoteWorkspace(await this.requestJson(input, init));
  }

  private fetchWorkspace() {
    return this.requestWorkspace(API_ROUTES.workspace, { cache: "no-store" });
  }

  private async applyWorkspace(workspace: RemoteWorkspace, generation = this.generation) {
    this.assertActive(generation);
    const desktop = this.current();
    this.initialized = workspace.initialized;
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
    const applied = await this.storage.applyRemoteDesktop(next, contents);
    this.assertActive(generation);
    this.publish(applied);
    return applied;
  }

  private async bootstrap(generation = this.generation) {
    this.assertActive(generation);
    const snapshot = await this.storage.readDesktopSnapshot();
    const form = new FormData();
    form.append("workspace", JSON.stringify({ entries: snapshot.entries, layout: snapshot.layout, editorSettings: snapshot.editorSettings }));
    for (const entry of snapshot.entries) {
      if (entry.kind !== "file") continue;
      const content = snapshot.contents.get(entry.id);
      if (!content) throw new Error(`The contents of “${entry.name}” could not be read for initial sync.`);
      form.append(`file-${entry.id}`, content, entry.name);
    }
    const workspace = await this.requestWorkspace(API_ROUTES.bootstrap, { method: "POST", body: form });
    this.assertActive(generation);
    if (!workspace.initialized) throw new Error("The sync server did not initialize the workspace.");
    this.initialized = true;
    return this.applyWorkspace(workspace, generation);
  }

  private async ensureServer(generation = this.generation) {
    const workspace = await this.fetchWorkspace();
    this.assertActive(generation);
    if (!workspace.initialized) return this.bootstrap(generation);
    this.initialized = true;
    return this.applyWorkspace(workspace, generation);
  }

  private async reconcile() {
    const generation = this.generation;
    const workspace = await this.fetchWorkspace();
    this.assertActive(generation);
    if (!workspace.initialized) return this.bootstrap(generation);
    return this.applyWorkspace(workspace, generation);
  }

  private startEvents() {
    if (!this.EventSourceImpl) throw new Error("Server events are unavailable in this browser.");
    this.events?.close();
    const events = new this.EventSourceImpl(API_ROUTES.events);
    this.events = events;
    events.onopen = () => {
      if (!this.running) return;
      if (this.status !== "online") this.setStatus("connecting");
      void this.queue(() => this.reconcile()).then(() => {
        if (this.running) this.setStatus("online");
      }).catch(() => {
        if (this.running) this.setStatus("offline");
      });
    };
    events.onerror = () => { if (this.running) this.setStatus("offline"); };
    events.addEventListener("workspace", (event) => {
      if (!this.running) return;
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
      const wasOffline = this.status === "offline";
      if (wasOffline) this.setStatus("connecting");
      if (wasOffline || workspaceId !== this.current().sync.workspaceId || revision > this.current().sync.revision) await this.queue(() => this.reconcile());
      if (this.running) this.setStatus("online");
    } catch {
      if (this.running) this.setStatus("offline");
    }
  }

  private async mutate<T>(operation: () => Promise<void>, select: (next: storage.DesktopSnapshot) => T) {
    return this.queue(async () => {
      if (!this.initialized) await this.ensureServer();
      try {
        await operation();
      } catch (error) {
        await this.reconcile().catch(() => undefined);
        throw error;
      }
      return select(await this.reconcile());
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

  private async postEntry(entry: DesktopEntry, content?: Blob) {
    const form = new FormData();
    form.append("entry", JSON.stringify(entry));
    if (content) form.append("content", content, entry.name);
    await this.requestJson(API_ROUTES.entries, { method: "POST", body: form });
  }

  createTextFile(nameValue: string, parentId: string | null, position: EntryPosition) {
    if (this.frontendOnly) return this.localMutation(() => this.storage.createTextFile(nameValue, parentId, position));
    const parsedPosition = parsePosition(position);
    const name = validateEntryName(nameValue);
    this.assertParent(parentId);
    assertUniqueName(this.current().entries, name, parentId);
    const entry: FileEntry = { kind: "file", id: crypto.randomUUID(), name, parentId, mimeType: "text/plain", size: 0, modifiedAt: Date.now(), position: parsedPosition };
    return this.mutate(() => this.postEntry(entry, new Blob([], { type: entry.mimeType })), (next) => next.entries.find((item) => item.id === entry.id) as FileEntry);
  }

  createFolder(nameValue: string, parentId: string | null, position: EntryPosition) {
    if (this.frontendOnly) return this.localMutation(() => this.storage.createFolder(nameValue, parentId, position));
    const parsedPosition = parsePosition(position);
    const name = validateEntryName(nameValue);
    this.assertParent(parentId);
    assertUniqueName(this.current().entries, name, parentId);
    const entry: FolderEntry = { kind: "folder", id: crypto.randomUUID(), name, parentId, modifiedAt: Date.now(), position: parsedPosition };
    return this.mutate(() => this.postEntry(entry), (next) => next.entries.find((item) => item.id === entry.id) as FolderEntry);
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
    return this.mutate(async () => {
      const form = new FormData();
      form.append("entries", JSON.stringify(entries));
      for (const [index, entry] of entries.entries()) form.append(`file-${entry.id}`, files[index], entry.name);
      await this.requestJson(API_ROUTES.imports, { method: "POST", body: form });
    }, (next) => entries.map((entry) => next.entries.find((item) => item.id === entry.id) as FileEntry));
  }

  renameEntry(id: string, nameValue: string) {
    if (this.frontendOnly) return this.localMutation(() => this.storage.renameEntry(id, nameValue));
    const existing = this.current().entries.find((entry) => entry.id === id);
    if (!existing) throw new Error("That entry no longer exists.");
    const name = validateEntryName(nameValue);
    assertUniqueName(this.current().entries, name, existing.parentId, id);
    return this.mutate(() => this.requestJson(API_ROUTES.entry(id), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...existing, name }) }).then(() => undefined), (next) => next.entries.find((item) => item.id === id) as DesktopEntry);
  }

  deleteEntry(id: string) {
    if (this.frontendOnly) return this.localMutation(() => this.storage.deleteEntry(id));
    const before = this.current().entries;
    if (!before.some((entry) => entry.id === id)) throw new Error("That entry no longer exists.");
    return this.mutate(() => this.requestJson(API_ROUTES.entry(id), { method: "DELETE" }).then(() => undefined), (next) => before.filter((entry) => !next.entries.some((item) => item.id === entry.id)));
  }

  moveEntry(id: string, parentId: string | null, position: EntryPosition) {
    if (this.frontendOnly) return this.localMutation(() => this.storage.moveEntry(id, parentId, position));
    const parsedPosition = parsePosition(position);
    const existing = this.current().entries.find((entry) => entry.id === id);
    if (!existing) throw new Error("That entry no longer exists.");
    this.assertParent(parentId);
    const entry = { ...existing, parentId, position: parsedPosition };
    return this.mutate(() => this.requestJson(API_ROUTES.entry(id), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(entry) }).then(() => undefined), (next) => next.entries.find((item) => item.id === id) as DesktopEntry);
  }

  updateEntryPosition(id: string, position: EntryPosition) {
    const parsedPosition = parsePosition(position);
    if (this.frontendOnly) return this.localMutation(() => this.storage.updateEntryPosition(id, position));
    const existing = this.current().entries.find((entry) => entry.id === id);
    if (!existing) throw new Error("That entry no longer exists.");
    const entry = { ...existing, position: parsedPosition };
    return this.mutate(() => this.requestJson(API_ROUTES.entry(id), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(entry) }).then(() => undefined), (next) => next.entries.find((item) => item.id === id) as DesktopEntry);
  }

  updateDesktopPositions(positionValues: DesktopPositionUpdate[]) {
    const positions = parseRootDesktopPositions(positionValues, this.current().entries);
    if (this.frontendOnly) return this.localMutation(() => this.storage.updateDesktopPositions(positions));
    return this.mutate(() => this.requestJson(API_ROUTES.desktopPositions, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(positions),
    }).then(() => undefined), (next) => positions.map(({ entryId }) => next.entries.find((entry) => entry.id === entryId) as DesktopEntry));
  }

  saveTextFile(id: string, content: string) {
    if (this.frontendOnly) return this.localMutation(() => this.storage.saveTextFile(id, content));
    const existing = this.current().entries.find((entry): entry is FileEntry => entry.id === id && entry.kind === "file");
    if (!existing) throw new Error("That file no longer exists.");
    return this.mutate(() => this.requestJson(API_ROUTES.content(id), { method: "PUT", headers: { "Content-Type": existing.mimeType }, body: content }).then(() => undefined), (next) => next.entries.find((item) => item.id === id) as FileEntry);
  }

  saveDesktopLayout(layout: DesktopLayout) {
    const parsed = parseLayout(layout);
    if (this.frontendOnly) return this.localMutation(() => this.storage.saveDesktopLayout(parsed), false);
    return this.mutate(() => this.requestJson(API_ROUTES.layout, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(parsed) }).then(() => undefined), () => undefined);
  }

  saveEditorSettings(settings: EditorSettings) {
    if (this.frontendOnly) return this.localMutation(() => this.storage.saveEditorSettings(settings), false);
    return this.mutate(() => this.requestJson(API_ROUTES.editorSettings, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings) }).then(() => undefined), () => undefined);
  }

  readFile(id: FileEntry["id"]) { return this.storage.readFile(id); }
  readFileByRelativePath(fromFileId: FileEntry["id"], relativePath: string) { return this.storage.readFileByRelativePath(fromFileId, relativePath); }
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
