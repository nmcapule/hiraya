import type { DesktopLayout, EntryPosition } from "../types";

export const FILE_ICON_SIZE = { width: 98, height: 102 } as const;
export const GRID_ORIGIN = { x: 22, y: 22 } as const;
export const GRID_STEP = { x: 104, y: 112 } as const;

export function nextDesktopPosition(index: number, viewportHeight: number, base?: EntryPosition) {
  if (base) return { x: Math.max(12, base.x + (index % 4) * 18), y: Math.max(12, base.y + (index % 4) * 18) };
  const rows = Math.max(1, Math.floor((viewportHeight - 130) / GRID_STEP.y));
  return { x: GRID_ORIGIN.x + Math.floor(index / rows) * GRID_STEP.x, y: GRID_ORIGIN.y + (index % rows) * GRID_STEP.y };
}

export function snapAxis(value: number, origin: number, step: number, max: number) {
  if (max <= origin) return Math.max(8, max);
  const index = Math.max(0, Math.min(Math.floor((max - origin) / step), Math.round((value - origin) / step)));
  return origin + index * step;
}

export function desktopGrid(layout: DesktopLayout) {
  const columns = Math.max(1, Math.min(layout.columns, layout.views.length));
  return { columns, rows: Math.ceil(layout.views.length / columns) };
}

export function viewPage(layout: DesktopLayout, viewId: string) {
  const { columns, rows } = desktopGrid(layout);
  const index = Math.max(0, layout.views.findIndex((view) => view.id === viewId));
  return { index, columns, rows, column: index % columns, row: Math.floor(index / columns) };
}

export function desktopPositionTarget(layout: DesktopLayout, size: EntryPosition, position: EntryPosition) {
  const { columns, rows } = desktopGrid(layout);
  const column = Math.max(0, Math.min(columns - 1, Math.floor(position.x / size.x)));
  const row = Math.max(0, Math.min(rows - 1, Math.floor(position.y / size.y)));
  const index = Math.min(layout.views.length - 1, row * columns + column);
  return { column, row, view: layout.views[index] };
}
