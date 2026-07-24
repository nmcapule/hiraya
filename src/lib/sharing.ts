import { API_ROUTES } from "./api-routes";
import { assertValidId, isRecord } from "./contracts";

export type SharingRole = "manager" | "writer" | "reader";
export type SharingMember = { userId: string; displayName: string; email?: string; avatar: string | null; role: "owner" | SharingRole };
export type SharingInvitation = { id: string; email: string; role: SharingRole; expiresAt?: number; url?: string; token?: string };
export type DesktopPublication = { published: boolean; url?: string; token?: string };
export type DesktopAudience = { kind: "authenticated-users"; role: SharingRole };
export type SharingState = { members: SharingMember[]; pending: SharingInvitation[]; publication: DesktopPublication; audience: DesktopAudience | null };

function role(value: unknown, allowOwner = false): "owner" | SharingRole {
  if (value === "reader" || value === "writer" || value === "manager" || allowOwner && value === "owner") return value;
  throw new Error("Sharing data contains an invalid role.");
}

export function parseSharingState(value: unknown): SharingState {
  if (!isRecord(value)) throw new Error("The sharing response has an unsupported format.");
  const memberValues = Array.isArray(value.members) ? value.members : [];
  const invitationValues = Array.isArray(value.pending) ? value.pending : Array.isArray(value.invitations) ? value.invitations : Array.isArray(value.pendingInvitations) ? value.pendingInvitations : [];
  const members = memberValues.map((candidate): SharingMember => {
    if (!isRecord(candidate)) throw new Error("Sharing data contains an invalid member.");
    const userId = typeof candidate.userId === "string" ? candidate.userId : candidate.id;
    assertValidId(userId, "Sharing data contains an invalid member ID.");
    if (typeof candidate.displayName !== "string" || !candidate.displayName.trim()) throw new Error("Sharing data contains an invalid member name.");
    return { userId, displayName: candidate.displayName.trim(), ...(typeof candidate.email === "string" ? { email: candidate.email } : {}), avatar: typeof candidate.avatar === "string" ? candidate.avatar : null, role: role(candidate.role, true) };
  });
  const pending = invitationValues.map((candidate): SharingInvitation => {
    if (!isRecord(candidate) || typeof candidate.email !== "string") throw new Error("Sharing data contains an invalid invitation.");
    const id = typeof candidate.id === "string" ? candidate.id : typeof candidate.token === "string" ? candidate.token : candidate.email;
    return { id, email: candidate.email, role: role(candidate.role) as SharingRole, ...(Number.isSafeInteger(candidate.expiresAt) ? { expiresAt: candidate.expiresAt as number } : {}), ...(typeof candidate.url === "string" ? { url: candidate.url } : {}), ...(typeof candidate.token === "string" ? { token: candidate.token } : {}) };
  });
  const publicationValue = isRecord(value.publication) ? value.publication : {};
  const token = typeof publicationValue.token === "string" ? publicationValue.token : undefined;
  const audienceValue = value.audience;
  const audience: DesktopAudience | null = isRecord(audienceValue) && audienceValue.kind === "authenticated-users" ? { kind: "authenticated-users", role: role(audienceValue.role) as SharingRole } : null;
  return { members, pending, publication: { published: publicationValue.published === true || Boolean(token), ...(typeof publicationValue.url === "string" ? { url: publicationValue.url } : {}), ...(token ? { token } : {}) }, audience };
}

async function request(input: string, init?: RequestInit) {
  const response = await fetch(input, { credentials: "same-origin", cache: "no-store", ...init });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error || `The sharing request failed (${response.status}).`);
  }
  return response.status === 204 ? null : response.json().catch(() => null);
}

export async function getSharing(desktopId: string) { return parseSharingState(await request(API_ROUTES.desktopSharing(desktopId))); }
export async function inviteMember(desktopId: string, input: { email: string; role: SharingRole; expiryHours: number }) { return request(API_ROUTES.desktopMembers(desktopId), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }); }
export async function updateMember(desktopId: string, userId: string, memberRole: SharingRole) { await request(API_ROUTES.desktopMember(desktopId, userId), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role: memberRole }) }); }
export async function removeMember(desktopId: string, userId: string) { await request(API_ROUTES.desktopMember(desktopId, userId), { method: "DELETE" }); }
export async function revokeInvitation(desktopId: string, email: string) { await request(API_ROUTES.desktopInvitation(desktopId, email), { method: "DELETE" }); }
export async function publishDesktop(desktopId: string) { return request(API_ROUTES.desktopPublication(desktopId), { method: "PUT" }); }
export async function rotatePublication(desktopId: string) { return request(API_ROUTES.desktopPublicationRotate(desktopId), { method: "POST" }); }
export async function unpublishDesktop(desktopId: string) { await request(API_ROUTES.desktopPublication(desktopId), { method: "DELETE" }); }
