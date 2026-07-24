import { useId, useRef, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowSquareOut, ArrowUp, Desktop, ListBullets, MapTrifold, SquaresFour } from "@phosphor-icons/react";
import type { WindowListItem } from "../ui/panel-data";
import { arrangeableAreaItems, type DesktopAreaItem } from "../ui/desktop-areas";
import type { SurfaceSegment } from "../ui/desktop-geometry";
import { isLinearNavigationKey, linearNavigationIndex } from "../ui/keyboard-navigation";
import { occupiedAreaCount } from "../ui/shell";

export type WorkspaceOverviewView = "spatial" | "windows";

type Props = {
  areas: readonly DesktopAreaItem[];
  windows: readonly WindowListItem[];
  canMutate: boolean;
  selectedRootCount: number;
  focusedWindowId?: string;
  focusedWindowTitle?: string;
  arranging: boolean;
  onArrangeChange: (arranging: boolean) => void;
  onCreateAdjacent: (direction: "left" | "right" | "up" | "down") => void;
  onGo: (segment: SurfaceSegment) => void;
  onFocusWindow: (windowId: string) => void;
  onMoveSelected: (segment: SurfaceSegment) => void;
  onMoveFocusedWindow: (segment: SurfaceSegment) => void;
  onMoveContentsAndRemove: (segment: SurfaceSegment) => void;
  onArrange: (key: string, offset: -1 | 1) => void;
  onOpenHelp: () => void;
  view?: WorkspaceOverviewView;
  initialView?: WorkspaceOverviewView;
  onViewChange?: (view: WorkspaceOverviewView) => void;
};

