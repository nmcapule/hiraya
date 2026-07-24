import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { CloudArrowDown, CloudSlash, Copy, DownloadSimple, FilePlus, FolderOpen, FolderPlus, FolderSimplePlus, GearSix, Info, LinkSimple, PencilSimple, Trash, UploadSimple, ClipboardText } from "@phosphor-icons/react";
import type { ContextMenuState, DesktopEntry } from "../types";

const VIEWPORT_MARGIN = 8;
const MENU_BAR_INSET = 48;

function useMenuPosition(x: number, y: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({
    left: Math.max(VIEWPORT_MARGIN, x),
    top: Math.max(MENU_BAR_INSET, y),
    maxHeight: `calc(100dvh - ${MENU_BAR_INSET + VIEWPORT_MARGIN}px)`,
    overflowY: "auto",
    overscrollBehavior: "contain",
  });

  useLayoutEffect(() => {
    function positionMenu() {
      const element = ref.current;
      if (!element) return;
      const bounds = element.getBoundingClientRect();
      const maxHeight = Math.max(0, window.innerHeight - MENU_BAR_INSET - VIEWPORT_MARGIN);
      const renderedHeight = Math.min(bounds.height, maxHeight);
      setStyle({
        left: Math.min(Math.max(VIEWPORT_MARGIN, x), Math.max(VIEWPORT_MARGIN, window.innerWidth - VIEWPORT_MARGIN - bounds.width)),
        top: Math.min(Math.max(MENU_BAR_INSET, y), Math.max(MENU_BAR_INSET, window.innerHeight - VIEWPORT_MARGIN - renderedHeight)),
        maxHeight,
        overflowY: "auto",
        overscrollBehavior: "contain",
      });
    }

    positionMenu();
    window.addEventListener("resize", positionMenu);
    return () => window.removeEventListener("resize", positionMenu);
  }, [x, y]);

  return { ref, style };
}

type Props = {
  menu: Extract<Exclude<ContextMenuState, null>, { type: "entry" }>;
  entry: DesktopEntry;
  onOpen: () => void;
  onEditFile?: () => void;
  onRename: () => void;
  onDownload?: () => void;
  onCopy: () => void;
  onPasteInto?: () => void;
  onUploadInto?: () => void;
  onImportFolderInto?: () => void;
  onMove: () => void;
  onProperties: () => void;
  onDelete: () => void;
  onCopyLink?: () => void;
  onMakeAvailableOffline?: () => void;
  onUnpinOffline?: () => void;
  onRemoveOfflineCopy?: () => void;
  onOpenOfflineStorage?: () => void;
  offlineBusy?: boolean;
  readOnly?: boolean;
  selectionCount?: number;
  trashSupported?: boolean;
  openWith?: readonly { id: string; label: string; onOpen: () => void }[];
};

