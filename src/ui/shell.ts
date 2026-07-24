import type { SurfaceSegment } from "./desktop-geometry";

export type TaskbarWindow = {
  id: string;
  areaId: string;
  focused?: boolean;
};

export function taskbarWindows<T extends TaskbarWindow>(windows: readonly T[], currentAreaId: string, limit = 6) {
  const ordered = [...windows].sort((left, right) => {
    const leftRank = left.focused ? 0 : left.areaId === currentAreaId ? 1 : 2;
    const rightRank = right.focused ? 0 : right.areaId === currentAreaId ? 1 : 2;
    return leftRank - rightRank;
  });
  return { visible: ordered.slice(0, limit), overflow: ordered.slice(limit) };
}

export function taskbarCapacity(viewportWidth: number, compact: boolean) {
  if (viewportWidth <= 760) return 2;
  if (compact || viewportWidth <= 1024) return 5;
  return 7;
}

export function areaDirectionalLabel(segment: SurfaceSegment, current: SurfaceSegment) {
  const column = segment.column - current.column;
  const row = segment.row - current.row;
  if (column === 0 && row === 0) return segment.column === 0 && segment.row === 0 ? "Home" : "Current";
  if (segment.column === 0 && segment.row === 0) return "Home";
  if (row === 0) return column < 0 ? "Left" : "Right";
  if (column === 0) return row < 0 ? "Above" : "Below";
  const vertical = row < 0 ? "Above" : "Below";
  const horizontal = column < 0 ? "left" : "right";
  return `${vertical} ${horizontal}`;
}

export function nextOccupiedArea(areas: readonly SurfaceSegment[], current: SurfaceSegment, axis: "x" | "y", direction: -1 | 1) {
  const candidates = areas.filter((area) => axis === "x"
    ? area.row === current.row && Math.sign(area.column - current.column) === direction
    : area.column === current.column && Math.sign(area.row - current.row) === direction);
  return candidates.sort((left, right) => axis === "x"
    ? Math.abs(left.column - current.column) - Math.abs(right.column - current.column)
    : Math.abs(left.row - current.row) - Math.abs(right.row - current.row))[0] ?? current;
}

export function occupiedAreaCount(areas: readonly { occupied: boolean }[]) {
  return areas.filter((area) => area.occupied).length;
}
