import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  DotsThreeVertical,
  File as FileGlyph,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  ListBullets,
  MagnifyingGlass,
  SortAscending,
  SortDescending,
  SquaresFour,
  UploadSimple,
  X,
} from "@phosphor-icons/react";
import type { DesktopEntry, FolderEntry } from "../types";
import { filterAndSortEntries, formatEntrySize, type FolderSortKey, type SortDirection } from "../ui/folder-explorer";
import type { AppWindowHeaderElements } from "./AppWindow";
import { MobileHeaderMenu } from "./MobileHeaderMenu";
import { offlineStatusLabel, type OfflineEntryAvailability } from "../lib/offline-availability";

export interface FolderExplorerProps {
  folder: FolderEntry | null;
  rootLabel: string;
  /** Ordered ancestors of folder, starting immediately below the desktop root. */
  breadcrumbs: readonly FolderEntry[];
  children: readonly DesktopEntry[];
  onNavigate: (folder: FolderEntry | null) => void;
  onOpen: (entry: DesktopEntry) => void;
  onCreateFolder: (parentId: string | null) => void;
  onCreateFile: (parentId: string | null) => void;
  onUpload: (parentId: string | null) => void;
  onImportFolder: (parentId: string | null) => void;
  onExternalDrop: (dataTransfer: DataTransfer, parentId: string | null) => void;
  onContextMenu: (entry: DesktopEntry, x: number, y: number) => void;
  onBlankContextMenu: (parentId: string | null, x: number, y: number) => void;
  selectedIds: ReadonlySet<string>;
  onSelect: (entry: DesktopEntry, options: { toggle: boolean; range: boolean; orderedIds: string[] }) => void;
  onMove: (entry: DesktopEntry, targetParentId: string | null) => void;
  readOnly?: boolean;
  headerElements?: AppWindowHeaderElements;
  offlineAvailability?: Readonly<Record<string, OfflineEntryAvailability>>;
}

type DragState = {
  entry: DesktopEntry;
  pointerId: number;
  startX: number;
  startY: number;
  moved: boolean;
  pointerType: string;
  longPressed: boolean;
  longPressTimer?: number;
};

type ExplorerView = "list" | "grid";

const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

