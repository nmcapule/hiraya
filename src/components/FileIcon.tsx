import { useLayoutEffect, useRef } from "react";
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
  LinkSimple,
} from "@phosphor-icons/react";
import type { DesktopEntry, EntryPosition } from "../types";
import { fileCapabilities } from "../ui/file-capabilities";

type Props = {
  entry: DesktopEntry;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
  onMove: (position: EntryPosition, targetParentId: string | null) => Promise<boolean>;
  onDragAtEdge: (clientX: number, clientY: number) => {
    deltaX: number;
    deltaY: number;
    maxX: number;
    maxY: number;
  } | null;
  onDragEnd: (cancelled: boolean) => void;
  getSnapPreview?: (position: EntryPosition) => EntryPosition;
  onContextMenu: (event: React.MouseEvent) => void;
  onExternalDrop?: (files: File[]) => void;
};

function FileTypeIcon({ entry }: { entry: DesktopEntry }) {
  if (entry.kind === "folder") return <Folder size={45} weight="duotone" aria-hidden="true" />;
  const { icon } = fileCapabilities(entry);
  const props = { size: 43, weight: "duotone" as const, "aria-hidden": true };

  if (icon === "image") return <FileImage {...props} />;
  if (icon === "video") return <FileVideo {...props} />;
  if (icon === "audio") return <FileAudio {...props} />;
  if (icon === "pdf") return <FilePdf {...props} />;
  if (icon === "archive") return <FileArchive {...props} />;
  if (icon === "url") return <LinkSimple {...props} />;
  if (icon === "code") return <FileCode {...props} />;
  if (icon === "text") return <FileText {...props} />;
  return <FileGlyph {...props} />;
}

export function FileIcon({ entry, selected, onSelect, onOpen, onMove, onDragAtEdge, onDragEnd, getSnapPreview, onContextMenu, onExternalDrop }: Props) {
  const iconRef = useRef<HTMLButtonElement>(null);
  const snapPreviewRef = useRef<HTMLSpanElement>(null);
  const drag = useRef<{
    pointerX: number;
    pointerY: number;
    pointerId: number;
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
    canvas: HTMLElement;
    finishing: boolean;
  } | null>(null);
  const onMoveRef = useRef(onMove);
  const onDragEndRef = useRef(onDragEnd);
  const getSnapPreviewRef = useRef(getSnapPreview);
  onMoveRef.current = onMove;
  onDragEndRef.current = onDragEnd;
  getSnapPreviewRef.current = getSnapPreview;

  useLayoutEffect(() => {
    const current = drag.current;
    const icon = iconRef.current;
    if (!current?.moved || !icon) return;
    current.baseX = icon.offsetLeft;
    current.baseY = icon.offsetTop;
    icon.style.transform = `translate3d(${current.x - current.baseX}px, ${current.y - current.baseY}px, 0)`;
  }, [entry.position.x, entry.position.y]);

  function setDropTarget(folderId: string | null) {
    document.querySelectorAll<HTMLElement>(".file-icon[data-drop-target]").forEach((element) => {
      delete element.dataset.dropTarget;
    });
    if (!folderId) return;
    document.querySelector<HTMLElement>(`.file-icon[data-folder-id="${CSS.escape(folderId)}"]`)?.setAttribute("data-drop-target", "true");
  }

  function findDropTarget(clientX: number, clientY: number) {
    const folders = Array.from(document.querySelectorAll<HTMLElement>(".file-icon[data-folder-id]"));
    for (const folder of folders.reverse()) {
      if (folder.dataset.folderId === entry.id) continue;
      const bounds = folder.getBoundingClientRect();
      if (clientX >= bounds.left && clientX <= bounds.right && clientY >= bounds.top && clientY <= bounds.bottom) {
        return folder.dataset.folderId ?? null;
      }
    }
    return null;
  }

  function updateSnapPreview(position: EntryPosition | null) {
    const preview = snapPreviewRef.current;
    if (!preview) return;
    if (!position) {
      delete preview.dataset.visible;
      return;
    }
    preview.style.left = `${position.x}px`;
    preview.style.top = `${position.y}px`;
    preview.dataset.visible = "true";
  }

  function handlePointerDown(event: React.PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;
    const canvas = event.currentTarget.parentElement;
    if (!canvas) return;

    event.preventDefault();
    const bounds = canvas.getBoundingClientRect();
    drag.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      pointerId: event.pointerId,
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
      canvas,
      finishing: false,
    };
    canvas.dataset.iconDragging = "true";
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
    drag.current.targetFolderId = findDropTarget(event.clientX, event.clientY);
    setDropTarget(drag.current.targetFolderId);
    updateSnapPreview(getSnapPreview && !drag.current.targetFolderId ? getSnapPreview({ x, y }) : null);
    iconRef.current.style.transform = `translate3d(${x - drag.current.baseX}px, ${y - drag.current.baseY}px, 0)`;
    iconRef.current.dataset.dragging = "true";
  }

  async function finishDrag(event: Pick<PointerEvent, "pointerId" | "clientX" | "clientY">, cancelled = false) {
    const completed = drag.current;
    if (!completed || completed.pointerId !== event.pointerId || completed.finishing) return;
    completed.finishing = true;
    if (iconRef.current?.hasPointerCapture(event.pointerId)) iconRef.current.releasePointerCapture(event.pointerId);
    const targetFolderId = completed.moved && !cancelled ? findDropTarget(event.clientX, event.clientY) : null;
    const position = { x: Math.round(completed.x), y: Math.round(completed.y) };
    const preview = getSnapPreviewRef.current;
    const move = completed.moved && !cancelled
      ? Promise.resolve().then(() => onMoveRef.current(preview && !targetFolderId ? preview(position) : position, targetFolderId))
      : Promise.resolve(!cancelled);
    setDropTarget(null);
    updateSnapPreview(null);
    const cleanUp = () => {
      if (drag.current !== completed) return;
      drag.current = null;
      delete completed.canvas.dataset.iconDragging;
      iconRef.current?.style.removeProperty("transform");
      if (iconRef.current) delete iconRef.current.dataset.dragging;
    };
    if (completed.moved) requestAnimationFrame(cleanUp);
    else cleanUp();

    let succeeded = !cancelled;
    if (completed.moved && !cancelled) {
      try {
        succeeded = await move;
      } catch {
        succeeded = false;
      }
    }
    onDragEndRef.current(cancelled || !succeeded);
  }

  return (
    <>
      <span ref={snapPreviewRef} className="file-icon-snap-preview" aria-hidden="true" />
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
        onPointerUp={(event) => { void finishDrag(event); }}
        onPointerCancel={(event) => { void finishDrag(event, true); }}
      >
        <span className="file-icon__art">
          <FileTypeIcon entry={entry} />
        </span>
        <span className="file-icon__name">{entry.name}</span>
      </button>
    </>
  );
}
