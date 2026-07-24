import { clampWindowBounds, type WindowBounds, type WindowViewport } from "./window-manager";

export function publicWindowBounds(viewport: WindowViewport): WindowBounds {
  const margin = viewport.width < 700 ? 12 : 28;
  return clampWindowBounds({
    x: Math.min(90, margin),
    y: Math.min(55, margin),
    width: Math.min(920, Math.max(0, viewport.width - margin * 2)),
    height: Math.min(680, Math.max(0, viewport.height - margin * 2)),
  }, viewport, { minWidth: 320, minHeight: 220 });
}
