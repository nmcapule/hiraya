import type { LaunchContext, WindowState } from "@hiraya/apps-contracts";
import { AppDialogService, type AppDialogApi } from "./dialogs";
import { AppLifecycleService, type AppWindowApi } from "./lifecycle";
import { AppNotificationService, type AppNotificationApi } from "./notifications";
import { AppMemoryStorageService, type AppStorageApi } from "./storage";
import { AppThemeService } from "./theme";
import { unavailable, type AppInstanceOwner } from "./types";

export interface AppHostContext {
  readonly owner: AppInstanceOwner;
  readonly app: { getLaunchContext(): Promise<LaunchContext> };
  readonly window: AppWindowApi;
  readonly dialogs: AppDialogApi;
  readonly notifications: AppNotificationApi;
  readonly theme: {
    get(): Promise<LaunchContext["theme"]>;
    subscribe(listener: (theme: LaunchContext["theme"]) => void): () => void;
  };
  readonly storage: AppStorageApi;
  close(): void;
}

export type OpenAppInstance = {
  instanceId: string;
  launch: LaunchContext;
  window: WindowState;
  title: string;
};

export class AppHostServices {
  readonly dialogs = new AppDialogService();
  readonly notifications = new AppNotificationService();
  readonly storage: { forInstance(owner: AppInstanceOwner): AppStorageApi };

  constructor(
    readonly lifecycle: AppLifecycleService,
    readonly theme: AppThemeService,
    storage: { forInstance(owner: AppInstanceOwner): AppStorageApi } = new AppMemoryStorageService(),
  ) {
    this.storage = storage;
  }

  openInstance(input: OpenAppInstance): AppHostContext {
    const owner = Object.freeze({ appId: input.launch.appId, instanceId: input.instanceId });
    const launch = structuredClone(input.launch);
    const windowApi = this.lifecycle.open(owner, input.window, input.title);
    const dialogApi = this.dialogs.forInstance(owner);
    const notificationApi = this.notifications.forInstance(owner);
    const storageApi = this.storage.forInstance(owner);
    let closed = false;
    const cleanups = new Set<() => void>();
    const assertOpen = () => {
      if (closed) throw unavailable(owner);
    };
    return {
      owner,
      app: { getLaunchContext: async () => { assertOpen(); return structuredClone(launch); } },
      window: windowApi,
      dialogs: {
        openFile: async (params) => { assertOpen(); return dialogApi.openFile(params); },
        openFolder: async () => { assertOpen(); return dialogApi.openFolder(); },
        saveFile: async (params) => { assertOpen(); return dialogApi.saveFile(params); },
        confirm: async (params) => { assertOpen(); return dialogApi.confirm(params); },
      },
      notifications: {
        show: async (params) => { assertOpen(); return notificationApi.show(params); },
        dismiss: async (id) => { assertOpen(); return notificationApi.dismiss(id); },
      },
      theme: {
        get: async () => { assertOpen(); return this.theme.get(); },
        subscribe: (listener) => {
          assertOpen();
          const unsubscribe = this.theme.subscribe(listener);
          cleanups.add(unsubscribe);
          return () => {
            cleanups.delete(unsubscribe);
            unsubscribe();
          };
        },
      },
      storage: {
        get: async (key) => { assertOpen(); return storageApi.get(key); },
        set: async (key, value) => { assertOpen(); return storageApi.set(key, value); },
        remove: async (key) => { assertOpen(); return storageApi.remove(key); },
        clear: async () => { assertOpen(); return storageApi.clear(); },
      },
      close: () => {
        if (closed) return;
        closed = true;
        for (const cleanup of cleanups) cleanup();
        cleanups.clear();
        this.dialogs.closeInstance(owner);
        this.notifications.closeInstance(owner);
        this.lifecycle.closeInstance(owner);
      },
    };
  }
}
