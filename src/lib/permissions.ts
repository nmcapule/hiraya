import type { DesktopCapabilities, DesktopIdentity } from "../types";

export const OWNER_CAPABILITIES: DesktopCapabilities = {
  read: true,
  write: true,
  manage: true,
  delete: true,
  settings: true,
  activity: true,
};

export const READ_ONLY_CAPABILITIES: DesktopCapabilities = {
  read: true,
  write: false,
  manage: false,
  delete: false,
  settings: false,
  activity: false,
};

export function localDesktopIdentity(id: string, name: string): DesktopIdentity {
  return {
    id,
    name,
    ownership: "owned",
    role: "owner",
    owner: { id: "local", displayName: "You", avatar: null },
    capabilities: { ...OWNER_CAPABILITIES },
    authorityCatalogId: null,
  };
}

export function canMutateDesktop(desktop: DesktopIdentity | undefined, status: string) {
  if (!desktop?.capabilities.write || status === "connecting") return false;
  return desktop.ownership === "owned" || status === "online" || status === "local";
}

export function sharedOfflineMessage(desktop: DesktopIdentity | undefined, status: string) {
  return desktop?.ownership === "shared" && desktop.capabilities.write && status !== "online"
    ? "Shared desktop editing is unavailable offline. Reconnect to make changes safely."
    : "";
}

export function settingsRestrictionReason(desktop: DesktopIdentity | undefined, status: string) {
  if (!desktop) return "Desktop settings are unavailable while this desktop loads.";
  if (!desktop.capabilities.settings) return "Your role can view this desktop's appearance, but cannot change shared settings.";
  if (desktop.ownership === "shared" && status === "offline") return "Shared settings are unavailable offline. Reconnect to change them.";
  if (status === "connecting") return "Connecting to check whether shared settings changed.";
  if (status === "blocked") return "A queued change must be resolved before shared settings can be changed.";
  return "Desktop settings are read-only right now.";
}