export function WorkspaceOverview({ areas, windows, canMutate, selectedRootCount, focusedWindowId, focusedWindowTitle, arranging, onArrangeChange, onCreateAdjacent, onGo, onFocusWindow, onMoveSelected, onMoveFocusedWindow, onMoveContentsAndRemove, onArrange, onOpenHelp, view: controlledView, initialView = "spatial", onViewChange }: Props) {
  const [uncontrolledView, setUncontrolledView] = useState<WorkspaceOverviewView>(initialView);
  const view = controlledView ?? uncontrolledView;
  const tabsRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const arrangeable = arrangeableAreaItems(areas);
  const occupiedCount = occupiedAreaCount(areas);
  const arrangeReason = !canMutate ? "Write access is required to arrange regions." : arrangeable.length < 2 ? "Add content to at least two regions before arranging." : "";
  function selectView(next: WorkspaceOverviewView) {
    if (controlledView === undefined) setUncontrolledView(next);
    onViewChange?.(next);
  }
  function handleTabKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (!isLinearNavigationKey(event.key)) return;
    const tabs = Array.from(tabsRef.current?.querySelectorAll<HTMLButtonElement>("[role='tab']") ?? []);
    const next = linearNavigationIndex(tabs.indexOf(event.currentTarget), tabs.length, event.key, "horizontal");
    if (next === tabs.indexOf(event.currentTarget)) return;
    event.preventDefault();
    tabs[next]?.focus();
    tabs[next]?.click();
  }
  return <section className="workspace-overview">
    <header className="workspace-overview__header"><Desktop size={25} weight="duotone" aria-hidden="true" /><div><h2>Workspace Overview</h2><p>{occupiedCount} occupied {occupiedCount === 1 ? "region" : "regions"}, {windows.length} open {windows.length === 1 ? "window" : "windows"}. Regions are derived from coordinates.</p></div></header>
    <div ref={tabsRef} className="workspace-overview__tabs" role="tablist" aria-label="Workspace overview view" aria-orientation="horizontal">
      <button id={`${id}-spatial-tab`} type="button" role="tab" tabIndex={view === "spatial" ? 0 : -1} aria-selected={view === "spatial"} aria-controls={`${id}-spatial-panel`} onKeyDown={handleTabKeyDown} onClick={() => selectView("spatial")}><MapTrifold /> Spatial</button>
      <button id={`${id}-windows-tab`} type="button" role="tab" tabIndex={view === "windows" ? 0 : -1} aria-selected={view === "windows"} aria-controls={`${id}-windows-panel`} onKeyDown={handleTabKeyDown} onClick={() => selectView("windows")}><ListBullets /> Windows</button>
    </div>
    <div id={`${id}-spatial-panel`} role="tabpanel" aria-labelledby={`${id}-spatial-tab`} hidden={view !== "spatial"} tabIndex={0}>
      <div className="areas-panel__create" aria-label="Add an adjacent region"><strong>Add adjacent</strong><button type="button" onClick={() => onCreateAdjacent("left")}><ArrowLeft /> Left</button><button type="button" onClick={() => onCreateAdjacent("right")}><ArrowRight /> Right</button><button type="button" onClick={() => onCreateAdjacent("up")}><ArrowUp /> Above</button><button type="button" onClick={() => onCreateAdjacent("down")}><ArrowDown /> Below</button></div>
      <div className="areas-panel__arrange"><div><strong>Arrange occupied regions</strong><span>Moves {areas.reduce((sum, area) => sum + area.rootItemCount, 0)} root items and {windows.length} windows between coordinate regions. Nothing is deleted.</span>{arrangeReason && <small id={`${id}-arrange-reason`}>{arrangeReason}</small>}</div><button className="button button--quiet" type="button" disabled={Boolean(arrangeReason) && !arranging} aria-describedby={arrangeReason ? `${id}-arrange-reason` : undefined} title={arrangeReason || undefined} aria-pressed={arranging} onClick={() => onArrangeChange(!arranging)}>{arranging ? "Done" : "Arrange"}</button></div>
      <ol className="areas-panel__list">{areas.map((area) => {
        const arrangeIndex = arrangeable.findIndex((candidate) => candidate.key === area.key);
        const safeKey = area.key.replaceAll(/[^a-zA-Z0-9_-]/g, "-");
        const moveSelectedReason = !canMutate ? "Write access is required." : !selectedRootCount ? "Select one or more root items first." : area.current ? "The selected items are already in this region." : "";
        const moveWindowReason = !focusedWindowTitle ? "Focus a window first." : area.current ? "The focused window is already in this region." : "";
        return <li key={area.key} aria-current={area.current ? "true" : undefined}><div className="areas-panel__area-heading"><span><strong>{area.label}</strong><small>{area.coordinateLabel}</small></span><span>{area.rootItemCount} {area.rootItemCount === 1 ? "item" : "items"} · {area.windowCount} {area.windowCount === 1 ? "window" : "windows"}</span></div><div className="areas-panel__actions">
          <button className="button button--quiet" type="button" disabled={area.current} title={area.current ? "This is the current region." : undefined} onClick={() => onGo(area.segment)}>{area.current ? "Current" : "Navigate"}</button>
          <button className="button button--quiet" type="button" disabled={Boolean(moveSelectedReason)} aria-describedby={moveSelectedReason ? `${id}-${safeKey}-selected-reason` : undefined} title={moveSelectedReason || undefined} onClick={() => onMoveSelected(area.segment)}>Move {selectedRootCount || "selected"} here</button>
          <button className="button button--quiet" type="button" disabled={Boolean(moveWindowReason)} aria-describedby={moveWindowReason ? `${id}-${safeKey}-window-reason` : undefined} title={moveWindowReason || undefined} onClick={() => onMoveFocusedWindow(area.segment)}>Move focused window here</button>
          {!area.current && area.occupied && <button className="button button--quiet" type="button" disabled={!canMutate} onClick={() => onMoveContentsAndRemove(area.segment)}>Move {area.rootItemCount + area.windowCount} to current</button>}
          {arranging && area.occupied && <><button className="button button--quiet" type="button" disabled={!canMutate || arrangeIndex === 0} onClick={() => onArrange(area.key, -1)}><ArrowUp /> Earlier</button><button className="button button--quiet" type="button" disabled={!canMutate || arrangeIndex === arrangeable.length - 1} onClick={() => onArrange(area.key, 1)}><ArrowDown /> Later</button></>}
        </div>{moveSelectedReason && <small className="workspace-overview__reason" id={`${id}-${safeKey}-selected-reason`}>Items: {moveSelectedReason}</small>}{moveWindowReason && <small className="workspace-overview__reason" id={`${id}-${safeKey}-window-reason`}>Window: {moveWindowReason}</small>}</li>;
      })}</ol>
    </div>
    <div id={`${id}-windows-panel`} role="tabpanel" aria-labelledby={`${id}-windows-tab`} hidden={view !== "windows"} tabIndex={0}>{windows.length ? <ol className="workspace-overview__windows">{windows.map((window) => <li key={window.id}><button type="button" aria-current={window.id === focusedWindowId ? "true" : undefined} title={window.title} onClick={() => onFocusWindow(window.id)}><SquaresFour size={18} weight="duotone" /><span><strong>{window.title}</strong><small>{window.areaLabel}{window.minimized ? " · Minimized" : ""}</small></span><ArrowSquareOut /></button></li>)}</ol> : <div className="all-windows-panel__empty"><SquaresFour size={30} weight="duotone" /><strong>No open windows</strong><span>Opened files, folders, and apps appear here.</span></div>}</div>
    {!canMutate && <p className="areas-panel__reader"><Desktop /> Navigation is available. Moving and arranging requires write access.</p>}
    <button className="inline-help-link" type="button" onClick={onOpenHelp}>How workspace regions work</button>
  </section>;
}
