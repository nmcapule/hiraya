import type { DesktopEntry, DesktopLayout, EntryPosition } from "../types";

export const FILE_ICON_SIZE = { width: 98, height: 102 } as const;
export const GRID_ORIGIN = { x: 22, y: 22 } as const;
export const GRID_STEP = { x: 104, y: 112 } as const;

const MINIMAP_RESERVED_SIZE = { width: 138, height: 111 } as const;

export type DesktopPage = {
  entries: DesktopEntry[];
  key: string;
  segment: { column: number; row: number };
};

export type ResponsiveDesktop = {
  capacity: number;
  breakCapacity: number;
  columns: number;
  rows: number;
  pages: DesktopPage[];
  positions: ReadonlyMap<string, EntryPosition>;
};

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

export function desktopSlots(size: { width: number; height: number }, reserveMinimap = false) {
  const maxX = Math.max(8, size.width - FILE_ICON_SIZE.width);
  const maxY = Math.max(8, size.height - FILE_ICON_SIZE.height);
  const columns = Math.max(1, Math.floor((maxX - GRID_ORIGIN.x) / GRID_STEP.x) + 1);
  const rows = Math.max(1, Math.floor((maxY - GRID_ORIGIN.y) / GRID_STEP.y) + 1);
  const slots: EntryPosition[] = [];
  for (let column = 0; column < columns; column += 1) {
    for (let row = 0; row < rows; row += 1) {
      const slot = {
        x: Math.min(maxX, GRID_ORIGIN.x + column * GRID_STEP.x),
        y: Math.min(maxY, GRID_ORIGIN.y + row * GRID_STEP.y),
      };
      const underMinimap = reserveMinimap
        && slot.x + FILE_ICON_SIZE.width > size.width - MINIMAP_RESERVED_SIZE.width
        && slot.y + FILE_ICON_SIZE.height > size.height - MINIMAP_RESERVED_SIZE.height;
      if (!underMinimap) slots.push(slot);
    }
  }
  return slots.length ? slots : [{ x: Math.min(maxX, GRID_ORIGIN.x), y: Math.min(maxY, GRID_ORIGIN.y) }];
}

function positionsOverlap(a: EntryPosition, b: EntryPosition) {
  return a.x < b.x + FILE_ICON_SIZE.width && a.x + FILE_ICON_SIZE.width > b.x
    && a.y < b.y + FILE_ICON_SIZE.height && a.y + FILE_ICON_SIZE.height > b.y;
}

export function nextAvailableDesktopSlot(size: { width: number; height: number }, occupied: readonly EntryPosition[], reserveMinimap = false, fallbackIndex = 0) {
  const slots = desktopSlots(size, reserveMinimap);
  return slots.find((slot) => occupied.every((position) => !positionsOverlap(position, slot))) ?? slots[fallbackIndex % slots.length];
}

export function projectLogicalAxis(value: number, viewportExtent: number, footprint: number) {
  const maximum = Math.max(0, viewportExtent - footprint);
  if (maximum === 0) return { segment: 0, local: 0 };
  const segment = Math.max(0, Math.ceil((value - maximum) / maximum));
  return { segment, local: value - segment * maximum };
}

export function projectLogicalPosition(position: EntryPosition, size: { width: number; height: number }) {
  const x = projectLogicalAxis(position.x, size.width, FILE_ICON_SIZE.width);
  const y = projectLogicalAxis(position.y, size.height, FILE_ICON_SIZE.height);
  return {
    segment: { column: x.segment, row: y.segment },
    local: { x: x.local, y: y.local },
  };
}

export function restoreLogicalPosition(position: EntryPosition, segment: { column: number; row: number }, size: { width: number; height: number }) {
  const maximumX = Math.max(0, size.width - FILE_ICON_SIZE.width);
  const maximumY = Math.max(0, size.height - FILE_ICON_SIZE.height);
  return {
    x: segment.column * maximumX + position.x,
    y: segment.row * maximumY + position.y,
  };
}

