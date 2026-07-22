import { Copy, DownloadSimple, FilePlus, FolderOpen, FolderPlus, FolderSimplePlus, GearSix, Info, PencilSimple, Trash, UploadSimple, ClipboardText } from "@phosphor-icons/react";
import type { ContextMenuState, DesktopEntry } from "../types";

type Props = {
  menu: Extract<Exclude<ContextMenuState, null>, { type: "entry" }>;
  entry: DesktopEntry;
  onOpen: () => void;
  onEditFile?: () => void;
  onRename: () => void;
  onDownload?: () => void;
  onCopy: () => void;
  onPasteInto?: () => void;
  onMove: () => void;
  onProperties: () => void;
  onDelete: () => void;
  readOnly?: boolean;
  selectionCount?: number;
};

export function ContextMenu({ menu, entry, onOpen, onEditFile, onRename, onDownload, onCopy, onPasteInto, onMove, onProperties, onDelete, readOnly = false, selectionCount = 1 }: Props) {
  const left = Math.min(menu.x, window.innerWidth - 190);
  const top = Math.min(menu.y, window.innerHeight - 352);

  return (
    <div className="context-menu" role="menu" style={{ left: Math.max(8, left), top: Math.max(48, top) }}>
      {selectionCount === 1 && <button type="button" role="menuitem" autoFocus onClick={onOpen}>
        <FolderOpen size={17} /> Open
      </button>}
      {selectionCount === 1 && entry.kind === "file" && onEditFile && <button type="button" role="menuitem" disabled={readOnly} onClick={onEditFile}>
        <PencilSimple size={17} /> Edit File
      </button>}
      {selectionCount === 1 && <button type="button" role="menuitem" disabled={readOnly} onClick={onRename}>
        <PencilSimple size={17} /> Rename
        <kbd>R</kbd>
      </button>}
      {selectionCount === 1 && entry.kind === "file" && onDownload && (
        <button type="button" role="menuitem" onClick={onDownload}>
          <DownloadSimple size={17} /> Download
        </button>
      )}
      <button type="button" role="menuitem" onClick={onCopy}><Copy size={17} /> Copy {selectionCount > 1 ? `${selectionCount} items` : ""}<kbd>⌘C</kbd></button>
      {onPasteInto && <button type="button" role="menuitem" disabled={readOnly} onClick={onPasteInto}><ClipboardText size={17} /> Paste into</button>}
      <button type="button" role="menuitem" disabled={readOnly} onClick={onMove}>
        <FolderSimplePlus size={17} /> Move to...
      </button>
      {selectionCount === 1 && <button className="context-menu__separated" type="button" role="menuitem" onClick={onProperties}>
        <Info size={17} /> Properties
      </button>}
      <button className="context-menu__danger" type="button" role="menuitem" disabled={readOnly} onClick={onDelete}>
        <Trash size={17} /> Delete
      </button>
    </div>
  );
}

type DesktopProps = {
  menu: Extract<Exclude<ContextMenuState, null>, { type: "desktop" }>;
  onCreateFile: () => void;
  onCreateFolder: () => void;
  onUpload: () => void;
  onSettings: () => void;
  onPaste?: () => void;
  readOnly?: boolean;
};

export function DesktopContextMenu({ menu, onCreateFile, onCreateFolder, onUpload, onSettings, onPaste, readOnly = false }: DesktopProps) {
  const left = Math.min(menu.x, window.innerWidth - 190);
  const top = Math.min(menu.y, window.innerHeight - 220);

  return (
    <div className="context-menu" role="menu" style={{ left: Math.max(8, left), top: Math.max(48, top) }}>
      <button type="button" role="menuitem" autoFocus={!readOnly} disabled={readOnly} onClick={onCreateFile}>
        <FilePlus size={17} /> New text file
      </button>
      <button type="button" role="menuitem" disabled={readOnly} onClick={onCreateFolder}>
        <FolderPlus size={17} /> New folder
      </button>
      <button type="button" role="menuitem" disabled={readOnly} onClick={onUpload}>
        <UploadSimple size={17} /> Upload files
      </button>
      {onPaste && <button type="button" role="menuitem" disabled={readOnly} onClick={onPaste}><ClipboardText size={17} /> Paste<kbd>⌘V</kbd></button>}
      <button className="context-menu__separated" type="button" role="menuitem" autoFocus={readOnly} onClick={onSettings}>
        <GearSix size={17} /> Settings
      </button>
    </div>
  );
}
