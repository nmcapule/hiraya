import { useEffect, useLayoutEffect, useRef } from "react";
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
  onSelect: (event: React.MouseEvent | React.PointerEvent) => void;
  onOpen: () => void;
  onMove: (position: EntryPosition, targetParentId: string | null, delta: EntryPosition) => Promise<boolean>;
  onDragAtEdge: (clientX: number, clientY: number) => {
    deltaX: number;
    deltaY: number;
    maxX: number;
    maxY: number;
  } | null;
  onDragEnd: (cancelled: boolean) => void;
  getSnapPreview?: (position: EntryPosition) => EntryPosition;
  onContextMenu: (event: React.MouseEvent) => void;
  onContextMenuAt: (x: number, y: number) => void;
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

export function FileIcon({ entry, selected, onSelect, onOpen, onMove, onDragAtEdge, onDragEnd, getSnapPreview, onContextMenu, onContextMenuAt, onExternalDrop }: Props) {
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
    pointerType: string;
    longPressed: boolean;
    longPressTimer?: number;
  } | null>(null);
  const onMoveRef = useRef(onMove);
  const onDragEndRef = useRef(onDragEnd);
  const getSnapPreviewRef = useRef(getSnapPreview);
  onMoveRef.current = onMove;
  onDragEndRef.current = onDragEnd;
  getSnapPreviewRef.current = getSnapPreview;

  useEffect(() => () => {
    if (drag.current?.longPressTimer) window.clearTimeout(drag.current.longPressTimer);
  }, []);

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
      if (folder.dataset.folderId === entry.id || folder.dataset.selected) continue;
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
      pointerType: event.pointerType,
      longPressed: false,
    };
    if (event.pointerType === "touch") {
      drag.current.longPressTimer = window.setTimeout(() => {
        const current = drag.current;
        if (!current || current.pointerId !== event.pointerId || current.moved) return;
        current.longPressTimer = undefined;
        current.longPressed = true;
        onContextMenuAt(event.clientX, event.clientY);
      }, 500);
    }
    canvas.dataset.iconDragging = "true";
    event.currentTarget.setPointerCapture(event.pointerId);
    onSelect(event);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLButtonElement>) {
    if (!drag.current || !iconRef.current) return;
    const deltaX = event.clientX - drag.current.pointerX;
    const deltaY = event.clientY - drag.current.pointerY;

    if (!drag.current.moved && Math.hypot(deltaX, deltaY) < 4) return;
    if (drag.current.longPressTimer) window.clearTimeout(drag.current.longPressTimer);
    drag.current.longPressTimer = undefined;
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
    if (iconRef.current.dataset.selected) {
      const groupDelta = { x: x - drag.current.originX, y: y - drag.current.originY };
      document.querySelectorAll<HTMLElement>(".file-icon[data-selected]").forEach((icon) => {
        if (icon === iconRef.current) return;
        icon.style.transform = `translate3d(${groupDelta.x}px, ${groupDelta.y}px, 0)`;
        icon.dataset.groupDragging = "true";
      });
    }
  }

  async function finishDrag(event: Pick<PointerEvent, "pointerId" | "clientX" | "clientY">, cancelled = false) {
    const completed = drag.current;
    if (!completed || completed.pointerId !== event.pointerId || completed.finishing) return;
    completed.finishing = true;
    if (completed.longPressTimer) window.clearTimeout(completed.longPressTimer);
    if (iconRef.current?.hasPointerCapture(event.pointerId)) iconRef.current.releasePointerCapture(event.pointerId);
    const targetFolderId = completed.moved && !cancelled ? findDropTarget(event.clientX, event.clientY) : null;
    const position = { x: Math.round(completed.x), y: Math.round(completed.y) };
    const preview = getSnapPreviewRef.current;
    const move = completed.moved && !cancelled
      ? Promise.resolve().then(() => onMoveRef.current(preview && !targetFolderId ? preview(position) : position, targetFolderId, { x: position.x - completed.originX, y: position.y - completed.originY }))
      : Promise.resolve(!cancelled);
    setDropTarget(null);
    updateSnapPreview(null);
    const cleanUp = () => {
      if (drag.current !== completed) return;
      drag.current = null;
      delete completed.canvas.dataset.iconDragging;
      iconRef.current?.style.removeProperty("transform");
      if (iconRef.current) delete iconRef.current.dataset.dragging;
      document.querySelectorAll<HTMLElement>(".file-icon[data-group-dragging]").forEach((icon) => {
        icon.style.removeProperty("transform");
        delete icon.dataset.groupDragging;
      });
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
    if (!cancelled && !completed.moved && !completed.longPressed && completed.pointerType === "touch") onOpen();
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
        data-entry-id={entry.id}
        data-folder-id={entry.kind === "folder" ? entry.id : undefined}
        type="button"
        aria-label={`${entry.name}, ${entry.kind === "folder" ? "folder" : entry.mimeType || "file"}`}
        aria-pressed={selected}
        onClick={(event) => { if (event.detail === 0) onSelect(event); }}
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
          else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
            const desktopBounds = event.currentTarget.closest(".desktop")?.getBoundingClientRect();
            const icons = Array.from(document.querySelectorAll<HTMLButtonElement>(".file-icon")).filter((icon) => {
              if (!desktopBounds) return true;
              const bounds = icon.getBoundingClientRect();
              return bounds.right > desktopBounds.left && bounds.left < desktopBounds.right && bounds.bottom > desktopBounds.top && bounds.top < desktopBounds.bottom;
            });
            const currentIndex = icons.indexOf(event.currentTarget);
            let target: HTMLButtonElement | undefined;
            if (event.key === "Home") target = icons[0];
            else if (event.key === "End") target = icons.at(-1);
            else {
              const currentBounds = event.currentTarget.getBoundingClientRect();
              const currentCenter = { x: currentBounds.left + currentBounds.width / 2, y: currentBounds.top + currentBounds.height / 2 };
              target = icons
                .filter((_, index) => index !== currentIndex)
                .map((icon) => {
                  const bounds = icon.getBoundingClientRect();
                  const dx = bounds.left + bounds.width / 2 - currentCenter.x;
                  const dy = bounds.top + bounds.height / 2 - currentCenter.y;
                  return { icon, dx, dy, distance: Math.hypot(dx, dy) };
                })
                .filter(({ dx, dy }) => event.key === "ArrowLeft" ? dx < 0 : event.key === "ArrowRight" ? dx > 0 : event.key === "ArrowUp" ? dy < 0 : dy > 0)
                .sort((a, b) => a.distance - b.distance)[0]?.icon;
            }
            if (target) { event.preventDefault(); target.focus(); target.click(); }
          }
          else if (event.key === "ContextMenu" || event.shiftKey && event.key === "F10") {
            event.preventDefault();
            const bounds = event.currentTarget.getBoundingClientRect();
            onContextMenuAt(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
          }
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
