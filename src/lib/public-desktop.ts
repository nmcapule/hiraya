import type { FileEntry } from "../types";
import { API_ROUTES } from "./api-routes";
import { isRecord, parseContentAccessDescriptor, parsePublicDesktopState, type RemoteDesktopState } from "./contracts";

export class LargeDownloadAuthRequiredError extends Error {
  constructor(readonly loginUrl: string) {
    super("Sign in to download this large file.");
    this.name = "LargeDownloadAuthRequiredError";
  }
}

export function publicTokenFromPath(pathname: string) {
  const match = /^\/shared\/([^/]+)\/?$/.exec(pathname);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return null; }
}

async function largeDownloadError(response: Response) {
  if (response.status !== 401) return null;
  const body = await response.clone().json().catch(() => null) as unknown;
  if (isRecord(body) && body.code === "large_download_auth_required" && typeof body.loginUrl === "string") return new LargeDownloadAuthRequiredError(body.loginUrl);
  return new Error("This public link is no longer available.");
}

export async function fetchPublicDesktop(token: string, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)): Promise<RemoteDesktopState> {
  const response = await fetchImpl(API_ROUTES.publicDesktop(token), { cache: "no-store", credentials: "omit" });
  if (!response.ok) throw new Error(response.status === 404 ? "This public desktop link is unavailable." : `The public desktop could not be loaded (${response.status}).`);
  return parsePublicDesktopState(await response.json());
}

export async function fetchPublicFile(token: string, file: FileEntry, contentRevision: number, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)) {
  let response = await fetchImpl(API_ROUTES.publicDesktopContent(token, file.id), { cache: "no-store", credentials: "same-origin" });
  const gate = await largeDownloadError(response);
  if (gate) throw gate;
  if (response.ok && !response.headers.get("content-type")?.includes("application/json")) return new File([await response.blob()], file.name, { type: file.mimeType, lastModified: file.modifiedAt });

  if (!response.ok && response.status !== 404 && response.status !== 405 && response.status !== 409) throw new Error(`The file could not be downloaded (${response.status}).`);
  response = await fetchImpl(API_ROUTES.publicDesktopContentAccess(token, file.id, contentRevision), { cache: "no-store", credentials: "same-origin" });
  const descriptorGate = await largeDownloadError(response);
  if (descriptorGate) throw descriptorGate;
  if (!response.ok) throw new Error(`The file could not be downloaded (${response.status}).`);
  const descriptor = parseContentAccessDescriptor(await response.json(), file.id, contentRevision, file.size);
  const contentResponse = await fetchImpl(descriptor.access.url, { method: "GET", headers: descriptor.access.headers, credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer" });
  const contentGate = await largeDownloadError(contentResponse);
  if (contentGate) throw contentGate;
  if (!contentResponse.ok) throw new Error(`The file could not be downloaded (${contentResponse.status}).`);
  const blob = await contentResponse.blob();
  if (blob.size !== file.size) throw new Error("The downloaded file has an unexpected size.");
  return new File([blob], file.name, { type: file.mimeType, lastModified: file.modifiedAt });
}
