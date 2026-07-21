import { registerSW } from "virtual:pwa-register";

export type UpdateCheckResult = "available" | "current" | "unsupported";

export type PwaUpdater = {
  supported: boolean;
  check: () => Promise<UpdateCheckResult>;
  activate: () => Promise<void>;
  dispose: () => void;
};

type Options = {
  onUpdateAvailable: () => void;
  onError: (error: unknown) => void;
};

function waitForInstall(worker: ServiceWorker) {
  if (worker.state === "installed" || worker.state === "redundant") return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onStateChange = () => {
      if (worker.state !== "installed" && worker.state !== "redundant") return;
      worker.removeEventListener("statechange", onStateChange);
      resolve();
    };
    worker.addEventListener("statechange", onStateChange);
  });
}

export function createPwaUpdater({ onUpdateAvailable, onError }: Options): PwaUpdater {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) {
    return {
      supported: false,
      check: async () => "unsupported",
      activate: async () => undefined,
      dispose: () => undefined,
    };
  }

  let registration: ServiceWorkerRegistration | undefined;
  let disposed = false;
  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh: () => { if (!disposed) onUpdateAvailable(); },
    onRegisteredSW: (_url, nextRegistration) => { registration = nextRegistration; },
    onRegisterError: (error) => { if (!disposed) onError(error); },
  });

  return {
    supported: true,
    async check() {
      if (!registration) registration = await navigator.serviceWorker.ready;
      if (registration.waiting) {
        onUpdateAvailable();
        return "available";
      }
      await registration.update();
      const installing = registration.installing;
      if (installing) await waitForInstall(installing);
      if (registration.waiting) {
        onUpdateAvailable();
        return "available";
      }
      return "current";
    },
    activate: () => updateSW(true),
    dispose() { disposed = true; },
  };
}
