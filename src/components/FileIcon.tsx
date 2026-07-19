import { useRef } from "react";
import {
  File as FileGlyph,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FilePdf,
  FileText,
  FileVideo,
  Folder,
} from "@phosphor-icons/react";
import type { DesktopEntry, EntryPosition } from "../types";

type Props = {
  entry: DesktopEntry;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
  onMove: (position: EntryPosition, targetParentId: string | null) => void;
  onDragAtEdge: (clientX: number, clientY: number) => {
    deltaX: number;
    deltaY: number;
    maxX: number;
    maxY: number;
  } | null;
  onContextMenu: (event: React.MouseEvent) => void;
  onExternalDrop?: (files: File[]) => void;
};

function FileTypeIcon({ entry }: { entry: DesktopEntry }) {
  if (entry.kind === "folder") return <Folder size={45} weight="duotone" aria-hidden="true" />;
  const file = entry;
  const type = file.mimeType;
  const extension = file.name.split(".").pop()?.toLowerCase();
  const props = { size: 43, weight: "duotone" as const, "aria-hidden": true };

  if (type.startsWith("image/")) return <FileImage {...props} />;
  if (type.startsWith("video/")) return <FileVideo {...props} />;
  if (type.startsWith("audio/")) return <FileAudio {...props} />;
  if (type === "application/pdf") return <FilePdf {...props} />;
  if (type.includes("zip") || type.includes("compressed")) return <FileArchive {...props} />;
  if (["js", "jsx", "ts", "tsx", "css", "html", "json", "md"].includes(extension ?? "")) {
    return <FileCode {...props} />;
  }
  if (type.startsWith("text/")) return <FileText {...props} />;
  return <FileGlyph {...props} />;
}

export function FileIcon({ entry, selected, onSelect, onOpen, onMove, onDragAtEdge, onContextMenu, onExternalDrop }: Props) {
  const iconRef = useRef<HTMLButtonElement>(null);
  const drag = useRef<{
    pointerX: number;
    pointerY: number;
    maxX: number;
    maxY: number;
    moved: boolean;
    originX: number;
    originY: number;
    baseX: number;
    baseY: number;
    x: number;
    y: number;
    targetFolderId: string | null;
  } | null>(null);

  function setDropTarget(folderId: string | null) {
    document.querySelectorAll<HTMLElement>(".file-icon[data-drop-target]").forEach((element) => {
      delete element.dataset.dropTarget;
    });
    if (!folderId) return;
    document.querySelector<HTMLElement>(`.file-icon[data-folder-id="${CSS.escape(folderId)}"]`)?.setAttribute("data-drop-target", "true");
  }

  function handlePointerDown(event: React.PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || !selected) return;
    const desktop = event.currentTarget.parentElement;
    if (!desktop) return;

    const bounds = desktop.getBoundingClientRect();
    drag.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      maxX: Math.max(8, bounds.width - event.currentTarget.offsetWidth - 8),
      maxY: Math.max(8, bounds.height - event.currentTarget.offsetHeight - 8),
      moved: false,
      originX: event.currentTarget.offsetLeft,
      originY: event.currentTarget.offsetTop,
      baseX: event.currentTarget.offsetLeft,
      baseY: event.currentTarget.offsetTop,
      x: event.currentTarget.offsetLeft,
      y: event.currentTarget.offsetTop,
      targetFolderId: null,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    onSelect();
  }

  function handlePointerMove(event: React.PointerEvent<HTMLButtonElement>) {
    if (!drag.current || !iconRef.current) return;
    const deltaX = event.clientX - drag.current.pointerX;
    const deltaY = event.clientY - drag.current.pointerY;

    if (!drag.current.moved && Math.hypot(deltaX, deltaY) < 4) return;
    drag.current.moved = true;
    let x = Math.min(drag.current.maxX, Math.max(8, drag.current.originX + deltaX));
    let y = Math.min(drag.current.maxY, Math.max(8, drag.current.originY + deltaY));
    const pageChange = onDragAtEdge(event.clientX, event.clientY);
    if (pageChange) {
      x += pageChange.deltaX;
      y += pageChange.deltaY;
      drag.current.pointerX = event.clientX;
      drag.current.pointerY = event.clientY;
      drag.current.originX = x;
      drag.current.originY = y;
      drag.current.maxX = pageChange.maxX;
      drag.current.maxY = pageChange.maxY;
    }
    drag.current.x = x;
    drag.current.y = y;
    const target = document.elementsFromPoint(event.clientX, event.clientY)
      .map((element) => element.closest<HTMLElement>(".file-icon[data-folder-id]"))
      .find((element) => element?.dataset.folderId !== entry.id);
    drag.current.targetFolderId = target?.dataset.folderId ?? null;
    setDropTarget(drag.current.targetFolderId);
    iconRef.current.style.transform = `translate3d(${x - drag.current.baseX}px, ${y - drag.current.baseY}px, 0)`;
    iconRef.current.dataset.dragging = "true";
  }

  function finishDrag(event: React.PointerEvent<HTMLButtonElement>) {
    if (!drag.current) return;
    event.currentTarget.releasePointerCapture(event.pointerId);

    if (drag.current.moved) {
      onMove({ x: Math.round(drag.current.x), y: Math.round(drag.current.y) }, drag.current.targetFolderId);
    }
    iconRef.current?.style.removeProperty("transform");
    if (iconRef.current) delete iconRef.current.dataset.dragging;
    setDropTarget(null);
    drag.current = null;
  }

  return (
    <button
      ref={iconRef}
      className="file-icon"
      style={{
        "--file-x": `${entry.position.x}px`,
        "--file-y": `${entry.position.y}px`,
      } as React.CSSProperties}
      data-selected={selected || undefined}
      data-folder-id={entry.kind === "folder" ? entry.id : undefined}
      type="button"
      aria-label={`${entry.name}, ${entry.kind === "folder" ? "folder" : entry.mimeType || "file"}`}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onContextMenu={onContextMenu}
      onDragOver={entry.kind === "folder" ? (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.dataset.dropTarget = "true";
      } : undefined}
      onDragLeave={entry.kind === "folder" ? (event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) delete event.currentTarget.dataset.dropTarget;
      } : undefined}
      onDrop={entry.kind === "folder" ? (event) => {
        event.preventDefault();
        event.stopPropagation();
        delete event.currentTarget.dataset.dropTarget;
        onExternalDrop?.(Array.from(event.dataTransfer.files));
      } : undefined}
      onKeyDown={(event) => {
        if (event.key === "Enter") onOpen();
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
    >
      <span className="file-icon__art">
        <FileTypeIcon entry={entry} />
      </span>
      <span className="file-icon__name">{entry.name}</span>
    </button>
  );
}