export function FolderExplorer({
  folder,
  rootLabel,
  breadcrumbs,
  children,
  onNavigate,
  onOpen,
  onCreateFolder,
  onCreateFile,
  onUpload,
  onImportFolder,
  onExternalDrop,
  onContextMenu,
  onBlankContextMenu,
  selectedIds,
  onSelect,
  onMove,
  readOnly = false,
  headerElements,
  offlineAvailability = {},
}: FolderExplorerProps) {
  const drag = useRef<DragState | null>(null);
  const dropTarget = useRef<HTMLElement | null>(null);
  const suppressClick = useRef(false);
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<FolderSortKey>("name");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [view, setView] = useState<ExplorerView>("list");
  const parentId = folder?.id ?? null;
  const orderedChildren = filterAndSortEntries(children, search, sortKey, sortDirection);
  const orderedIds = orderedChildren.map((item) => item.id);
  const trail = folder && breadcrumbs.at(-1)?.id !== folder.id ? [...breadcrumbs, folder] : breadcrumbs;

  useEffect(() => () => {
    if (drag.current?.longPressTimer) window.clearTimeout(drag.current.longPressTimer);
  }, []);

  function open(entry: DesktopEntry) {
    if (entry.kind === "folder") onNavigate(entry);
    else onOpen(entry);
  }

  function setDropTarget(target: HTMLElement | null) {
    if (dropTarget.current === target) return;
    if (dropTarget.current) delete dropTarget.current.dataset.dropTarget;
    dropTarget.current = target;
    if (target) target.dataset.dropTarget = "true";
  }

  function findDropTarget(x: number, y: number) {
    for (const element of document.elementsFromPoint(x, y)) {
      const target = element.closest<HTMLElement>("[data-folder-target]");
      if (target) return target;
    }
    return null;
  }

  function handlePointerDown(event: React.PointerEvent<HTMLButtonElement>, entry: DesktopEntry) {
    if (event.button !== 0) return;
    drag.current = {
      entry,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      pointerType: event.pointerType,
      longPressed: false,
    };
    if (event.pointerType === "touch") {
      drag.current.longPressTimer = window.setTimeout(() => {
        const current = drag.current;
        if (!current || current.pointerId !== event.pointerId || current.moved) return;
        current.longPressTimer = undefined;
        current.longPressed = true;
        if (!selectedIds.has(entry.id)) onSelect(entry, { toggle: false, range: false, orderedIds });
        onContextMenu(entry, event.clientX, event.clientY);
      }, 500);
    }
    if (readOnly) return;
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (!current.moved && Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < 5) return;
    if (current.longPressTimer) window.clearTimeout(current.longPressTimer);
    current.longPressTimer = undefined;
    current.moved = true;
    event.currentTarget.dataset.dragging = "true";
    setDropTarget(findDropTarget(event.clientX, event.clientY));
  }

  function finishPointer(event: React.PointerEvent<HTMLButtonElement>, cancelled = false) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (current.longPressTimer) window.clearTimeout(current.longPressTimer);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    delete event.currentTarget.dataset.dragging;

    if (current.moved) {
      suppressClick.current = true;
      window.setTimeout(() => {
        suppressClick.current = false;
      }, 0);
      const targetId = cancelled ? undefined : dropTarget.current?.dataset.folderTarget;
      if (targetId !== undefined && targetId !== current.entry.id) {
        onMove(current.entry, targetId === "" ? null : targetId);
      }
    } else if (!cancelled && current.pointerType === "touch" && !current.longPressed) {
      suppressClick.current = true;
      window.setTimeout(() => { suppressClick.current = false; }, 0);
      open(current.entry);
    }
    setDropTarget(null);
    drag.current = null;
  }

  const previousFolder = trail.length > 1 ? trail.at(-2)! : null;

  return (
    <div className="file-window file-window--embedded folder-explorer folder-explorer--embedded">
        {headerElements?.leading && folder && createPortal(
          <button className="app-window__control folder-header-back" type="button" aria-label="Back to parent folder" onClick={() => onNavigate(previousFolder)}>
            <ArrowLeft size={18} />
          </button>,
          headerElements.leading,
        )}
        {headerElements?.actions && createPortal(
          <MobileHeaderMenu label="Folder actions" icon={<DotsThreeVertical size={19} weight="bold" />}>
            {(dismiss) => <>
              <nav className="mobile-folder-path" aria-label="Folder path">
                <button type="button" data-folder-target="" data-current={!folder || undefined} onClick={() => { dismiss(); onNavigate(null); }}>{rootLabel}</button>
                {trail.map((item) => <button type="button" key={item.id} data-folder-target={item.id} data-current={item.id === folder?.id || undefined} onClick={() => { dismiss(); onNavigate(item); }}>{item.name}</button>)}
              </nav>
              <div className="mobile-header-menu__separator" />
              <button type="button" disabled={readOnly} onClick={() => { dismiss(); onCreateFolder(parentId); }}><FolderPlus size={17} /> New folder</button>
              <button type="button" disabled={readOnly} onClick={() => { dismiss(); onCreateFile(parentId); }}><FilePlus size={17} /> New text file</button>
              <button type="button" disabled={readOnly} onClick={() => { dismiss(); onUpload(parentId); }}><UploadSimple size={17} /> Upload files</button>
              <button type="button" disabled={readOnly} onClick={() => { dismiss(); onImportFolder(parentId); }}><FolderOpen size={17} /> Import folder</button>
            </>}
          </MobileHeaderMenu>,
          headerElements.actions,
        )}

        <div className="folder-explorer__toolbar">
          <label className="folder-explorer__search">
            <MagnifyingGlass size={16} aria-hidden="true" />
            <span className="sr-only">Search this folder</span>
            <input type="search" value={search} placeholder="Search this folder" onChange={(event) => setSearch(event.target.value)} />
            {search && <button type="button" aria-label="Clear folder search" onClick={() => setSearch("")}><X size={14} /></button>}
          </label>
          <label className="folder-explorer__sort">
            <span>Sort</span>
            <select value={sortKey} aria-label="Sort folder contents by" onChange={(event) => setSortKey(event.target.value as FolderSortKey)}>
              <option value="name">Name</option>
              <option value="date">Date modified</option>
              <option value="type">Type</option>
              <option value="size">Size</option>
            </select>
          </label>
          <button className="folder-explorer__tool-button" type="button" aria-label={`Sort ${sortDirection === "asc" ? "descending" : "ascending"}`} title={`Sort ${sortDirection === "asc" ? "descending" : "ascending"}`} onClick={() => setSortDirection((current) => current === "asc" ? "desc" : "asc")}>
            {sortDirection === "asc" ? <SortAscending size={18} /> : <SortDescending size={18} />}
          </button>
          <div className="folder-explorer__view-options" role="group" aria-label="Folder view">
            <button type="button" aria-label="List view" aria-pressed={view === "list"} onClick={() => setView("list")}><ListBullets size={18} /></button>
            <button type="button" aria-label="Grid view" aria-pressed={view === "grid"} onClick={() => setView("grid")}><SquaresFour size={18} /></button>
          </div>
          <button className="folder-explorer__tool-button folder-explorer__import" type="button" disabled={readOnly} onClick={() => onUpload(parentId)}><UploadSimple size={18} /><span>Upload files</span></button>
          <button className="folder-explorer__tool-button folder-explorer__import" type="button" disabled={readOnly} onClick={() => onImportFolder(parentId)}><FolderOpen size={18} /><span>Import folder</span></button>
        </div>

        <div className="folder-explorer__content" onDragOver={(event) => { if (!readOnly) event.preventDefault(); }} onDrop={(event) => {
          if (readOnly || (event.target as Element).closest(".folder-explorer__row[data-folder-target]")) return;
          event.preventDefault();
          onExternalDrop(event.dataTransfer, parentId);
        }} onContextMenu={(event) => {
          if ((event.target as Element).closest(".folder-explorer__row")) return;
          event.preventDefault();
          onBlankContextMenu(parentId, event.clientX, event.clientY);
        }}>
          {children.length === 0 ? (
            <div className="folder-explorer__empty">
              <Folder size={38} weight="duotone" aria-hidden="true" />
              <p>This folder is empty.</p>
              {!readOnly && <div className="folder-explorer__empty-actions">
                <button className="button button--primary" type="button" onClick={() => onCreateFile(parentId)}><FilePlus size={17} /> New text file</button>
                <button className="button button--quiet" type="button" onClick={() => onCreateFolder(parentId)}><FolderPlus size={17} /> New folder</button>
                <button className="button button--quiet" type="button" onClick={() => onUpload(parentId)}><UploadSimple size={17} /> Upload</button>
                <button className="button button--quiet" type="button" onClick={() => onImportFolder(parentId)}><FolderOpen size={17} /> Import folder</button>
              </div>}
            </div>
          ) : orderedChildren.length === 0 ? (
            <div className="folder-explorer__empty folder-explorer__empty--search" role="status">
              <MagnifyingGlass size={38} weight="duotone" aria-hidden="true" />
              <p>No items match "{search.trim()}".</p>
              <button className="button button--quiet" type="button" onClick={() => setSearch("")}>Clear search</button>
            </div>
          ) : (
            <div className="folder-explorer__list" data-view={view} aria-label={`Contents of ${folder?.name ?? rootLabel}`}>
              {orderedChildren.map((entry) => (
                <button
                  className="folder-explorer__row"
                  key={entry.id}
                  type="button"
                  aria-pressed={selectedIds.has(entry.id)}
                  aria-label={`${entry.name}, ${entry.kind === "folder" ? "folder" : entry.mimeType || "file"}${offlineAvailability[entry.id] ? `, ${offlineStatusLabel(offlineAvailability[entry.id])}` : ""}`}
                  data-selected={selectedIds.has(entry.id) || undefined}
                  data-folder-target={entry.kind === "folder" ? entry.id : undefined}
                  onClick={(event) => {
                    if (suppressClick.current) {
                      suppressClick.current = false;
                      return;
                    }
                    onSelect(entry, { toggle: event.metaKey || event.ctrlKey, range: event.shiftKey, orderedIds });
                  }}
                  onDoubleClick={() => open(entry)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") open(entry);
                    else if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
                      const rows = Array.from(event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(".folder-explorer__row") ?? []);
                      const index = rows.indexOf(event.currentTarget);
                      const target = event.key === "Home" ? rows[0] : event.key === "End" ? rows.at(-1) : rows[index + (event.key === "ArrowUp" ? -1 : 1)];
                      if (target) { event.preventDefault(); target.focus(); }
                    }
                    else if (event.key === "ContextMenu" || event.shiftKey && event.key === "F10") {
                      event.preventDefault();
                      if (!selectedIds.has(entry.id)) onSelect(entry, { toggle: false, range: false, orderedIds });
                      const bounds = event.currentTarget.getBoundingClientRect();
                      onContextMenu(entry, bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
                    }
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    if (!selectedIds.has(entry.id)) onSelect(entry, { toggle: false, range: false, orderedIds });
                    onContextMenu(entry, event.clientX, event.clientY);
                  }}
                  onDragOver={entry.kind === "folder" && !readOnly ? (event) => { event.preventDefault(); event.currentTarget.dataset.dropTarget = "true"; } : undefined}
                  onDragLeave={entry.kind === "folder" && !readOnly ? (event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) delete event.currentTarget.dataset.dropTarget; } : undefined}
                  onDrop={entry.kind === "folder" && !readOnly ? (event) => { event.preventDefault(); event.stopPropagation(); delete event.currentTarget.dataset.dropTarget; onExternalDrop(event.dataTransfer, entry.id); } : undefined}
                  onPointerDown={(event) => handlePointerDown(event, entry)}
                  onPointerMove={handlePointerMove}
                  onPointerUp={(event) => finishPointer(event)}
                  onPointerCancel={(event) => finishPointer(event, true)}
                >
                  {entry.kind === "folder" ? <Folder size={24} weight="duotone" /> : <FileGlyph size={24} weight="duotone" />}
                  <span className="folder-explorer__name">{entry.name}</span>
                  <span className="folder-explorer__kind">{entry.kind === "folder" ? "Folder" : entry.mimeType || "File"}{offlineAvailability[entry.id] && <small data-offline-status={offlineAvailability[entry.id].status}>{offlineStatusLabel(offlineAvailability[entry.id])}</small>}</span>
                  <time className="folder-explorer__date" dateTime={new Date(entry.modifiedAt).toISOString()}>{dateFormatter.format(entry.modifiedAt)}</time>
                  <span className="folder-explorer__size">{formatEntrySize(entry)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
    </div>
  );
}
