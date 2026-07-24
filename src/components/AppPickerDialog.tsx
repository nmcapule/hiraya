import { useMemo, useRef, useState } from "react";
import { Folder, File as FileIcon, X } from "@phosphor-icons/react";
import type { DialogRequest } from "../apps/host/dialogs";
import type { DesktopEntry, FileEntry, FolderEntry } from "../types";
import { useModalDialog } from "../ui/modal-dialog";

type Props = {
  request: Extract<DialogRequest, { kind: "openFile" | "openFolder" | "saveFile" }>;
  entries: DesktopEntry[];
  onCancel: () => void;
  onOpenFiles: (files: FileEntry[]) => void;
  onOpenFolder: (folder: FolderEntry | null) => void;
  onSave: (name: string, folder: FolderEntry | null) => Promise<void>;
};

export function AppPickerDialog({ request, entries, onCancel, onOpenFiles, onOpenFolder, onSave }: Props) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [folderId, setFolderId] = useState<string>("");
  const [name, setName] = useState(request.kind === "saveFile" ? request.params.suggestedName ?? "untitled" : "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useModalDialog(backdropRef, dialogRef, onCancel, busy);
  const folders = useMemo(() => entries.filter((entry): entry is FolderEntry => entry.kind === "folder"), [entries]);
  const files = useMemo(() => entries.filter((entry): entry is FileEntry => entry.kind === "file" && (request.kind !== "openFile" || !request.params.mimeTypes?.length || request.params.mimeTypes.includes(entry.mimeType))), [entries, request]);
  const title = request.kind === "openFile" ? "Choose file" : request.kind === "openFolder" ? "Choose folder" : "Save file";

  const submit = async () => {
    if (request.kind === "openFile") {
      onOpenFiles(files.filter((file) => selected.includes(file.id)));
      return;
    }
    const folder = folders.find((item) => item.id === folderId) ?? null;
    if (request.kind === "openFolder") { onOpenFolder(folder); return; }
    setBusy(true);
    setError("");
    try { await onSave(name, folder); } catch (reason) { setError(reason instanceof Error ? reason.message : "The file could not be saved."); setBusy(false); }
  };

  return <div ref={backdropRef} className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && onCancel()}>
    <section ref={dialogRef} className="file-dialog app-picker" role="dialog" aria-modal="true" aria-labelledby="app-picker-title" tabIndex={-1}>
      <header className="window-header"><div><span className="window-kicker">App request</span><h2 id="app-picker-title">{title}</h2></div><button className="icon-button" type="button" onClick={onCancel} disabled={busy} aria-label="Close dialog"><X size={18} /></button></header>
      <div className="app-picker__content">
        {request.kind === "openFile" ? <div className="app-picker__list" role="group" aria-label="Files">
          {files.map((file) => <label className="app-picker__item" key={file.id}><input type={request.params.multiple ? "checkbox" : "radio"} name="picked-file" checked={selected.includes(file.id)} onChange={(event) => setSelected(event.target.checked ? request.params.multiple ? [...selected, file.id] : [file.id] : selected.filter((id) => id !== file.id))} /><FileIcon size={17} /><span>{file.name}</span></label>)}
          {!files.length && <p>No matching files are available.</p>}
        </div> : <>
          <label>Location<select value={folderId} onChange={(event) => setFolderId(event.target.value)}><option value="">Desktop</option>{folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label>
          {request.kind === "saveFile" && <label>File name<input autoFocus value={name} maxLength={180} onChange={(event) => setName(event.target.value)} /></label>}
          {request.kind === "openFolder" && <div className="app-picker__folder"><Folder size={22} /><span>{folders.find((folder) => folder.id === folderId)?.name ?? "Desktop"}</span></div>}
        </>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="dialog-actions"><button className="button button--quiet" type="button" onClick={onCancel} disabled={busy}>Cancel</button><button className="button button--primary" type="button" disabled={busy || request.kind === "openFile" && selected.length === 0 || request.kind === "saveFile" && !name.trim()} onClick={() => void submit()}>{busy ? "Saving..." : request.kind === "saveFile" ? "Save" : "Choose"}</button></div>
      </div>
    </section>
  </div>;
}