export function ContextMenu({ menu, entry, onOpen, onEditFile, onRename, onDownload, onCopy, onPasteInto, onUploadInto, onImportFolderInto, onMove, onProperties, onDelete, onCopyLink, onMakeAvailableOffline, onUnpinOffline, onRemoveOfflineCopy, onOpenOfflineStorage, offlineBusy = false, readOnly = false, selectionCount = 1, trashSupported = true, openWith = [] }: Props) {
  const position = useMenuPosition(menu.x, menu.y);

  return (
    <div ref={position.ref} className="context-menu" role="menu" style={position.style} onKeyDown={handleMenuKeyDown}>
      {selectionCount === 1 && <button type="button" role="menuitem" autoFocus onClick={onOpen}>
        <FolderOpen size={17} /> Open
      </button>}
      {selectionCount === 1 && entry.kind === "file" && onEditFile && <button type="button" role="menuitem" disabled={readOnly} onClick={onEditFile}>
        <PencilSimple size={17} /> Edit file
      </button>}
      {selectionCount === 1 && entry.kind === "file" && openWith.map((app) => <button type="button" role="menuitem" key={app.id} onClick={app.onOpen}>
        <FolderOpen size={17} /> Open with {app.label}
      </button>)}
      {selectionCount === 1 && <button type="button" role="menuitem" disabled={readOnly} onClick={onRename}>
        <PencilSimple size={17} /> Rename
        <kbd>R</kbd>
      </button>}
      {selectionCount === 1 && entry.kind === "file" && onDownload && (
        <button type="button" role="menuitem" onClick={onDownload}>
          <DownloadSimple size={17} /> Download
        </button>
      )}
      <button type="button" role="menuitem" onClick={onCopy}><Copy size={17} /> Copy {selectionCount > 1 ? `${selectionCount} items` : ""}<kbd>Ctrl/⌘ C</kbd></button>
      {selectionCount === 1 && onCopyLink && <button type="button" role="menuitem" onClick={onCopyLink}><LinkSimple size={17} /> Copy link</button>}
      {onMakeAvailableOffline && <button type="button" role="menuitem" disabled={offlineBusy} onClick={onMakeAvailableOffline}><CloudArrowDown size={17} /> Make available offline{selectionCount > 1 ? ` (${selectionCount})` : ""}</button>}
      {onUnpinOffline && <button type="button" role="menuitem" disabled={offlineBusy} onClick={onUnpinOffline}><CloudSlash size={17} /> Unpin offline availability</button>}
      {onRemoveOfflineCopy && <button type="button" role="menuitem" disabled={offlineBusy} onClick={onRemoveOfflineCopy}><CloudSlash size={17} /> Remove downloaded copies</button>}
      {onOpenOfflineStorage && <button type="button" role="menuitem" onClick={onOpenOfflineStorage}><GearSix size={17} /> Offline Storage</button>}
      {onPasteInto && <button type="button" role="menuitem" disabled={readOnly} onClick={onPasteInto}><ClipboardText size={17} /> Paste into</button>}
      {selectionCount === 1 && entry.kind === "folder" && onUploadInto && <button type="button" role="menuitem" disabled={readOnly} onClick={onUploadInto}><UploadSimple size={17} /> Upload files into</button>}
      {selectionCount === 1 && entry.kind === "folder" && onImportFolderInto && <button type="button" role="menuitem" disabled={readOnly} onClick={onImportFolderInto}><FolderOpen size={17} /> Import folder into</button>}
      <button type="button" role="menuitem" disabled={readOnly} onClick={onMove}>
        <FolderSimplePlus size={17} /> Move to...
      </button>
      {selectionCount === 1 && <button className="context-menu__separated" type="button" role="menuitem" onClick={onProperties}>
        <Info size={17} /> Properties
      </button>}
      <button className="context-menu__danger" type="button" role="menuitem" disabled={readOnly} onClick={onDelete}>
        <Trash size={17} /> {trashSupported ? "Move to Trash" : "Delete permanently"}
      </button>
    </div>
  );
}

type DesktopProps = {
  menu: Extract<Exclude<ContextMenuState, null>, { type: "desktop" }>;
  onCreateFile: () => void;
  onCreateFolder: () => void;
  onUpload: () => void;
  onImportFolder: () => void;
  onSettings?: () => void;
  onPaste?: () => void;
  readOnly?: boolean;
};

export function DesktopContextMenu({ menu, onCreateFile, onCreateFolder, onUpload, onImportFolder, onSettings, onPaste, readOnly = false }: DesktopProps) {
  const position = useMenuPosition(menu.x, menu.y);

  return (
    <div ref={position.ref} className="context-menu" role="menu" style={position.style} onKeyDown={handleMenuKeyDown}>
      <button type="button" role="menuitem" autoFocus={!readOnly} disabled={readOnly} onClick={onCreateFile}>
        <FilePlus size={17} /> New text file
      </button>
      <button type="button" role="menuitem" disabled={readOnly} onClick={onCreateFolder}>
        <FolderPlus size={17} /> New folder
      </button>
      <button type="button" role="menuitem" disabled={readOnly} onClick={onUpload}>
        <UploadSimple size={17} /> Upload files
      </button>
      <button type="button" role="menuitem" disabled={readOnly} onClick={onImportFolder}>
        <FolderOpen size={17} /> Import folder
      </button>
      {onPaste && <button type="button" role="menuitem" disabled={readOnly} onClick={onPaste}><ClipboardText size={17} /> Paste<kbd>Ctrl/⌘ V</kbd></button>}
      {onSettings && <button className="context-menu__separated" type="button" role="menuitem" autoFocus={readOnly} onClick={onSettings}>
        <GearSix size={17} /> Settings
      </button>}
    </div>
  );
}

function handleMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[role='menuitem']:not(:disabled)"));
  const current = items.indexOf(document.activeElement as HTMLButtonElement);
  const target = event.key === "Home" ? items[0]
    : event.key === "End" ? items.at(-1)
      : items[(current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length];
  if (target) { event.preventDefault(); target.focus(); }
}
