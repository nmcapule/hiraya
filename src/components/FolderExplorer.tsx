import { useRef } from "react";
import {
  ArrowLeft,
  CaretRight,
  File as FileGlyph,
  FilePlus,
  Folder,
  FolderPlus,
  UploadSimple,
} from "@phosphor-icons/react";
import type { DesktopEntry, FolderEntry } from "../types";

export interface FolderExplorerProps {
  folder: FolderEntry | null;
  /** Ordered ancestors of folder, starting immediately below Desktop. */
  breadcrumbs: readonly FolderEntry[];
  children: readonly DesktopEntry[];
  onNavigate: (folder: FolderEntry | null) => void;
  onOpen: (entry: DesktopEntry) => void;
  onCreateFolder: (parentId: string | null) => void;
  onCreateFile: (parentId: string | null) => void;
  onUpload: (parentId: string | null) => void;
  onContextMenu: (entry: DesktopEntry, x: number, y: number) => void;
  onBlankContextMenu: (parentId: string | null, x: number, y: number) => void;
  selectedIds: ReadonlySet<string>;
  onSelect: (entry: DesktopEntry, options: { toggle: boolean; range: boolean; orderedIds: string[] }) => void;
  onMove: (entry: DesktopEntry, targetParentId: string | null) => void;
  readOnly?: boolean;
}

type DragState = {
  entry: DesktopEntry;
  pointerId: number;
  startX: number;
  startY: number;
  moved: boolean;
};

const byKindAndName = (a: DesktopEntry, b: DesktopEntry) =>
  a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "folder" ? -1 : 1;

export function FolderExplorer({
  folder,
  breadcrumbs,
  children,
  onNavigate,
  onOpen,
  onCreateFolder,
  onCreateFile,
  onUpload,
  onContextMenu,
  onBlankContextMenu,
  selectedIds,
  onSelect,
  onMove,
  readOnly = false,
}: FolderExplorerProps) {
  const drag = useRef<DragState | null>(null);
  const dropTarget = useRef<HTMLElement | null>(null);
  const suppressClick = useRef(false);
  const parentId = folder?.id ?? null;
  const orderedChildren = [...children].sort(byKindAndName);
  const trail = folder && breadcrumbs.at(-1)?.id !== folder.id ? [...breadcrumbs, folder] : breadcrumbs;

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
    if (event.button !== 0 || readOnly) return;
    drag.current = {
      entry,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (!current.moved && Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < 5) return;
    current.moved = true;
    event.currentTarget.dataset.dragging = "true";
    setDropTarget(findDropTarget(event.clientX, event.clientY));
  }

  function finishPointer(event: React.PointerEvent<HTMLButtonElement>, cancelled = false) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
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
    }
    setDropTarget(null);
    drag.current = null;
  }

  const previousFolder = trail.length > 1 ? trail.at(-2)! : null;

  return (
    <div className="file-window folder-explorer folder-explorer--embedded">
        <div className="folder-explorer__toolbar" aria-label="Folder actions">
          <button className="icon-button icon-button--wide" type="button" aria-label="Back to parent folder" disabled={!folder} onClick={() => onNavigate(previousFolder)}>
            <ArrowLeft size={17} /> <span>Back</span>
          </button>
          <button className="button button--quiet" type="button" disabled={readOnly} onClick={() => onCreateFolder(parentId)}><FolderPlus size={17} /> New folder</button>
          <button className="button button--quiet" type="button" disabled={readOnly} onClick={() => onCreateFile(parentId)}><FilePlus size={17} /> New text</button>
          <button className="button button--primary" type="button" disabled={readOnly} onClick={() => onUpload(parentId)}><UploadSimple size={17} /> Upload</button>
        </div>

        <nav className="folder-explorer__breadcrumbs" aria-label="Folder path">
          <button type="button" data-folder-target="" data-current={!folder || undefined} onClick={() => onNavigate(null)}>Desktop</button>
          {trail.map((item) => (
            <span className="folder-explorer__crumb" key={item.id}>
              <CaretRight size={13} aria-hidden="true" />
              <button type="button" data-folder-target={item.id} data-current={item.id === folder?.id || undefined} onClick={() => onNavigate(item)}>{item.name}</button>
            </span>
          ))}
        </nav>

        <div className="folder-explorer__content" onContextMenu={(event) => {
          if ((event.target as Element).closest(".folder-explorer__row")) return;
          event.preventDefault();
          onBlankContextMenu(parentId, event.clientX, event.clientY);
        }}>
          {children.length === 0 ? (
            <div className="folder-explorer__empty">
              <Folder size={38} weight="duotone" aria-hidden="true" />
              <p>This folder is empty.</p>
            </div>
          ) : (
            <div className="folder-explorer__list" role="listbox" aria-multiselectable="true" aria-label={`Contents of ${folder?.name ?? "Desktop"}`}>
              {orderedChildren.map((entry) => (
                <button
                  className="folder-explorer__row"
                  key={entry.id}
                  type="button"
                  role="option"
                  aria-selected={selectedIds.has(entry.id)}
                  data-selected={selectedIds.has(entry.id) || undefined}
                  data-folder-target={entry.kind === "folder" ? entry.id : undefined}
                  onClick={(event) => {
                    if (suppressClick.current) {
                      suppressClick.current = false;
                      return;
                    }
                    onSelect(entry, { toggle: event.metaKey || event.ctrlKey, range: event.shiftKey, orderedIds: orderedChildren.map((item) => item.id) });
                  }}
                  onDoubleClick={() => open(entry)}
                  onKeyDown={(event) => event.key === "Enter" && open(entry)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    if (!selectedIds.has(entry.id)) onSelect(entry, { toggle: false, range: false, orderedIds: orderedChildren.map((item) => item.id) });
                    onContextMenu(entry, event.clientX, event.clientY);
                  }}
                  onPointerDown={(event) => handlePointerDown(event, entry)}
                  onPointerMove={handlePointerMove}
                  onPointerUp={(event) => finishPointer(event)}
                  onPointerCancel={(event) => finishPointer(event, true)}
                >
                  {entry.kind === "folder" ? <Folder size={24} weight="duotone" /> : <FileGlyph size={24} weight="duotone" />}
                  <span className="folder-explorer__name">{entry.name}</span>
                  <span className="folder-explorer__kind">{entry.kind === "folder" ? "Folder" : entry.mimeType || "File"}</span>
                </button>
              ))}
            </div>
          )}
        </div>
    </div>
  );
}
