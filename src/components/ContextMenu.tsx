import { DownloadSimple, FilePlus, FolderOpen, FolderPlus, FolderSimplePlus, GearSix, PencilSimple, Trash, UploadSimple } from "@phosphor-icons/react";
import type { ContextMenuState, DesktopEntry } from "../types";

type Props = {
  menu: Extract<Exclude<ContextMenuState, null>, { type: "entry" }>;
  entry: DesktopEntry;
  onOpen: () => void;
  onRename: () => void;
  onDownload?: () => void;
  onMove: () => void;
  onDelete: () => void;
  readOnly?: boolean;
};

export function ContextMenu({ menu, entry, onOpen, onRename, onDownload, onMove, onDelete, readOnly = false }: Props) {
  const left = Math.min(menu.x, window.innerWidth - 190);
  const top = Math.min(menu.y, window.innerHeight - 210);

  return (
    <div className="context-menu" role="menu" style={{ left: Math.max(8, left), top: Math.max(48, top) }}>
      <button type="button" role="menuitem" autoFocus onClick={onOpen}>
        <FolderOpen size={17} /> Open
      </button>
      <button type="button" role="menuitem" disabled={readOnly} onClick={onRename}>
        <PencilSimple size={17} /> Rename
        <kbd>R</kbd>
      </button>
      {entry.kind === "file" && onDownload && (
        <button type="button" role="menuitem" onClick={onDownload}>
          <DownloadSimple size={17} /> Download
        </button>
      )}
      <button type="button" role="menuitem" disabled={readOnly} onClick={onMove}>
        <FolderSimplePlus size={17} /> Move to...
      </button>
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
  readOnly?: boolean;
};

export function DesktopContextMenu({ menu, onCreateFile, onCreateFolder, onUpload, onSettings, readOnly = false }: DesktopProps) {
  const left = Math.min(menu.x, window.innerWidth - 190);
  const top = Math.min(menu.y, window.innerHeight - 166);

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
      <button className="context-menu__separated" type="button" role="menuitem" autoFocus={readOnly} onClick={onSettings}>
        <GearSix size={17} /> Settings
      </button>
    </div>
  );
}
