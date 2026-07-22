import { useState } from "react";
import { ClipboardText, X } from "@phosphor-icons/react";
import type { DesktopEntry } from "../types";
import { namesMatch, validateEntryName } from "../lib/entry-validation";

type Props = {
  roots: readonly DesktopEntry[];
  existingNames: readonly string[];
  onClose: () => void;
  onPaste: (names: Map<string, string>) => Promise<void>;
};

export function PasteConflictDialog({ roots, existingNames, onClose, onPaste }: Props) {
  const [names, setNames] = useState(() => new Map(roots.map((entry) => [entry.id, entry.name])));
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    try {
      const parsed = roots.map((entry) => [entry.id, validateEntryName(names.get(entry.id) ?? "")] as const);
      for (const [index, [, name]] of parsed.entries()) {
        if (existingNames.some((existing) => namesMatch(existing, name)) || parsed.slice(0, index).some(([, previous]) => namesMatch(previous, name))) {
          throw new Error(`“${name}” is already used in this destination.`);
        }
      }
      setSubmitting(true);
      await onPaste(new Map(parsed));
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "The copied items could not be pasted.");
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onPointerDown={(event) => event.target === event.currentTarget && !submitting && onClose()}>
      <section className="file-dialog paste-conflict-dialog" role="dialog" aria-modal="true" aria-labelledby="paste-conflict-title">
        <header className="window-header">
          <div><span className="window-kicker">Name conflict</span><h2 id="paste-conflict-title">Choose new names</h2></div>
          <button className="icon-button" type="button" onClick={onClose} disabled={submitting} aria-label="Close paste dialog"><X size={18} /></button>
        </header>
        <form onSubmit={submit}>
          <p className="dialog-message">One or more names are already used in this destination.</p>
          <div className="paste-conflict-dialog__fields">
            {roots.map((entry, index) => <label key={entry.id}>{entry.kind === "folder" ? "Folder" : "File"} name<input autoFocus={index === 0} maxLength={180} value={names.get(entry.id) ?? ""} onChange={(event) => setNames((current) => new Map(current).set(entry.id, event.target.value))} /></label>)}
          </div>
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="dialog-actions">
            <button className="button button--quiet" type="button" onClick={onClose} disabled={submitting}>Cancel</button>
            <button className="button button--primary" type="submit" disabled={submitting}><ClipboardText size={17} /> {submitting ? "Pasting..." : "Paste"}</button>
          </div>
        </form>
      </section>
    </div>
  );
}
