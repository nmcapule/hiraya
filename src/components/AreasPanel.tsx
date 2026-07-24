import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Desktop, SquaresFour } from "@phosphor-icons/react";
import { arrangeableAreaItems, type DesktopAreaItem } from "../ui/desktop-areas";
import type { SurfaceSegment } from "../ui/desktop-geometry";

type Props = {
  areas: readonly DesktopAreaItem[];
  canMutate: boolean;
  selectedRootCount: number;
  focusedWindowTitle?: string;
  arranging: boolean;
  onArrangeChange: (arranging: boolean) => void;
  onCreateAdjacent: (direction: "left" | "right" | "up" | "down") => void;
  onGo: (segment: SurfaceSegment) => void;
  onMoveSelected: (segment: SurfaceSegment) => void;
  onMoveFocusedWindow: (segment: SurfaceSegment) => void;
  onMoveContentsAndRemove: (segment: SurfaceSegment) => void;
  onArrange: (key: string, offset: -1 | 1) => void;
  onOpenHelp: () => void;
};

export function AreasPanel({ areas, canMutate, selectedRootCount, focusedWindowTitle, arranging, onArrangeChange, onCreateAdjacent, onGo, onMoveSelected, onMoveFocusedWindow, onMoveContentsAndRemove, onArrange, onOpenHelp }: Props) {
  const arrangeableAreas = arrangeableAreaItems(areas);
  return <section className="areas-panel">
    <header><Desktop size={25} weight="duotone" aria-hidden="true" /><div><h2>Areas</h2><p>Areas come from item and window positions in this viewport. They are not separately saved or named.</p></div></header>
    <div className="areas-panel__create" aria-label="Create area in a direction">
      <strong>Create area</strong>
      <button type="button" onClick={() => onCreateAdjacent("left")}><ArrowLeft /> Create left</button>
      <button type="button" onClick={() => onCreateAdjacent("right")}><ArrowRight /> Create right</button>
      <button type="button" onClick={() => onCreateAdjacent("up")}><ArrowUp /> Create above</button>
      <button type="button" onClick={() => onCreateAdjacent("down")}><ArrowDown /> Create below</button>
    </div>
    <div className="areas-panel__arrange">
      <div><strong>Arrange areas</strong><span>Moves contents between coordinate regions; files and windows are never deleted.</span></div>
      <button className="button button--quiet" type="button" disabled={!canMutate || !arranging && arrangeableAreas.length < 2} aria-pressed={arranging} onClick={() => onArrangeChange(!arranging)}>{arranging ? "Done arranging" : "Arrange"}</button>
    </div>
    <ol className="areas-panel__list">
      {areas.map((area) => {
        const arrangeIndex = arrangeableAreas.findIndex((candidate) => candidate.key === area.key);
        return <li key={area.key} aria-current={area.current ? "true" : undefined}>
        <div className="areas-panel__area-heading"><span><strong>{area.label}</strong><small>{area.coordinateLabel}</small></span><span>{area.rootItemCount} root {area.rootItemCount === 1 ? "item" : "items"} · {area.windowCount} {area.windowCount === 1 ? "window" : "windows"}</span></div>
        <div className="areas-panel__actions">
          <button className="button button--quiet" type="button" disabled={area.current} onClick={() => onGo(area.segment)}>{area.current ? "Current" : "Go"}</button>
          <button className="button button--quiet" type="button" disabled={!canMutate || !selectedRootCount || area.current} onClick={() => onMoveSelected(area.segment)}>Move selected root {selectedRootCount === 1 ? "item" : "items"} here</button>
          <button className="button button--quiet" type="button" disabled={!focusedWindowTitle || area.current} onClick={() => onMoveFocusedWindow(area.segment)}>{focusedWindowTitle ? `Move ${focusedWindowTitle} here` : "Move focused window here"}</button>
          {!area.current && (area.rootItemCount > 0 || area.windowCount > 0) && <button className="button button--quiet" type="button" disabled={!canMutate} onClick={() => onMoveContentsAndRemove(area.segment)}>Move contents to current and remove</button>}
          {arranging && area.occupied && <><button className="button button--quiet" type="button" disabled={!canMutate || arrangeIndex === 0} aria-label={`Move ${area.label} earlier`} onClick={() => onArrange(area.key, -1)}><ArrowUp /> Earlier</button><button className="button button--quiet" type="button" disabled={!canMutate || arrangeIndex === arrangeableAreas.length - 1} aria-label={`Move ${area.label} later`} onClick={() => onArrange(area.key, 1)}><ArrowDown /> Later</button></>}
        </div>
      </li>;
      })}
    </ol>
    {!canMutate && <p className="areas-panel__reader"><SquaresFour aria-hidden="true" /> You can visit every area. Moving items, arranging contents, and removing derived areas requires write access.</p>}
    <button className="inline-help-link" type="button" onClick={onOpenHelp}>How desktops and areas work</button>
  </section>;
}
