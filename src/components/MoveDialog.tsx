import { useRef, useState } from "react";
import { Desktop, Folder, SpinnerGap, X } from "@phosphor-icons/react";
import type { DesktopEntry, FolderEntry } from "../types";
import { useModalDialog } from "../ui/modal-dialog";

export interface MoveDialogProps {
  desktops: readonly { id: string; name: string; folders: readonly FolderEntry[] }[];
  activeDesktopId: string;
  entries: readonly DesktopEntry[];
  invalidIds: Set<string>;
  onClose: () => void;
  onMove: (desktopId: string, parentId: string | null) => Promise<void> | void;
  onSubmittingChange?: (submitting: boolean) => void;
  loading?: boolean;
}

function flattenFolders(folders: readonly FolderEntry[], invalidIds: Set<string>) {
  const valid = folders.filter((folder) => !invalidIds.has(folder.id));
  const validIds = new Set(valid.map((folder) => folder.id));
  const children = new Map<string | null, FolderEntry[]>();

  for (const folder of valid) {
    const parentId = folder.parentId && validIds.has(folder.parentId) ? folder.parentId : null;
    children.set(parentId, [...(children.get(parentId) ?? []), folder]);
  }
  for (const items of children.values()) items.sort((a, b) => a.name.localeCompare(b.name));

  const flattened: Array<{ folder: FolderEntry; depth: number }> = [];
  const visited = new Set<string>();
  function visit(parentId: string | null, depth: number) {
    for (const folder of children.get(parentId) ?? []) {
      if (visited.has(folder.id)) continue;
      visited.add(folder.id);
      flattened.push({ folder, depth });
      visit(folder.id, depth + 1);
    }
  }
  visit(null, 0);
  return flattened;
}

export function MoveDialog({ desktops, activeDesktopId, entries, invalidIds, onClose, onMove, onSubmittingChange, loading = false }: MoveDialogProps) {
  const first = entries[0];
  const initialParent = first?.parentId && !invalidIds.has(first.parentId) ? first.parentId : null;
  const [selectedId, setSelectedId] = useState<string | null>(initialParent);
  const [selectedDesktopId, setSelectedDesktopId] = useState(activeDesktopId);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  useModalDialog(backdropRef, dialogRef, onClose, submitting);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    onSubmittingChange?.(true);
    setError("");
    try {
      await onMove(selectedDesktopId, selectedId);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "The item could not be moved.");
      setSubmitting(false);
      onSubmittingChange?.(false);
    }
  }

  return (
    <div ref={backdropRef} className="modal-backdrop" role="presentation" onPointerDown={(event) => event.target === event.currentTarget && !submitting && onClose()}>
      <section ref={dialogRef} className="file-window move-dialog" role="dialog" aria-modal="true" aria-labelledby="move-dialog-title" tabIndex={-1}>
        <header className="window-header move-dialog__header">
          <div>
             <span className="window-kicker">Move {entries.length === 1 ? "item" : "items"}</span>
             <h2 id="move-dialog-title">{entries.length === 1 ? `Move ${first?.name ?? "item"}` : `Move ${entries.length} items`}</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} disabled={submitting} aria-label="Close move dialog"><X size={18} /></button>
        </header>

        <form className="move-dialog__form" onSubmit={handleSubmit}>
          <fieldset className="move-dialog__destinations" disabled={loading || submitting} aria-busy={loading || undefined}>
            <legend>Choose a destination</legend>
            {loading && <div className="move-dialog__loading" role="status"><SpinnerGap size={18} /> Loading destinations...</div>}
            {desktops.map((desktop) => <div className="move-dialog__desktop-group" key={desktop.id}>
              <label className="move-dialog__destination move-dialog__desktop" data-selected={selectedDesktopId === desktop.id && selectedId === null || undefined}>
                <input type="radio" name="destination" checked={selectedDesktopId === desktop.id && selectedId === null} onChange={() => { setSelectedDesktopId(desktop.id); setSelectedId(null); }} />
                <Desktop size={20} weight="duotone" /> <span>{desktop.name}</span>
              </label>
              {flattenFolders(desktop.folders, desktop.id === activeDesktopId ? invalidIds : new Set()).map(({ folder, depth }) => (
                <label className="move-dialog__destination" data-selected={selectedDesktopId === desktop.id && selectedId === folder.id || undefined} key={folder.id} style={{ "--folder-depth": depth + 1 } as React.CSSProperties}>
                  <input type="radio" name="destination" checked={selectedDesktopId === desktop.id && selectedId === folder.id} onChange={() => { setSelectedDesktopId(desktop.id); setSelectedId(folder.id); }} />
                  <Folder size={20} weight="duotone" /> <span>{folder.name}</span>
                </label>
              ))}
            </div>)}
          </fieldset>
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="dialog-actions">
            <button className="button button--quiet" type="button" onClick={onClose} disabled={submitting}>Cancel</button>
            <button className="button button--primary" type="submit" disabled={submitting || loading}>{submitting ? "Moving..." : "Move"}</button>
          </div>
        </form>
      </section>
    </div>
  );
}
