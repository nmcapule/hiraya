import { APPS_PROTOCOL_VERSION, parseAppConnect, parseAppReady } from "@hiraya/apps-contracts";
import type { AppPackageInspection } from "@hiraya/app-cli";
import { RpcDispatcher } from "./dispatcher";

export type MaterializedApp = { url: string; revoke(): void };

export class ObjectUrlLease {
  readonly #urls: string[] = [];
  #revoked = false;

  constructor(private readonly urls: Pick<typeof URL, "createObjectURL" | "revokeObjectURL"> = URL) {}

  create(blob: Blob): string {
    if (this.#revoked) throw new Error("Object URL lease is closed.");
    const url = this.urls.createObjectURL(blob);
    this.#urls.push(url);
    return url;
  }

  revoke(): void {
    if (this.#revoked) return;
    this.#revoked = true;
    for (const url of this.#urls) this.urls.revokeObjectURL(url);
    this.#urls.length = 0;
  }
}

const CSP = "default-src 'none'; script-src data: 'unsafe-inline'; style-src data: 'unsafe-inline'; img-src data:; font-src data:; media-src data:; connect-src 'none'; frame-src data:; object-src 'none'; base-uri 'none'; form-action 'none'";
const MAX_MATERIALIZED_ASSET_CHARACTERS = 64 * 1024 * 1024;

export function createPackageAssetResolver(files: ReadonlyMap<string, Uint8Array>, entrypoint: string) {
  const assetURLs = new Map<string, string>();
  const resolving = new Set<string>();
  let materializedCharacters = 0;
  const resolve = (path: string): string | undefined => {
    const existing = assetURLs.get(path);
    if (existing) return existing;
    const bytes = files.get(path);
    if (!bytes || path === entrypoint) return undefined;
    if (resolving.has(path)) throw new TypeError(`Package asset dependency cycle is not supported: ${path}.`);
    resolving.add(path);
    let body = bytes;
    if (/\.(?:m?js|css)$/i.test(path)) {
      let text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const pattern = /(?:\b(?:import|export)\s+(?:[^"'();]*?\sfrom\s*)?|\bimport\s*\(\s*|@import\s+(?:url\(\s*)?|url\(\s*)(["']?)([^"')\s;]+)\1/g;
      text = text.replace(pattern, (match, _quote: string, reference: string) => {
        const target = resolvePackagePath(reference, path);
        const replacement = target ? resolve(target) : undefined;
        return replacement ? match.replace(reference, replacement) : match;
      });
      body = new TextEncoder().encode(text);
    }
    resolving.delete(path);
    const url = dataURL(body, mimeType(path));
    materializedCharacters += url.length;
    if (materializedCharacters > MAX_MATERIALIZED_ASSET_CHARACTERS) throw new TypeError("Package assets are too large to materialize safely.");
    assetURLs.set(path, url);
    return url;
  };
  return resolve;
}

export function materializeAppPackage(pkg: AppPackageInspection, urls: Pick<typeof URL, "createObjectURL" | "revokeObjectURL"> = URL): MaterializedApp {
  const lease = new ObjectUrlLease(urls);
  const make = (blob: Blob) => lease.create(blob);
  const resolve = createPackageAssetResolver(pkg.files, pkg.manifest.entrypoint);
  const source = new TextDecoder("utf-8", { fatal: true }).decode(pkg.files.get(pkg.manifest.entrypoint)!);
  const document = new DOMParser().parseFromString(source, "text/html");
  document.querySelectorAll("base").forEach((element) => element.remove());
  document.querySelectorAll("iframe, frame, object, embed").forEach((element) => element.remove());
  const meta = document.createElement("meta");
  meta.httpEquiv = "Content-Security-Policy";
  meta.content = CSP;
  document.head.prepend(meta);
  for (const element of document.querySelectorAll<HTMLElement>("[src], [href], [poster]")) {
    for (const attribute of ["src", "href", "poster"]) {
      const reference = element.getAttribute(attribute);
      if (!reference || reference.startsWith("#") || reference.startsWith("data:")) continue;
      const path = resolvePackagePath(reference, pkg.manifest.entrypoint);
      const replacement = path ? resolve(path) : undefined;
      if (replacement) element.setAttribute(attribute, replacement);
      else element.removeAttribute(attribute);
    }
  }
  for (const element of document.querySelectorAll<HTMLElement>("script:not([src]), style")) {
    const path = pkg.manifest.entrypoint;
    element.textContent = (element.textContent ?? "").replace(/(?:\b(?:import|export)\s+(?:[^"'();]*?\sfrom\s*)?|\bimport\s*\(\s*|url\(\s*)(["']?)([^"')\s]+)\1/g, (match, _quote: string, reference: string) => {
      const target = resolvePackagePath(reference, path);
      const replacement = target ? resolve(target) : undefined;
      return replacement ? match.replace(reference, replacement) : match;
    });
  }
  for (const element of document.querySelectorAll<HTMLElement>("[style]")) {
    const style = element.getAttribute("style") ?? "";
    element.setAttribute("style", style.replace(/url\(\s*(["']?)([^"')\s]+)\1/g, (match, _quote: string, reference: string) => {
      const target = resolvePackagePath(reference, pkg.manifest.entrypoint);
      const replacement = target ? resolve(target) : undefined;
      return replacement ? match.replace(reference, replacement) : match;
    }));
  }
  const html = `<!doctype html>\n${document.documentElement.outerHTML}`;
  const url = make(new Blob([html], { type: "text/html" }));
  let revoked = false;
  return { url, revoke: () => { if (revoked) return; revoked = true; lease.revoke(); } };
}

export function isAppPackageName(name: string): boolean {
  return name.toLowerCase().endsWith(".hiraya.app");
}

export function initializeSandboxFrame(frame: HTMLIFrameElement, appId: string, dispatcher: RpcDispatcher, timeoutMs = 10_000): () => void {
  let disposed = false;
  let channel: MessageChannel | null = null;
  let timer = 0;
  const onConnect = (event: MessageEvent<unknown>) => {
    if (disposed || channel || event.source !== frame.contentWindow || !frame.contentWindow) return;
    let connect;
    try {
      connect = parseAppConnect(event.data);
      if (connect.appId !== appId) throw new TypeError("App handshake does not match the launched package.");
    } catch {
      return;
    }
    channel = new MessageChannel();
    const nonce = crypto.randomUUID().replaceAll("-", "");
    const onReady = (event: MessageEvent<unknown>) => {
      try {
        const ready = parseAppReady(event.data);
        if (ready.appId !== appId || ready.nonce !== nonce) throw new TypeError("App handshake does not match the launched package.");
        clearTimeout(timer);
        channel?.port1.removeEventListener("message", onReady);
        dispatcher.attach(channel!.port1);
      } catch { dispose(); }
    };
    channel.port1.addEventListener("message", onReady);
    channel.port1.start();
    timer = setTimeout(dispose, timeoutMs) as unknown as number;
    frame.contentWindow.postMessage({ protocolVersion: APPS_PROTOCOL_VERSION, type: "hiraya:init", appId, nonce }, "*", [channel.port2]);
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(timer);
    window.removeEventListener("message", onConnect);
    channel?.port1.close();
    channel?.port2.close();
    dispatcher.dispose();
  };
  window.addEventListener("message", onConnect);
  return dispose;
}

function resolvePackagePath(reference: string, from: string): string | null {
  try {
    const url = new URL(reference, `https://package.invalid/${from}`);
    if (url.origin !== "https://package.invalid") return null;
    return decodeURIComponent(url.pathname.slice(1));
  } catch { return null; }
}

function mimeType(path: string): string {
  if (/\.m?js$/i.test(path)) return "text/javascript";
  if (/\.css$/i.test(path)) return "text/css";
  if (/\.svg$/i.test(path)) return "image/svg+xml";
  if (/\.json$/i.test(path)) return "application/json";
  if (/\.png$/i.test(path)) return "image/png";
  if (/\.jpe?g$/i.test(path)) return "image/jpeg";
  if (/\.webp$/i.test(path)) return "image/webp";
  if (/\.gif$/i.test(path)) return "image/gif";
  if (/\.woff2?$/i.test(path)) return path.toLowerCase().endsWith(".woff2") ? "font/woff2" : "font/woff";
  return "application/octet-stream";
}

function dataURL(bytes: Uint8Array, type: string): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return `data:${type};base64,${btoa(binary)}`;
}
