import { useId } from "react";
import { ArrowSquareOut, Desktop, SquaresFour } from "@phosphor-icons/react";
import { groupWindowsByArea, type WindowListItem } from "../ui/panel-data";

export type AllWindowsPanelProps = {
  windows: readonly WindowListItem[];
  activeAreaId?: string;
  focusedWindowId?: string;
  onFocusWindow: (windowId: string) => void;
  onNavigateArea: (areaId: string) => void;
};

export function AllWindowsPanel({ windows, activeAreaId, focusedWindowId, onFocusWindow, onNavigateArea }: AllWindowsPanelProps) {
  const groups = groupWindowsByArea(windows);
  const titleId = useId();
  function focusWindow(window: WindowListItem) {
    if (window.areaId !== activeAreaId) onNavigateArea(window.areaId);
    onFocusWindow(window.id);
  }

  return <section className="all-windows-panel" aria-labelledby={titleId}>
    <header><SquaresFour size={24} weight="duotone" aria-hidden="true" /><div><h2 id={titleId}>All windows</h2><p>{windows.length} open {windows.length === 1 ? "window" : "windows"} across {groups.length} {groups.length === 1 ? "area" : "areas"}.</p></div></header>
    {groups.length === 0 ? <div className="all-windows-panel__empty" role="status"><Desktop size={30} weight="duotone" aria-hidden="true" /><strong>No open windows</strong><span>Opened files and folders will appear here.</span></div> : <div className="all-windows-panel__groups">
      {groups.map((group, index) => <section key={group.id} aria-labelledby={`${titleId}-area-${index}`}>
        <header><h3 id={`${titleId}-area-${index}`}>{group.label}</h3><button className="button button--quiet" type="button" disabled={group.id === activeAreaId} onClick={() => onNavigateArea(group.id)}>{group.id === activeAreaId ? "Current area" : "Go to area"}</button></header>
        <ul>{group.windows.map((window) => <li key={window.id}><button type="button" aria-current={window.id === focusedWindowId ? "true" : undefined} onClick={() => focusWindow(window)}><SquaresFour size={18} weight="duotone" aria-hidden="true" /><span><strong>{window.title}</strong>{window.minimized && <small>Minimized</small>}</span><ArrowSquareOut size={16} aria-hidden="true" /></button></li>)}</ul>
      </section>)}
    </div>}
  </section>;
}