export function destinationSurfaceSegment(
  current: { column: number; row: number },
  sourcePage: { column: number; row: number },
  targetPage: { column: number; row: number },
  direction: "left" | "right" | "up" | "down",
) {
  if (sourcePage.column !== targetPage.column || sourcePage.row !== targetPage.row) return targetPage;
  if (direction === "right") return { column: current.column + 1, row: current.row };
  if (direction === "down") return { column: current.column, row: current.row + 1 };
  if (direction === "left" && current.column > 0) return { column: current.column - 1, row: current.row };
  if (direction === "up" && current.row > 0) return { column: current.column, row: current.row - 1 };
  // Stored coordinates cannot be negative, so a new leading view extends the positive surface.
  return direction === "left"
    ? { column: current.column + 1, row: current.row }
    : { column: current.column, row: current.row + 1 };
}

function buildPages(groups: readonly DesktopEntry[][], size: { width: number; height: number }, capacity: number) {
  const pages: DesktopPage[] = [];
  const positions = new Map<string, EntryPosition>();
  for (const group of groups) {
    const buckets = new Map<string, { segment: { column: number; row: number }; entries: DesktopEntry[] }>();
    for (const entry of group) {
      const projection = projectLogicalPosition(entry.position, size);
      const key = `${projection.segment.row}:${projection.segment.column}`;
      const bucket = buckets.get(key) ?? { segment: projection.segment, entries: [] };
      bucket.entries.push(entry);
      buckets.set(key, bucket);
      positions.set(entry.id, projection.local);
    }
    const orderedBuckets = [...buckets.values()].sort((a, b) => a.segment.row - b.segment.row || a.segment.column - b.segment.column);
    for (const bucket of orderedBuckets) {
      for (let index = 0; index < bucket.entries.length; index += capacity) {
        const pageEntries = bucket.entries.slice(index, index + capacity);
        pages.push({ entries: pageEntries, key: pageEntries[0].id, segment: bucket.segment });
      }
    }
  }
  return { pages, positions };
}

function assignSurfaceSegments(pages: readonly DesktopPage[], columns: number) {
  const naturalSegments = new Set(pages.map((page) => `${page.segment.row}:${page.segment.column}`));
  const used = new Set<string>();
  return pages.map((page, pageIndex) => {
    const naturalKey = `${page.segment.row}:${page.segment.column}`;
    if (!used.has(naturalKey)) {
      used.add(naturalKey);
      return page;
    }
    let candidateIndex = pageIndex;
    let segment = { column: candidateIndex % columns, row: Math.floor(candidateIndex / columns) };
    let key = `${segment.row}:${segment.column}`;
    while (used.has(key) || naturalSegments.has(key)) {
      candidateIndex += 1;
      segment = { column: candidateIndex % columns, row: Math.floor(candidateIndex / columns) };
      key = `${segment.row}:${segment.column}`;
    }
    used.add(key);
    return { ...page, segment };
  });
}

export function responsiveDesktop(entries: readonly DesktopEntry[], rootOrder: readonly string[], size: { width: number; height: number }, workspaceBreaks: DesktopLayout["workspaceBreaks"] = []): ResponsiveDesktop {
  const roots = new Map(entries.filter((entry) => entry.parentId === null).map((entry) => [entry.id, entry]));
  const ordered = rootOrder.map((id) => roots.get(id)).filter((entry): entry is DesktopEntry => Boolean(entry));
  const baseSlots = desktopSlots(size);
  const activeBreaks = new Set(workspaceBreaks.filter((workspaceBreak) => baseSlots.length <= workspaceBreak.maxCapacity).map((workspaceBreak) => workspaceBreak.entryId));
  const groups: DesktopEntry[][] = [];
  for (const entry of ordered) {
    if (!groups.length || activeBreaks.has(entry.id)) groups.push([]);
    groups.at(-1)!.push(entry);
  }
  const initial = buildPages(groups, size, baseSlots.length);
  const reserveMinimap = initial.pages.length > 1;
  const capacity = reserveMinimap ? desktopSlots(size, true).length : baseSlots.length;
  const built = capacity === baseSlots.length ? initial : buildPages(groups, size, capacity);
  const pageCount = Math.max(1, built.pages.length);
  const columns = Math.ceil(Math.sqrt(pageCount));
  const pages = assignSurfaceSegments(built.pages, columns);
  const { positions } = built;
  return { capacity, breakCapacity: baseSlots.length, columns, rows: Math.ceil(pageCount / columns), pages, positions };
}

