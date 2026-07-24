import { CloudArrowDown, CloudCheck, CloudSlash, File as FileGlyph, Folder, SpinnerGap } from "@phosphor-icons/react";
import type { DesktopEntry, FolderEntry } from "../types";
import { offlineStatusLabel, type OfflineEntryAvailability } from "../lib/offline-availability";

type Props = {
  entry: DesktopEntry;
  rootLabel: string;
  ancestors: FolderEntry[];
  descendants: DesktopEntry[];
  offlineAvailability?: OfflineEntryAvailability;
  offlineBusy?: boolean;
  onMakeAvailableOffline?: () => void;
  onUnpin?: () => void;
  onRemoveOfflineCopy?: () => void;
};

const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });
const numberFormatter = new Intl.NumberFormat();

function formatDate(value: number | null) {
  return value === null ? "Unknown" : dateFormatter.format(value);
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${numberFormatter.format(bytes)} ${bytes === 1 ? "byte" : "bytes"}`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: value < 10 ? 2 : 1 }).format(value)} ${units[unit]} (${numberFormatter.format(bytes)} bytes)`;
}

export function PropertiesWindow({ entry, rootLabel, ancestors, descendants, offlineAvailability, offlineBusy = false, onMakeAvailableOffline, onUnpin, onRemoveOfflineCopy }: Props) {
  const files = entry.kind === "folder" ? descendants.filter((item) => item.kind === "file") : [];
  const folders = entry.kind === "folder" ? descendants.filter((item) => item.kind === "folder") : [];
  const size = entry.kind === "file" ? entry.size : files.reduce((total, file) => total + file.size, 0);
  const location = ancestors.length ? `${rootLabel} / ${ancestors.map((ancestor) => ancestor.name).join(" / ")}` : rootLabel;

  return (
    <div className="properties-window">
      <div className="properties-window__identity">
        <span className="properties-window__icon" aria-hidden="true">{entry.kind === "folder" ? <Folder size={42} weight="duotone" /> : <FileGlyph size={42} weight="duotone" />}</span>
        <div><strong>{entry.name}</strong><span>{entry.kind === "folder" ? "Folder" : entry.mimeType}</span></div>
      </div>
      <dl className="properties-window__details">
        <div><dt>Type</dt><dd>{entry.kind === "folder" ? "Folder" : entry.mimeType}</dd></div>
        <div><dt>Location</dt><dd>{location}</dd></div>
        <div><dt>Size</dt><dd>{formatSize(size)}</dd></div>
        {entry.kind === "folder" && <div><dt>Contains</dt><dd>{numberFormatter.format(files.length)} {files.length === 1 ? "file" : "files"}, {numberFormatter.format(folders.length)} {folders.length === 1 ? "folder" : "folders"}</dd></div>}
        <div><dt>Created</dt><dd><time dateTime={entry.createdAt === null ? undefined : new Date(entry.createdAt).toISOString()}>{formatDate(entry.createdAt)}</time></dd></div>
        <div><dt>Modified</dt><dd><time dateTime={new Date(entry.modifiedAt).toISOString()}>{formatDate(entry.modifiedAt)}</time></dd></div>
        <div><dt>ID</dt><dd className="properties-window__id">{entry.id}</dd></div>
      </dl>
      {offlineAvailability && <section className="properties-window__offline" aria-label="Offline availability">
        <div>{offlineAvailability.status === "updating" ? <SpinnerGap size={18} className="activity-spinner" /> : offlineAvailability.cached || offlineAvailability.protected ? <CloudCheck size={18} /> : <CloudSlash size={18} />}<span><strong>Offline availability</strong><small>{offlineStatusLabel(offlineAvailability)}. {offlineAvailability.fileCount} {offlineAvailability.fileCount === 1 ? "file" : "files"}.</small></span></div>
        {!offlineAvailability.pinned && onMakeAvailableOffline && <button className="button button--quiet" type="button" disabled={offlineBusy} onClick={onMakeAvailableOffline}><CloudArrowDown size={15} /> {offlineBusy ? "Saving..." : "Make available"}</button>}
        {offlineAvailability.directlyPinned && onUnpin && <button className="button button--quiet" type="button" disabled={offlineBusy} onClick={onUnpin}><CloudSlash size={15} /> Unpin</button>}
        {offlineAvailability.cached && !offlineAvailability.pinned && !offlineAvailability.protected && onRemoveOfflineCopy && <button className="button button--quiet" type="button" disabled={offlineBusy} onClick={onRemoveOfflineCopy}><CloudSlash size={15} /> {offlineBusy ? "Removing..." : "Remove copy"}</button>}
      </section>}
    </div>
  );
}
