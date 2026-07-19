import { useEffect, useState } from "react";
import { X } from "@phosphor-icons/react";
import type { DialogState } from "../types";

type Props = {
  dialog: Exclude<DialogState, null>;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
};

export function FileDialog({ dialog, onClose, onSubmit }: Props) {
  const creatingFile = dialog.type === "create-file";
  const creatingFolder = dialog.type === "create-folder";
  const entry = dialog.type === "rename" || dialog.type === "delete" ? dialog.entry : null;
  const [name, setName] = useState(creatingFile ? "untitled.txt" : creatingFolder ? "New folder" : entry?.name ?? "");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

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
  const title = creatingFile ? "New text file" : creatingFolder ? "New folder" : dialog.type === "rename" ? `Rename ${noun}` : `Delete ${noun}`;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="file-dialog" role="dialog" aria-modal="true" aria-labelledby="file-dialog-title">
        <header className="window-header">
          <div>
            <span className="window-kicker">Hiraya</span>
            <h2 id="file-dialog-title">{title}</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close dialog">
            <X size={18} />
          </button>
        </header>
        <form onSubmit={handleSubmit}>
          {dialog.type === "delete" ? (
            <p className="dialog-message">
              Delete <strong>{entry?.name}</strong>?
              {entry?.kind === "folder" ? " Everything inside this folder will also be deleted. This cannot be undone." : " This cannot be undone."}
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
          {error && <p className="form-error" id="file-name-error">{error}</p>}
          <div className="dialog-actions">
            <button className="button button--quiet" type="button" onClick={onClose}>Cancel</button>
            <button className={`button ${dialog.type === "delete" ? "button--danger" : "button--primary"}`} type="submit" disabled={submitting} autoFocus={dialog.type === "delete"}>
              {submitting ? (dialog.type === "delete" ? "Deleting..." : "Saving...") : creatingFile ? "Create file" : creatingFolder ? "Create folder" : dialog.type === "rename" ? "Rename" : "Delete"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
