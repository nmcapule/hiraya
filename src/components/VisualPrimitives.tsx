import {
  CloudArrowDown,
  CloudCheck,
  CloudSlash,
  File as FileGlyph,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FilePdf,
  FileText,
  FileVideo,
  Folder,
  GearSix,
  Info,
  LinkSimple,
  Package,
  SpinnerGap,
  WarningCircle,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";
import type { DesktopEntry } from "../types";
import { fileCapabilities } from "../ui/file-capabilities";
import { offlineStatusLabel, type OfflineEntryAvailability } from "../lib/offline-availability";

export function EntryIcon({ entry, size = 24 }: { entry: DesktopEntry; size?: number }) {
  if (entry.kind === "folder") return <Folder size={size} weight="duotone" aria-hidden="true" />;
  const { icon } = fileCapabilities(entry);
  const props = { size, weight: "duotone" as const, "aria-hidden": true };
  if (icon === "image") return <FileImage {...props} />;
  if (icon === "video") return <FileVideo {...props} />;
  if (icon === "audio") return <FileAudio {...props} />;
  if (icon === "pdf") return <FilePdf {...props} />;
  if (icon === "archive") return <FileArchive {...props} />;
  if (icon === "url") return <LinkSimple {...props} />;
  if (icon === "code") return <FileCode {...props} />;
  if (icon === "text") return <FileText {...props} />;
  return <FileGlyph {...props} />;
}

export function AppIcon({ kind, entry, size = 16 }: { kind: "file" | "explorer" | "properties" | "settings" | "sandbox"; entry?: DesktopEntry | null; size?: number }) {
  if (kind === "file" && entry) return <EntryIcon entry={entry} size={size} />;
  if (kind === "explorer") return <Folder size={size} weight="duotone" aria-hidden="true" />;
  if (kind === "properties") return <Info size={size} aria-hidden="true" />;
  if (kind === "sandbox") return <Package size={size} aria-hidden="true" />;
  return <GearSix size={size} aria-hidden="true" />;
}

export function AvailabilityBadge({ availability, showUnavailable = false }: { availability: OfflineEntryAvailability; showUnavailable?: boolean }) {
  if (!showUnavailable && availability.status === "unavailable") return null;
  return <span className="availability-badge" data-status={availability.status} title={offlineStatusLabel(availability)} aria-label={offlineStatusLabel(availability)}>
    {availability.status === "error" ? <WarningCircle /> : availability.status === "updating" ? <SpinnerGap /> : availability.status === "pinned" ? <CloudArrowDown /> : availability.status === "partial" || availability.status === "unavailable" ? <CloudSlash /> : <CloudCheck />}
  </span>;
}

export type StatusTone = "neutral" | "success" | "danger" | "progress" | "readonly";

export function StatusBadge({ children, tone = "neutral", surface = "window" }: { children: ReactNode; tone?: StatusTone; surface?: "window" | "chrome" }) {
  return <span className="status-badge" data-tone={tone} data-surface={surface}>{children}</span>;
}

export function RoleBadge({ children }: { children: ReactNode }) {
  return <span className="role-badge">{children}</span>;
}
