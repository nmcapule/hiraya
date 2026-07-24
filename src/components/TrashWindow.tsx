import { useEffect, useRef, useState } from "react";
import { ArrowCounterClockwise, File, Folder, SpinnerGap, Trash } from "@phosphor-icons/react";
import type { TrashDocument, TrashItem } from "../lib/contracts";

export type TrashWindowProps = {
  onListTrash: () => Promise<TrashDocument>;
  onRestore: (item: TrashItem, destination: "original" | "root") => Promise<void>;
  onPermanentlyDelete: (item: TrashItem) => Promise<void>;
  onRequestPermanentDelete: (item: TrashItem, confirmedDelete: () => Promise<void>) => void;
  readOnly?: boolean;
};

function deletedAt(timestamp: number) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.valueOf())) return { label: "Unknown deletion time", iso: undefined };
  return { label: new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date), iso: date.toISOString() };
}

export function TrashWindow({ onListTrash, onRestore, onPermanentlyDelete, onRequestPermanentDelete, readOnly = false }: TrashWindowProps) {
  const [items, setItems] = useState<TrashItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const requestRef = useRef(0);
  const busyRef = useRef(false);
  const listTrashRef = useRef(onListTrash);
  listTrashRef.current = onListTrash;

  useEffect(() => {
    const request = ++requestRef.current;
    setLoading(true);
    setError("");
    void listTrashRef.current().then((document) => {
      if (request === requestRef.current) setItems(document.items);
    }).catch((reason: unknown) => {
      if (request !== requestRef.current) return;
      setItems([]);
      setError(reason instanceof Error ? reason.message : "Trash could not be loaded.");
    }).finally(() => {
      if (request === requestRef.current) setLoading(false);
    });
  }, [refreshToken]);

  const run = async (item: TrashItem, operation: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusyId(item.entry.id);
    setError("");
    try {
      await operation();
      setItems((current) => current.filter((candidate) => candidate.entry.id !== item.entry.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The Trash operation failed.");
      throw reason;
    } finally {
      busyRef.current = false;
      setBusyId(null);
    }
  };

  return <section className="trash-window" aria-label="Trash">
    {error && <div className="trash-window__error" role="alert"><span>{error}</span>{items.length === 0 && <button className="button button--quiet" type="button" onClick={() => setRefreshToken((value) => value + 1)}>Retry</button>}</div>}
    {loading ? <div className="trash-window__state" role="status"><SpinnerGap className="trash-window__spinner" size={20} /> Loading Trash...</div>
      : items.length === 0 && !error ? <div className="trash-window__state" role="status"><Trash size={34} weight="duotone" /><strong>Trash is empty</strong><span>Items moved to Trash will appear here.</span></div>
      : items.length > 0 && <ul className="trash-window__list" aria-label="Deleted items">{items.map((item) => {
        const busy = busyId === item.entry.id;
        const count = item.descendantCount;
        const timestamp = deletedAt(item.deletedAt);
        return <li className="trash-window__item" key={item.entry.id}>
          <span className="trash-window__icon" aria-hidden="true">{item.entry.kind === "folder" ? <Folder size={28} weight="duotone" /> : <File size={28} weight="duotone" />}</span>
          <div className="trash-window__details"><strong>{item.entry.name}</strong><span>{item.entry.kind === "folder" ? "Folder" : item.entry.mimeType}{count > 0 ? ` · ${count} ${count === 1 ? "descendant" : "descendants"}` : ""}</span><time dateTime={timestamp.iso}>{timestamp.label}</time></div>
          {!readOnly && <div className="trash-window__actions">
            <button className="button button--quiet" type="button" disabled={busyId !== null} onClick={() => void run(item, () => onRestore(item, "original")).catch(() => undefined)}><ArrowCounterClockwise size={15} /> {busy ? "Restoring..." : "Restore original"}</button>
            <button className="button button--quiet" type="button" disabled={busyId !== null} onClick={() => void run(item, () => onRestore(item, "root")).catch(() => undefined)}>Restore to desktop</button>
            <button className="button trash-window__delete" type="button" disabled={busyId !== null} onClick={() => {
              let started = false;
              onRequestPermanentDelete(item, async () => {
                if (started) return;
                started = true;
                await run(item, () => onPermanentlyDelete(item));
              });
            }}><Trash size={15} /> Delete permanently</button>
          </div>}
        </li>;
      })}</ul>}
  </section>;
}
