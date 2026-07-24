import { ArrowClockwise, CloudArrowDown, CloudCheck, CloudSlash, HardDrive } from "@phosphor-icons/react";
import type { DesktopEntry } from "../types";
import { offlineStatusLabel, type OfflineAvailabilityModel, type OfflineStorageInventory } from "../lib/offline-availability";
import type { OfflineOperationProgress } from "../lib/sync";
import { StatusBadge } from "./VisualPrimitives";

type Props = {
  entries: readonly DesktopEntry[];
  inventory: OfflineStorageInventory | null;
  model: OfflineAvailabilityModel;
  progress: OfflineOperationProgress | null;
  online: boolean;
  onRetry: () => void;
  onUnpin: (ids: string[]) => void;
  onReleaseAll: () => void;
  onOpenHelp: () => void;
};

const number = new Intl.NumberFormat();

function formatOfflineBytes(bytes: number) {
  if (bytes < 1024) return `${number.format(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = -1;
  do { value /= 1024; unit += 1; } while (value >= 1024 && unit < units.length - 1);
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: value < 10 ? 2 : 1 }).format(value)} ${units[unit]}`;
}

export function OfflineStoragePanel({ entries, inventory, model, progress, online, onRetry, onUnpin, onReleaseAll, onOpenHelp }: Props) {
  const pinnedRoots = entries.filter((entry) => model.entries[entry.id]?.directlyPinned);
  const storage = inventory?.browserStorage;
  const busy = progress?.phase === "downloading";
  return <div className="offline-storage-panel" aria-busy={busy}>
    <section className="offline-storage-summary" aria-labelledby="offline-hiraya-heading">
      <div><CloudCheck size={22} /><span><strong id="offline-hiraya-heading">Hiraya downloaded copies</strong><small>Exact validated cache for this desktop</small></span></div>
      <b>{formatOfflineBytes(inventory?.cachedBytes ?? 0)}</b>
      {Boolean(inventory?.protectedBytes) && <p><HardDrive size={15} /> {formatOfflineBytes(inventory!.protectedBytes)} is authoritative or pending local content and cannot be released.</p>}
    </section>
    <section className="offline-storage-summary" aria-labelledby="offline-browser-heading">
      <div><HardDrive size={22} /><span><strong id="offline-browser-heading">Origin-wide storage estimate</strong><small>All storage reported for this Hiraya origin, not only downloaded files</small></span></div>
      <b>{storage ? `${formatOfflineBytes(storage.usage)} of ${formatOfflineBytes(storage.quota)}` : "Unavailable"}</b>
      {storage && <progress aria-label="Estimated origin-wide storage usage" max={storage.quota || 1} value={storage.usage} />}
    </section>
    {progress && <section className="offline-storage-progress" role={progress.phase === "error" ? "alert" : "status"} aria-live={progress.phase === "error" ? undefined : "polite"} aria-atomic="true">
      <div><ArrowClockwise size={18} aria-hidden="true" /><StatusBadge tone={progress.phase === "error" ? "danger" : progress.phase === "complete" ? "success" : "progress"}>{progress.phase === "error" ? "Failed" : progress.phase === "complete" ? "Complete" : "Updating"}</StatusBadge><strong>{progress.phase === "error" ? "Some downloads failed" : progress.phase === "complete" ? "Offline update complete" : "Updating offline copies"}</strong></div>
      <progress max={progress.total || 1} value={progress.completed} aria-label="Offline download progress" />
      <span>{progress.completed} of {progress.total} files, {formatOfflineBytes(progress.bytesCompleted)} of {formatOfflineBytes(progress.totalBytes)}{progress.failed ? `, ${progress.failed} failed` : ""}</span>
      {progress.errors.size > 0 && <ul className="offline-storage-failures">{[...progress.errors].map(([id, message]) => <li key={id}><strong>{entries.find((entry) => entry.id === id)?.name ?? id}</strong><span>{message}</span></li>)}</ul>}
      {progress.phase === "error" && <button className="button button--quiet" type="button" disabled={!online || busy} onClick={onRetry}><ArrowClockwise size={15} /> Retry failed downloads</button>}
    </section>}
    <section aria-labelledby="offline-pins-heading">
      <header className="offline-storage-section-heading"><div><h3 id="offline-pins-heading">Pinned items</h3><p>Folder pins automatically include current and new descendants.</p></div><span>{pinnedRoots.length}</span></header>
      {pinnedRoots.length ? <div className="offline-pin-list">{pinnedRoots.map((entry) => {
        const availability = model.entries[entry.id];
        return <div className="offline-pin-row" key={entry.id}><span>{entry.kind === "folder" ? <HardDrive size={18} /> : <CloudArrowDown size={18} />}<span><strong>{entry.name}</strong><small>{offlineStatusLabel(availability)} · {availability.fileCount} {availability.fileCount === 1 ? "file" : "files"} · {formatOfflineBytes(availability.bytes)}</small></span></span><button className="button button--quiet" type="button" disabled={busy} onClick={() => onUnpin([entry.id])}><CloudSlash size={15} /> Unpin</button></div>;
      })}</div> : <p className="offline-storage-empty">Nothing is pinned. Use an item or selection context menu to make it available offline.</p>}
    </section>
    <section className="offline-storage-release" aria-labelledby="offline-release-heading"><div><h3 id="offline-release-heading">Release downloaded copies</h3><p>Removes only unpinned cache, including stale copies found during this explicit cleanup. Server files, pinned copies, pending operations, and browser-local authoritative files are never deleted.</p></div><button className="button button--quiet" type="button" disabled={busy || !inventory?.releasableBytes} onClick={onReleaseAll}><CloudSlash size={15} /> Release all unpinned cache</button></section>
    <button className="inline-help-link" type="button" onClick={onOpenHelp}>Offline behavior, risks, and troubleshooting</button>
  </div>;
}
