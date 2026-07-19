import { DownloadSimple, FolderOpen, FolderSimplePlus, PencilSimple, Trash } from "@phosphor-icons/react";
import type { ContextMenuState } from "../types";

type Props = {
  menu: Exclude<ContextMenuState, null>;
  onOpen: () => void;
  onRename: () => void;
  onDownload?: () => void;
  onMove: () => void;
  onDelete: () => void;
  readOnly?: boolean;
};

export function ContextMenu({ menu, onOpen, onRename, onDownload, onMove, onDelete, readOnly = false }: Props) {
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
      {menu.entry.kind === "file" && onDownload && (
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
