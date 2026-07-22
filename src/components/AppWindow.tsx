import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Minus, X } from "@phosphor-icons/react";
import {
  clampWindowBounds,
  resizeWindowBounds,
  type ResizeDirection,
  type WindowBounds,
} from "../ui/window-manager";

export type AppWindowProps = {
  id: string;
  title: string;
  titleId: string;
  bounds: WindowBounds;
  minWidth?: number;
  minHeight?: number;
  zIndex: number;
  focused: boolean;
  minimized: boolean;
  workspaceActive: boolean;
  mobile: boolean;
  onFocus: (id: string) => void;
  onBoundsChange: (id: string, bounds: WindowBounds) => void;
  onDragAtEdge?: (id: string, clientX: number, clientY: number, bounds: WindowBounds) => WindowBounds | null;
  onDragEnd?: (id: string, cancelled: boolean) => void;
  onMinimize: (id: string) => void;
  onClose: (id: string) => void;
  children: ReactNode | ((headerElements: AppWindowHeaderElements) => ReactNode);
  titleArea?: ReactNode;
  headerContent?: ReactNode;
};

export type AppWindowHeaderElements = {
  leading: HTMLDivElement | null;
  actions: HTMLDivElement | null;
};

type Interaction = {
  pointerId: number;
  target: HTMLElement;
  startX: number;
  startY: number;
  startBounds: WindowBounds;
  currentBounds: WindowBounds;
  direction?: ResizeDirection;
};

const RESIZE_DIRECTIONS: ResizeDirection[] = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];
const NO_DRAG_SELECTOR = "button, a, input, select, textarea, [contenteditable='true'], [data-window-no-drag]";

