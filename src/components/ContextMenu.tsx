import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { CloudArrowDown, CloudSlash, Copy, DownloadSimple, FilePlus, FolderOpen, FolderPlus, FolderSimplePlus, GearSix, Info, LinkSimple, Package, PencilSimple, Trash, UploadSimple, ClipboardText } from "@phosphor-icons/react";
import type { ContextMenuState, DesktopEntry } from "../types";
import { isLinearNavigationKey, linearNavigationIndex, submenuKeyIntent, visibleMenuItems } from "../ui/keyboard-navigation";

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

function useRovingMenu(ref: RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const items = visibleMenuItems(menu);
    const current = items.find((item) => item === document.activeElement) ?? items[0];
    for (const item of items) item.tabIndex = item === current ? 0 : -1;
    if (current && !menu.contains(document.activeElement)) requestAnimationFrame(() => current.focus());
  });
  return (event: React.FocusEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof HTMLButtonElement) || target.getAttribute("role") !== "menuitem") return;
    const menu = ref.current;
    if (!menu) return;
    for (const item of visibleMenuItems(menu)) item.tabIndex = item === target ? 0 : -1;
  };
}

type SubmenuItem = { id: string; label: string; icon?: ReactNode; disabled?: boolean; onSelect: () => void };

function MenuSubmenu({ icon, label, items }: { icon: ReactNode; label: string; items: readonly SubmenuItem[] }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const id = useId();
  function close() { setOpen(false); requestAnimationFrame(() => triggerRef.current?.focus()); }
  function openAndFocus() {
    setOpen(true);
    requestAnimationFrame(() => { if (menuRef.current) visibleMenuItems(menuRef.current).at(0)?.focus(); });
  }
  return <div className="context-menu__submenu">
    <button ref={triggerRef} type="button" role="menuitem" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => open ? close() : openAndFocus()} onKeyDown={(event) => {
      if (submenuKeyIntent(event.key, "trigger") === "open") { event.preventDefault(); event.stopPropagation(); openAndFocus(); }
    }}>{icon}<span>{label}</span><span className="context-menu__submenu-caret" aria-hidden="true">›</span></button>
    <div ref={menuRef} id={id} role="menu" aria-label={label} hidden={!open} onKeyDown={(event) => {
      if (submenuKeyIntent(event.key, "submenu") === "close") { event.preventDefault(); event.stopPropagation(); close(); return; }
      if (!isLinearNavigationKey(event.key)) return;
      const menuItems = visibleMenuItems(event.currentTarget);
      const next = linearNavigationIndex(menuItems.indexOf(document.activeElement as HTMLButtonElement), menuItems.length, event.key, "vertical");
      if (next < 0) return;
      event.preventDefault(); event.stopPropagation(); menuItems[next]?.focus();
    }}>{items.map((item) => <button type="button" role="menuitem" tabIndex={-1} disabled={item.disabled} key={item.id} onClick={item.onSelect}><span className="context-menu__submenu-item-icon" aria-hidden="true">{item.icon}</span><span className="context-menu__submenu-item-label">{item.label}</span></button>)}</div>
  </div>;
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
  const onFocus = useRovingMenu(position.ref);
  const offlineItems: SubmenuItem[] = [
    ...(onMakeAvailableOffline ? [{ id: "make-available", label: `Make available${selectionCount > 1 ? ` (${selectionCount})` : ""}`, disabled: offlineBusy, onSelect: onMakeAvailableOffline }] : []),
    ...(onUnpinOffline ? [{ id: "unpin", label: "Unpin availability", icon: <CloudSlash />, disabled: offlineBusy, onSelect: onUnpinOffline }] : []),
    ...(onRemoveOfflineCopy ? [{ id: "remove-copy", label: "Remove downloaded copies", icon: <CloudSlash />, disabled: offlineBusy, onSelect: onRemoveOfflineCopy }] : []),
    ...(onOpenOfflineStorage ? [{ id: "offline-panel", label: "Connection & Offline", icon: <GearSix />, onSelect: onOpenOfflineStorage }] : []),
  ];

  return (
    <div ref={position.ref} className="context-menu" role="menu" style={position.style} onFocusCapture={onFocus} onKeyDown={handleMenuKeyDown}>
      {selectionCount === 1 && <button type="button" role="menuitem" autoFocus onClick={onOpen}>
        <FolderOpen size={17} /> Open
      </button>}
      {selectionCount === 1 && entry.kind === "file" && onEditFile && <button type="button" role="menuitem" disabled={readOnly} onClick={onEditFile}>
        <PencilSimple size={17} /> Edit file
      </button>}
      {selectionCount === 1 && entry.kind === "file" && openWith.length > 0 && <MenuSubmenu icon={<Package size={17} />} label="Open with" items={openWith.map((app) => ({ id: app.id, label: app.label, onSelect: app.onOpen }))} />}
      {selectionCount === 1 && <button className="context-menu__separated" type="button" role="menuitem" disabled={readOnly} onClick={onRename}>
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
      {offlineItems.length > 0 && <MenuSubmenu icon={<CloudArrowDown size={17} />} label="Offline" items={offlineItems} />}
      {onPasteInto && <button className="context-menu__separated" type="button" role="menuitem" disabled={readOnly} onClick={onPasteInto}><ClipboardText size={17} /> Paste into</button>}
      {selectionCount === 1 && entry.kind === "folder" && onUploadInto && <button type="button" role="menuitem" disabled={readOnly} onClick={onUploadInto}><UploadSimple size={17} /> Upload files into</button>}
      {selectionCount === 1 && entry.kind === "folder" && onImportFolderInto && <button type="button" role="menuitem" disabled={readOnly} onClick={onImportFolderInto}><FolderOpen size={17} /> Import folder into</button>}
      <button className={!onPasteInto ? "context-menu__separated" : undefined} type="button" role="menuitem" disabled={readOnly} onClick={onMove}>
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
  const onFocus = useRovingMenu(position.ref);

  return (
    <div ref={position.ref} className="context-menu" role="menu" style={position.style} onFocusCapture={onFocus} onKeyDown={handleMenuKeyDown}>
      <button type="button" role="menuitem" autoFocus={!readOnly} disabled={readOnly} onClick={onCreateFile}>
        <FilePlus size={17} /> New text file
      </button>
      <button type="button" role="menuitem" disabled={readOnly} onClick={onCreateFolder}>
        <FolderPlus size={17} /> New folder
      </button>
      <button className="context-menu__separated" type="button" role="menuitem" disabled={readOnly} onClick={onUpload}>
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
  if (!isLinearNavigationKey(event.key)) return;
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") return;
  const items = visibleMenuItems(event.currentTarget);
  const current = items.indexOf(document.activeElement as HTMLButtonElement);
  const target = items[linearNavigationIndex(current, items.length, event.key, "vertical")];
  if (target) { event.preventDefault(); target.focus(); }
}
