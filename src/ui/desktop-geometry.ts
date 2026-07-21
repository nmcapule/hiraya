import type { DesktopEntry, EntryPosition } from "../types";

export const FILE_ICON_SIZE = { width: 98, height: 102 } as const;
export const GRID_ORIGIN = { x: 22, y: 22 } as const;
export const GRID_STEP = { x: 104, y: 112 } as const;

const MINIMAP_RESERVED_SIZE = { width: 132, height: 110 } as const;

export type DesktopPage = {
  entries: DesktopEntry[];
};

export type ResponsiveDesktop = {
  capacity: number;
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

function overlaps(a: EntryPosition, b: EntryPosition) {
  return a.x < b.x + FILE_ICON_SIZE.width && a.x + FILE_ICON_SIZE.width > b.x
    && a.y < b.y + FILE_ICON_SIZE.height && a.y + FILE_ICON_SIZE.height > b.y;
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

function placePage(entries: DesktopEntry[], slots: EntryPosition[], size: { width: number; height: number }, reserveMinimap: boolean) {
  const placed = new Map<string, EntryPosition>();
  const positions: EntryPosition[] = [];
  const maxX = Math.max(8, size.width - FILE_ICON_SIZE.width);
  const maxY = Math.max(8, size.height - FILE_ICON_SIZE.height);
  for (const entry of entries) {
    const desired = entry.position;
    const underMinimap = reserveMinimap
      && desired.x + FILE_ICON_SIZE.width > size.width - MINIMAP_RESERVED_SIZE.width
      && desired.y + FILE_ICON_SIZE.height > size.height - MINIMAP_RESERVED_SIZE.height;
    const fits = desired.x >= 8 && desired.y >= 8 && desired.x <= maxX && desired.y <= maxY && !underMinimap
      && positions.every((position) => !overlaps(position, desired));
    const position = fits ? desired : slots.find((slot) => positions.every((candidate) => !overlaps(candidate, slot)));
    if (!position) {
      const compact = new Map<string, EntryPosition>();
      entries.forEach((candidate, index) => compact.set(candidate.id, slots[index]));
      return compact;
    }
    positions.push(position);
    placed.set(entry.id, position);
  }
  return placed;
}

export function responsiveDesktop(entries: readonly DesktopEntry[], rootOrder: readonly string[], size: { width: number; height: number }): ResponsiveDesktop {
  const roots = new Map(entries.filter((entry) => entry.parentId === null).map((entry) => [entry.id, entry]));
  const ordered = rootOrder.map((id) => roots.get(id)).filter((entry): entry is DesktopEntry => Boolean(entry));
  const baseSlots = desktopSlots(size);
  const reserveMinimap = ordered.length > baseSlots.length;
  const slots = reserveMinimap ? desktopSlots(size, true) : baseSlots;
  const capacity = slots.length;
  const pages: DesktopPage[] = [];
  const positions = new Map<string, EntryPosition>();
  for (let index = 0; index < ordered.length; index += capacity) {
    const pageEntries = ordered.slice(index, index + capacity);
    pages.push({ entries: pageEntries });
    for (const [id, position] of placePage(pageEntries, slots, size, reserveMinimap)) positions.set(id, position);
  }
  const pageCount = Math.max(1, pages.length);
  const columns = Math.ceil(Math.sqrt(pageCount));
  return { capacity, columns, rows: Math.ceil(pageCount / columns), pages, positions };
}

export function pagePositionTarget(pageCount: number, columns: number, size: EntryPosition, position: EntryPosition) {
  const rows = Math.ceil(Math.max(1, pageCount) / columns);
  const column = Math.max(0, Math.min(columns - 1, Math.floor(position.x / size.x)));
  const row = Math.max(0, Math.min(rows - 1, Math.floor(position.y / size.y)));
  return { column, row, index: Math.min(Math.max(0, pageCount - 1), row * columns + column) };
}
