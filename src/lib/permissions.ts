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
