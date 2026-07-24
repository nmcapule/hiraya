import type { OutboxRecord } from "../lib/outbox";
import type { OfflineAvailabilityModel, OfflineStorageInventory } from "../lib/offline-availability";
import type { OfflineOperationProgress, SyncStatus } from "../lib/sync";
import type { DesktopEntry } from "../types";
import { OfflineStoragePanel } from "./OfflineStoragePanel";
import { SyncIssuesPanel } from "./SyncIssuesPanel";

type Props = {
  status: SyncStatus;
  records: readonly OutboxRecord[];
  lastSyncedAt?: number | null;
  affectedLabels?: (record: OutboxRecord) => readonly string[];
  entries: readonly DesktopEntry[];
  inventory: OfflineStorageInventory | null;
  model: OfflineAvailabilityModel;
  progress: OfflineOperationProgress | null;
  online: boolean;
  onRetryRecord: (record: OutboxRecord) => void;
  onDiscardRecord: (record: OutboxRecord) => void;
  onRetryDownloads: () => void;
  onUnpin: (ids: string[]) => void;
  onReleaseAll: () => void;
  onOpenHelp: () => void;
};

export function ConnectionPanel(props: Props) {
  return <section className="connection-panel">
    <header className="connection-panel__heading"><h2>Connection &amp; Offline</h2><p>Connection state, queued work, offline pins, and browser storage in one place.</p></header>
    <SyncIssuesPanel status={props.status} records={props.records} lastSyncedAt={props.lastSyncedAt} affectedLabels={props.affectedLabels} onRetry={props.onRetryRecord} onDiscard={props.onDiscardRecord} />
    <div className="connection-panel__explanation"><strong>{props.status === "local" ? "Browser-local workspace" : "Server-authoritative workspace"}</strong><span>{props.status === "local" ? "Files and changes exist only in this browser. Clearing site data removes them." : "Downloaded files are validated copies. Pending local changes remain protected until synchronization completes."}</span></div>
    <OfflineStoragePanel entries={props.entries} inventory={props.inventory} model={props.model} progress={props.progress} online={props.online} onRetry={props.onRetryDownloads} onUnpin={props.onUnpin} onReleaseAll={props.onReleaseAll} onOpenHelp={props.onOpenHelp} />
  </section>;
}