export function AppWindow({
  id,
  title,
  titleId,
  bounds,
  minWidth,
  minHeight,
  zIndex,
  focused,
  minimized,
  workspaceActive,
  mobile,
  onFocus,
  onBoundsChange,
  onDragAtEdge,
  onDragEnd,
  onMinimize,
  onClose,
  children,
  titleArea,
  headerContent,
}: AppWindowProps) {
  const windowRef = useRef<HTMLElement>(null);
  const [headerLeadingElement, setHeaderLeadingElement] = useState<HTMLDivElement | null>(null);
  const [headerActionsElement, setHeaderActionsElement] = useState<HTMLDivElement | null>(null);
  const interactionRef = useRef<Interaction | null>(null);
  const onBoundsChangeRef = useRef(onBoundsChange);
  onBoundsChangeRef.current = onBoundsChange;

  function viewport() {
    const parent = windowRef.current?.parentElement;
    return { width: parent?.clientWidth ?? 0, height: parent?.clientHeight ?? 0 };
  }

  function applyBounds(nextBounds: WindowBounds) {
    const element = windowRef.current;
    if (!element) return;
    element.style.left = `${nextBounds.x}px`;
    element.style.top = `${nextBounds.y}px`;
    element.style.width = `${nextBounds.width}px`;
    element.style.height = `${nextBounds.height}px`;
  }

  function beginInteraction(event: ReactPointerEvent<HTMLElement>, direction?: ResizeDirection) {
    if (mobile || event.button !== 0) return;
    if (!direction && (event.target as Element).closest(NO_DRAG_SELECTOR)) return;

    event.preventDefault();
    onFocus(id);
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    interactionRef.current = {
      pointerId: event.pointerId,
      target,
      startX: event.clientX,
      startY: event.clientY,
      startBounds: bounds,
      currentBounds: bounds,
      direction,
    };
  }

  function moveInteraction(event: ReactPointerEvent<HTMLElement>) {
    const interaction = interactionRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId) return;
    const delta = { x: event.clientX - interaction.startX, y: event.clientY - interaction.startY };
    const nextBounds = interaction.direction
      ? resizeWindowBounds(interaction.startBounds, interaction.direction, delta, viewport(), { minWidth, minHeight })
      : clampWindowBounds({
          ...interaction.startBounds,
          x: interaction.startBounds.x + delta.x,
          y: interaction.startBounds.y + delta.y,
        }, viewport(), { minWidth, minHeight });
    const transferredBounds = !interaction.direction ? onDragAtEdge?.(id, event.clientX, event.clientY, nextBounds) : null;
    interaction.currentBounds = transferredBounds ?? nextBounds;
    if (transferredBounds) {
      interaction.startX = event.clientX;
      interaction.startY = event.clientY;
      interaction.startBounds = transferredBounds;
    }
    applyBounds(interaction.currentBounds);
  }

  function finishInteraction(event: ReactPointerEvent<HTMLElement>, cancelled = false) {
    const interaction = interactionRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId) return;
    interactionRef.current = null;
    if (cancelled) applyBounds(interaction.startBounds);
    else onBoundsChangeRef.current(id, interaction.currentBounds);
    if (!interaction.direction) onDragEnd?.(id, cancelled);
    if (interaction.target.hasPointerCapture(interaction.pointerId)) {
      interaction.target.releasePointerCapture(interaction.pointerId);
    }
  }

  useEffect(() => () => {
    const interaction = interactionRef.current;
    if (interaction?.target.hasPointerCapture(interaction.pointerId)) {
      interaction.target.releasePointerCapture(interaction.pointerId);
    }
    interactionRef.current = null;
  }, []);

  const style: CSSProperties = mobile
    ? { position: "absolute", inset: 0, width: "100%", height: "100%", zIndex }
    : { position: "absolute", left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height, zIndex };

  return (
    <section
      ref={windowRef}
      id={id}
      className="app-window"
      data-app-window={id}
      data-focused={focused || undefined}
      data-minimized={minimized || undefined}
      data-workspace-hidden={!workspaceActive || undefined}
      data-mobile={mobile || undefined}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      aria-hidden={minimized || !workspaceActive || mobile && !focused || undefined}
      inert={!workspaceActive}
      style={style}
      onPointerDown={() => { if (!focused) onFocus(id); }}
    >
      <header
        className="app-window__header"
        data-window-drag-handle
        onPointerDown={beginInteraction}
        onPointerMove={moveInteraction}
        onPointerUp={finishInteraction}
        onPointerCancel={(event) => finishInteraction(event, true)}
        onLostPointerCapture={finishInteraction}
      >
        {typeof children === "function" && <div ref={setHeaderLeadingElement} className="app-window__header-leading" data-window-no-drag />}
        <div className="app-window__title-area" id={titleArea ? titleId : undefined}>
          {titleArea ?? <h2 id={titleId} className="app-window__title">{title}</h2>}
        </div>
        {(headerContent || typeof children === "function") && <div ref={setHeaderActionsElement} className="app-window__header-content" data-window-no-drag>{headerContent}</div>}
        <div className="app-window__controls" data-window-no-drag>
          <button className="app-window__control app-window__control--minimize" type="button" onClick={() => onMinimize(id)} aria-label={`Minimize ${title}`}>
            <Minus size={16} />
          </button>
          <button className="app-window__control app-window__control--close" type="button" onClick={() => onClose(id)} aria-label={`Close ${title}`}>
            <X size={16} />
          </button>
        </div>
      </header>
      <div className="app-window__content">{typeof children === "function" ? children({ leading: headerLeadingElement, actions: headerActionsElement }) : children}</div>
      {!mobile && RESIZE_DIRECTIONS.map((direction) => (
        <div
          key={direction}
          className={`app-window__resize-handle app-window__resize-handle--${direction}`}
          data-window-resize={direction}
          aria-hidden="true"
          onPointerDown={(event) => beginInteraction(event, direction)}
          onPointerMove={moveInteraction}
          onPointerUp={finishInteraction}
          onPointerCancel={(event) => finishInteraction(event, true)}
          onLostPointerCapture={finishInteraction}
        />
      ))}
    </section>
  );
}
