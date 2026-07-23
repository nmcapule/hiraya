import { API_ROUTES, SERVER_ROUTES } from "./api-routes";

export type SessionUser = {
  displayName: string;
  email?: string;
  avatarUrl?: string;
};

export type AuthSession = {
  storageId: string;
  user: SessionUser;
  capabilities: {
    blobTransfer: "direct-b2-v1";
  };
};

export class AuthenticationRequiredError extends Error {
  constructor() {
    super("Your Hiraya session has expired.");
    this.name = "AuthenticationRequiredError";
  }
}

function requiredString(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`The session bootstrap contains an invalid ${label}.`);
  return value;
}

export function parseAuthSession(value: unknown): AuthSession {
  if (!value || typeof value !== "object") throw new Error("The session bootstrap is invalid.");
  const session = value as { storageId?: unknown; user?: unknown; capabilities?: unknown };
  if (!session.user || typeof session.user !== "object") throw new Error("The session bootstrap contains invalid user metadata.");
  if (!session.capabilities || typeof session.capabilities !== "object" || (session.capabilities as { blobTransfer?: unknown }).blobTransfer !== "direct-b2-v1") {
    throw new Error("The session bootstrap requires direct-b2-v1 blob transfer support.");
  }
  const user = session.user as { displayName?: unknown; email?: unknown; avatarUrl?: unknown };
  const optionalString = (candidate: unknown, label: string) => candidate === undefined ? undefined : requiredString(candidate, label);
  return {
    storageId: requiredString(session.storageId, "storage ID"),
    user: {
      displayName: requiredString(user.displayName, "display name"),
      ...(user.email === undefined ? {} : { email: optionalString(user.email, "email address") }),
      ...(user.avatarUrl === undefined ? {} : { avatarUrl: optionalString(user.avatarUrl, "avatar URL") }),
    },
    capabilities: { blobTransfer: "direct-b2-v1" },
  };
}

export function safeReturnPath(location: Pick<Location, "pathname" | "search" | "hash"> = window.location) {
  const path = `${location.pathname}${location.search}${location.hash}`;
  return path.startsWith("/") && !path.startsWith("//") ? path : "/";
}

export function loginUrl(location?: Pick<Location, "pathname" | "search" | "hash">) {
  const query = new URLSearchParams({ returnTo: safeReturnPath(location) });
  return `${SERVER_ROUTES.login}?${query}`;
}

export function redirectToLogin() {
  window.location.replace(loginUrl());
}

export function requireAuthenticatedResponse(response: Response, onUnauthorized: () => void = redirectToLogin) {
  if (response.status !== 401) return response;
  onUnauthorized();
  throw new AuthenticationRequiredError();
}

export async function bootstrapSession(
  frontendOnly: boolean,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
  onUnauthorized: () => void = redirectToLogin,
): Promise<AuthSession | null> {
  if (frontendOnly) return null;
  const response = requireAuthenticatedResponse(await fetchImpl(API_ROUTES.authSession, {
    cache: "no-store",
    credentials: "same-origin",
  }), onUnauthorized);
  if (!response.ok) throw new Error(`Hiraya could not load your session (${response.status}).`);
  return parseAuthSession(await response.json());
}
