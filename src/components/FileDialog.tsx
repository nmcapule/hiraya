import { useRef, useState } from "react";
import { X } from "@phosphor-icons/react";
import type { DesktopEntry, DialogState } from "../types";
import { useModalDialog } from "../ui/modal-dialog";

type Props = {
  dialog: Exclude<DialogState, null>;
  entry: DesktopEntry | null;
  entryCount?: number;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
  trashSupported?: boolean;
};

export function FileDialog({ dialog, entry, entryCount = 1, onClose, onSubmit, trashSupported = true }: Props) {
  const creatingFile = dialog.type === "create-file";
  const creatingFolder = dialog.type === "create-folder";
  const [name, setName] = useState(creatingFile ? "untitled.txt" : creatingFolder ? "New folder" : entry?.name ?? "");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  useModalDialog(backdropRef, dialogRef, onClose, submitting);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      await onSubmit(name);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "The file could not be saved.");
      setSubmitting(false);
    }
  }

  const noun = entry?.kind === "folder" || creatingFolder ? "folder" : "file";
  const deleteLabel = trashSupported ? "Move to Trash" : "Delete permanently";
  const title = creatingFile ? "New text file" : creatingFolder ? "New folder" : dialog.type === "rename" ? `Rename ${noun}` : entryCount > 1 ? `${deleteLabel} (${entryCount} items)` : `${deleteLabel}: ${noun}`;

  return (
    <div ref={backdropRef} className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !submitting && onClose()}>
      <section ref={dialogRef} className="file-dialog" role="dialog" aria-modal="true" aria-labelledby="file-dialog-title" tabIndex={-1}>
        <header className="window-header">
          <div>
            <span className="window-kicker">Hiraya</span>
            <h2 id="file-dialog-title">{title}</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} disabled={submitting} aria-label="Close dialog">
            <X size={18} />
          </button>
        </header>
        <form onSubmit={handleSubmit}>
          {dialog.type === "delete" ? (
            <p className="dialog-message">
              {trashSupported
                ? entryCount > 1 ? <>Move <strong>{entryCount} selected items</strong> to Trash?</> : <>Move <strong>{entry?.name}</strong> to Trash?</>
                : entryCount > 1 ? <>Permanently delete <strong>{entryCount} selected items</strong>?</> : <>Permanently delete <strong>{entry?.name}</strong>?</>}
              {trashSupported ? entryCount > 1 || entry?.kind === "folder" ? " Everything inside selected folders will move with them." : " You can restore it from Trash." : " This cannot be undone."}
            </p>
          ) : (
            <>
              <label htmlFor="file-name">{noun === "folder" ? "Folder" : "File"} name</label>
              <input
                id="file-name"
                autoFocus
                value={name}
                maxLength={180}
                onChange={(event) => setName(event.target.value)}
                onFocus={(event) => {
                  const dot = event.currentTarget.value.lastIndexOf(".");
                  event.currentTarget.setSelectionRange(0, dot > 0 ? dot : event.currentTarget.value.length);
                }}
                aria-describedby={error ? "file-name-error" : undefined}
              />
            </>
          )}
          {error && <p className="form-error" id="file-name-error" role="alert">{error}</p>}
          <div className="dialog-actions">
            <button className="button button--quiet" type="button" onClick={onClose} disabled={submitting} autoFocus={dialog.type === "delete"}>Cancel</button>
            <button className={`button ${dialog.type === "delete" ? "button--danger" : "button--primary"}`} type="submit" disabled={submitting}>
              {submitting ? (dialog.type === "delete" ? trashSupported ? "Moving..." : "Deleting..." : "Saving...") : creatingFile ? "Create file" : creatingFolder ? "Create folder" : dialog.type === "rename" ? "Rename" : deleteLabel}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