function breakMapWithout(layout: DesktopLayout, entryId: string) {
  const existing = new Map(layout.workspaceBreaks.map((workspaceBreak) => [workspaceBreak.entryId, workspaceBreak.maxCapacity]));
  const removedCapacity = existing.get(entryId);
  existing.delete(entryId);
  if (removedCapacity !== undefined) {
    const index = layout.rootOrder.indexOf(entryId);
    for (let candidateIndex = index + 1; candidateIndex < layout.rootOrder.length; candidateIndex += 1) {
      const candidate = layout.rootOrder[candidateIndex];
      if (layout.workspaceBreaks.some((workspaceBreak) => workspaceBreak.entryId === candidate)) break;
      if (candidate !== entryId) {
        existing.set(candidate, removedCapacity);
        break;
      }
    }
  }
  return existing;
}

function orderedBreaks(rootOrder: string[], breaks: Map<string, number>) {
  return rootOrder.slice(1).flatMap((entryId) => {
    const maxCapacity = breaks.get(entryId);
    return maxCapacity === undefined ? [] : [{ entryId, maxCapacity }];
  });
}

export function createEdgeWorkspaceLayout(layout: DesktopLayout, pages: readonly DesktopPage[], entryId: string, activePageIndex: number, before: boolean, maxCapacity: number): DesktopLayout {
  const chunks = pages.map((page) => page.entries.map((entry) => entry.id));
  let insertionIndex = before ? activePageIndex : activePageIndex + 1;
  for (const [index, chunk] of chunks.entries()) {
    const entryIndex = chunk.indexOf(entryId);
    if (entryIndex < 0) continue;
    chunk.splice(entryIndex, 1);
    if (!chunk.length && index < insertionIndex) insertionIndex -= 1;
    break;
  }
  const retained = chunks.filter((chunk) => chunk.length > 0);
  insertionIndex = Math.max(0, Math.min(retained.length, insertionIndex));
  retained.splice(insertionIndex, 0, [entryId]);
  const rootOrder = retained.flat();
  const breaks = breakMapWithout(layout, entryId);
  if (insertionIndex > 0) breaks.set(entryId, Math.max(maxCapacity, breaks.get(entryId) ?? 0));
  const following = retained[insertionIndex + 1]?.[0];
  if (following) breaks.set(following, Math.max(maxCapacity, breaks.get(following) ?? 0));
  return { ...layout, rootOrder, workspaceBreaks: orderedBreaks(rootOrder, breaks) };
}

export function layoutForPageOrder(layout: DesktopLayout, chunks: readonly string[][], maxCapacity: number): DesktopLayout {
  const rootOrder = chunks.flat();
  return {
    ...layout,
    rootOrder,
    workspaceBreaks: chunks.slice(1).filter((chunk) => chunk.length > 0).map((chunk) => ({ entryId: chunk[0], maxCapacity })),
  };
}

export function moveEntryToWorkspaceLayout(layout: DesktopLayout, pages: readonly DesktopPage[], entryId: string, targetPageIndex: number, maxCapacity: number): DesktopLayout {
  const sourcePageIndex = pages.findIndex((page) => page.entries.some((entry) => entry.id === entryId));
  const boundedTargetIndex = Math.max(0, Math.min(pages.length - 1, targetPageIndex));
  if (sourcePageIndex < 0 || sourcePageIndex === boundedTargetIndex) return layout;

  const targetKey = pages[boundedTargetIndex]?.entries[0]?.id;
  if (!targetKey) return layout;
  const chunks = pages
    .map((page) => page.entries.map((entry) => entry.id).filter((id) => id !== entryId))
    .filter((chunk) => chunk.length > 0);
  const targetChunk = chunks.find((chunk) => chunk.includes(targetKey));
  if (!targetChunk) return layout;
  targetChunk.push(entryId);
  return layoutForPageOrder(layout, chunks, maxCapacity);
}

export function pagePositionTarget(pageCount: number, columns: number, size: EntryPosition, position: EntryPosition) {
  const rows = Math.ceil(Math.max(1, pageCount) / columns);
  const column = Math.max(0, Math.min(columns - 1, Math.floor(position.x / size.x)));
  const row = Math.max(0, Math.min(rows - 1, Math.floor(position.y / size.y)));
  return { column, row, index: Math.min(Math.max(0, pageCount - 1), row * columns + column) };
}
