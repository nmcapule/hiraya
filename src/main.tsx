import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { bootstrapSession } from "./lib/auth";
import "./styles.css";

const frontendOnly = import.meta.env.HIRAYA_FRONTEND_ONLY === "true";

const root = document.getElementById("root")!;
root.innerHTML = `<main class="startup-state" role="status"><span class="brand-mark__shape"><span></span></span><div><strong>Hiraya</strong><span>Opening your desktop...</span></div></main>`;

async function retireUnscopedServiceWorker() {
  if (!import.meta.env.PROD || frontendOnly || localStorage.getItem("hiraya-auth-pwa-rollout-v1") === "complete") return;
  if (localStorage.getItem("hiraya-auth-pwa-rollout-v1") === "reloading") {
    localStorage.setItem("hiraya-auth-pwa-rollout-v1", "complete");
    return;
  }
  const controlled = "serviceWorker" in navigator && navigator.serviceWorker.controller !== null;
  if ("serviceWorker" in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.unregister()));
  }
  if ("caches" in window) {
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => caches.delete(key)));
  }
  if (controlled) {
    localStorage.setItem("hiraya-auth-pwa-rollout-v1", "reloading");
    window.location.reload();
    await new Promise<never>(() => undefined);
  }
  localStorage.setItem("hiraya-auth-pwa-rollout-v1", "complete");
}

async function start() {
  if (import.meta.env.DEV) {
    if ("serviceWorker" in navigator) void navigator.serviceWorker.getRegistrations().then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())));
    if ("caches" in window) void caches.keys().then((keys) => Promise.all(keys.map((key) => caches.delete(key))));
  }
  await retireUnscopedServiceWorker();
  const session = await bootstrapSession(frontendOnly);
  const { configureStorageNamespace, LOCAL_STORAGE_ID } = await import("./lib/opfs");
  await configureStorageNamespace(session?.storageId ?? LOCAL_STORAGE_ID);
  const { default: App } = await import("./App");
  createRoot(root).render(
    <StrictMode>
      <App session={session} />
    </StrictMode>,
  );
}

void start().catch((error: unknown) => {
  if (error instanceof Error && error.name === "AuthenticationRequiredError") return;
  root.innerHTML = `<main class="startup-error"><h1>Hiraya could not start</h1><p>${String(error instanceof Error ? error.message : error).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]!)}</p><button class="button button--primary" type="button">Reload Hiraya</button></main>`;
  root.querySelector("button")?.addEventListener("click", () => window.location.reload());
});
