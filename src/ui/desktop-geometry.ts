import type { DesktopEntry, EntryPosition } from "../types";
import type { DesktopIconMetrics } from "../lib/themes";

export const FILE_ICON_SIZE = { width: 98, height: 102 } as const;
export const GRID_ORIGIN = { x: 22, y: 22 } as const;
export const GRID_STEP = { x: 104, y: 112 } as const;
export const DEFAULT_ICON_METRICS: DesktopIconMetrics = { ...FILE_ICON_SIZE, stepX: GRID_STEP.x, stepY: GRID_STEP.y };

const MINIMAP_RESERVED_SIZE = { width: 138, height: 111 } as const;

export type SurfaceSegment = { column: number; row: number };

export type DesktopPage = {
  entries: DesktopEntry[];
  key: string;
  segment: SurfaceSegment;
};

export type ResponsiveDesktop = {
  capacity: number;
  columns: number;
  rows: number;
  minColumn: number;
  minRow: number;
  maxColumn: number;
  maxRow: number;
  pages: DesktopPage[];
  positions: ReadonlyMap<string, EntryPosition>;
};

export type DesktopPositionUpdate = { entryId: string; position: EntryPosition };
export type SurfaceSegmentMove = { source: SurfaceSegment; target: SurfaceSegment };

export function segmentKey(segment: SurfaceSegment) {
  return `${segment.row}:${segment.column}`;
}

export function nextDesktopPosition(index: number, viewportHeight: number, base?: EntryPosition, metrics = DEFAULT_ICON_METRICS) {
  if (base) return { x: base.x + (index % 4) * 18, y: base.y + (index % 4) * 18 };
  const rows = Math.max(1, Math.floor((viewportHeight - 130) / metrics.stepY));
  return { x: GRID_ORIGIN.x + Math.floor(index / rows) * metrics.stepX, y: GRID_ORIGIN.y + (index % rows) * metrics.stepY };
}

export function snapAxis(value: number, origin: number, step: number, max: number) {
  if (max <= origin) return Math.max(8, max);
  const index = Math.max(0, Math.min(Math.floor((max - origin) / step), Math.round((value - origin) / step)));
  return origin + index * step;
}

export function desktopSlots(size: { width: number; height: number }, reserveMinimap = false, metrics = DEFAULT_ICON_METRICS) {
  const maxX = Math.max(8, size.width - metrics.width);
  const maxY = Math.max(8, size.height - metrics.height);
  const columns = Math.max(1, Math.floor((maxX - GRID_ORIGIN.x) / metrics.stepX) + 1);
  const rows = Math.max(1, Math.floor((maxY - GRID_ORIGIN.y) / metrics.stepY) + 1);
  const slots: EntryPosition[] = [];
  for (let column = 0; column < columns; column += 1) {
    for (let row = 0; row < rows; row += 1) {
      const slot = {
        x: Math.min(maxX, GRID_ORIGIN.x + column * metrics.stepX),
        y: Math.min(maxY, GRID_ORIGIN.y + row * metrics.stepY),
      };
      const underMinimap = reserveMinimap
        && slot.x + metrics.width > size.width - MINIMAP_RESERVED_SIZE.width
        && slot.y + metrics.height > size.height - MINIMAP_RESERVED_SIZE.height;
      if (!underMinimap) slots.push(slot);
    }
  }
  return slots.length ? slots : [{ x: Math.min(maxX, GRID_ORIGIN.x), y: Math.min(maxY, GRID_ORIGIN.y) }];
}

function positionsOverlap(a: EntryPosition, b: EntryPosition, metrics: DesktopIconMetrics) {
  return a.x < b.x + metrics.width && a.x + metrics.width > b.x
    && a.y < b.y + metrics.height && a.y + metrics.height > b.y;
}

export function nextAvailableDesktopSlot(size: { width: number; height: number }, occupied: readonly EntryPosition[], reserveMinimap = false, fallbackIndex = 0, metrics = DEFAULT_ICON_METRICS) {
  const slots = desktopSlots(size, reserveMinimap, metrics);
  return slots.find((slot) => occupied.every((position) => !positionsOverlap(position, slot, metrics))) ?? slots[fallbackIndex % slots.length];
}

