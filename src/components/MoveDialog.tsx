import { useState } from "react";
import { Desktop, Folder, X } from "@phosphor-icons/react";
import type { DesktopEntry, FolderEntry } from "../types";

export interface MoveDialogProps {
  entry: DesktopEntry;
  folders: readonly FolderEntry[];
  invalidIds: Set<string>;
  onClose: () => void;
  onMove: (parentId: string | null) => Promise<void> | void;
  onSubmittingChange?: (submitting: boolean) => void;
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

export function MoveDialog({ entry, folders, invalidIds, onClose, onMove, onSubmittingChange }: MoveDialogProps) {
  const initialParent = entry.parentId && !invalidIds.has(entry.parentId) ? entry.parentId : null;
  const [selectedId, setSelectedId] = useState<string | null>(initialParent);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const destinations = flattenFolders(folders, invalidIds);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    onSubmittingChange?.(true);
    setError("");
    try {
      await onMove(selectedId);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "The item could not be moved.");
      setSubmitting(false);
      onSubmittingChange?.(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onPointerDown={(event) => event.target === event.currentTarget && !submitting && onClose()}>
      <section className="file-window move-dialog" role="dialog" aria-modal="true" aria-labelledby="move-dialog-title">
        <header className="window-header move-dialog__header">
          <div>
            <span className="window-kicker">Move item</span>
            <h2 id="move-dialog-title">Move {entry.name}</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} disabled={submitting} aria-label="Close move dialog"><X size={18} /></button>
        </header>

        <form className="move-dialog__form" onSubmit={handleSubmit}>
          <fieldset className="move-dialog__destinations">
            <legend>Choose a destination</legend>
            <label className="move-dialog__destination" data-selected={selectedId === null || undefined}>
              <input type="radio" name="destination" checked={selectedId === null} onChange={() => setSelectedId(null)} />
              <Desktop size={20} weight="duotone" /> <span>Desktop</span>
            </label>
            {destinations.map(({ folder, depth }) => (
              <label className="move-dialog__destination" data-selected={selectedId === folder.id || undefined} key={folder.id} style={{ "--folder-depth": depth } as React.CSSProperties}>
                <input type="radio" name="destination" checked={selectedId === folder.id} onChange={() => setSelectedId(folder.id)} />
                <Folder size={20} weight="duotone" /> <span>{folder.name}</span>
              </label>
            ))}
          </fieldset>
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="dialog-actions">
            <button className="button button--quiet" type="button" onClick={onClose} disabled={submitting}>Cancel</button>
            <button className="button button--primary" type="submit" disabled={submitting}>{submitting ? "Moving..." : "Move"}</button>
          </div>
        </form>
      </section>
    </div>
  );
}