export function projectLogicalAxis(value: number, viewportExtent: number) {
  const extent = Math.max(1, viewportExtent);
  const segment = Math.floor(value / extent);
  return { segment, local: value - segment * extent };
}

export function projectLogicalPosition(position: EntryPosition, size: { width: number; height: number }) {
  const x = projectLogicalAxis(position.x, size.width);
  const y = projectLogicalAxis(position.y, size.height);
  return {
    segment: { column: x.segment, row: y.segment },
    local: { x: x.local, y: y.local },
  };
}

export function restoreLogicalPosition(position: EntryPosition, segment: SurfaceSegment, size: { width: number; height: number }) {
  return {
    x: segment.column * Math.max(1, size.width) + position.x,
    y: segment.row * Math.max(1, size.height) + position.y,
  };
}

export function responsiveDesktop(entries: readonly DesktopEntry[], size: { width: number; height: number }, metrics = DEFAULT_ICON_METRICS): ResponsiveDesktop {
  const buckets = new Map<string, DesktopPage>();
  const positions = new Map<string, EntryPosition>();
  for (const entry of entries) {
    if (entry.parentId !== null) continue;
    const projection = projectLogicalPosition(entry.position, size);
    const key = segmentKey(projection.segment);
    const page = buckets.get(key) ?? { entries: [], key, segment: projection.segment };
    page.entries.push(entry);
    buckets.set(key, page);
    positions.set(entry.id, projection.local);
  }
  const pages = [...buckets.values()]
    .map((page) => ({ ...page, entries: [...page.entries].sort((a, b) => a.id.localeCompare(b.id)) }))
    .sort((a, b) => a.segment.row - b.segment.row || a.segment.column - b.segment.column);
  const columns = pages.map((page) => page.segment.column);
  const rows = pages.map((page) => page.segment.row);
  const minColumn = Math.min(0, ...columns);
  const maxColumn = Math.max(0, ...columns);
  const minRow = Math.min(0, ...rows);
  const maxRow = Math.max(0, ...rows);
  return {
    capacity: desktopSlots(size, false, metrics).length,
    columns: maxColumn - minColumn + 1,
    rows: maxRow - minRow + 1,
    minColumn,
    minRow,
    maxColumn,
    maxRow,
    pages,
    positions,
  };
}

export function reorderDesktopPages(
  pages: readonly DesktopPage[],
  sourceKey: string,
  targetIndex: number,
  size: { width: number; height: number },
): DesktopPositionUpdate[] {
  const sourceIndex = pages.findIndex((page) => page.key === sourceKey);
  const boundedTarget = Math.max(0, Math.min(pages.length - 1, targetIndex));
  if (sourceIndex < 0 || sourceIndex === boundedTarget) return [];
  const groups = pages.map((page) => page.entries);
  const [moved] = groups.splice(sourceIndex, 1);
  groups.splice(boundedTarget, 0, moved);
  return groups.flatMap((entries, index) => entries.map((entry) => {
    const local = projectLogicalPosition(entry.position, size).local;
    return { entryId: entry.id, position: restoreLogicalPosition(local, pages[index].segment, size) };
  }));
}

export function reorderSurfaceSegments(
  segments: readonly SurfaceSegment[],
  sourceKey: string,
  targetIndex: number,
): SurfaceSegmentMove[] {
  const sourceIndex = segments.findIndex((segment) => segmentKey(segment) === sourceKey);
  const boundedTarget = Math.max(0, Math.min(segments.length - 1, targetIndex));
  if (sourceIndex < 0 || sourceIndex === boundedTarget) return [];
  const reordered = [...segments];
  const [moved] = reordered.splice(sourceIndex, 1);
  reordered.splice(boundedTarget, 0, moved);
  return reordered.map((source, index) => ({ source, target: segments[index] }));
}
