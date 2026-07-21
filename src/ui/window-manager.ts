export type WindowBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type WindowViewport = {
  width: number;
  height: number;
};

export type WindowPoint = {
  x: number;
  y: number;
};

export type ResizeDirection = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

export type WindowMinimumSize = {
  minWidth?: number;
  minHeight?: number;
};

export type InitialWindowOptions = WindowMinimumSize & {
  width?: number;
  height?: number;
  index?: number;
  margin?: number;
  stagger?: number;
};

export const DEFAULT_WINDOW_MIN_WIDTH = 320;
export const DEFAULT_WINDOW_MIN_HEIGHT = 220;

function finite(value: number, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function limit(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

function dimensions(viewport: WindowViewport) {
  return {
    width: Math.max(0, finite(viewport.width)),
    height: Math.max(0, finite(viewport.height)),
  };
}

function minimums(viewport: WindowViewport, minimumSize: WindowMinimumSize) {
  return {
    width: Math.min(viewport.width, Math.max(0, finite(minimumSize.minWidth ?? DEFAULT_WINDOW_MIN_WIDTH))),
    height: Math.min(viewport.height, Math.max(0, finite(minimumSize.minHeight ?? DEFAULT_WINDOW_MIN_HEIGHT))),
  };
}

export function clampWindowBounds(
  bounds: WindowBounds,
  viewportValue: WindowViewport,
  minimumSize: WindowMinimumSize = {},
): WindowBounds {
  const viewport = dimensions(viewportValue);
  const minimum = minimums(viewport, minimumSize);
  const width = limit(finite(bounds.width, minimum.width), minimum.width, viewport.width);
  const height = limit(finite(bounds.height, minimum.height), minimum.height, viewport.height);

  return {
    x: limit(finite(bounds.x), 0, viewport.width - width),
    y: limit(finite(bounds.y), 0, viewport.height - height),
    width,
    height,
  };
}

export function initialWindowBounds(
  viewportValue: WindowViewport,
  options: InitialWindowOptions = {},
): WindowBounds {
  const viewport = dimensions(viewportValue);
  const minimum = minimums(viewport, options);
  const margin = Math.max(0, finite(options.margin ?? 28));
  const stagger = Math.max(1, finite(options.stagger ?? 28));
  const index = Math.max(0, Math.floor(finite(options.index ?? 0)));
  const desiredWidth = options.width ?? Math.min(760, Math.max(minimum.width, viewport.width * 0.68));
  const desiredHeight = options.height ?? Math.min(560, Math.max(minimum.height, viewport.height * 0.72));
  const size = clampWindowBounds(
    { x: 0, y: 0, width: desiredWidth, height: desiredHeight },
    viewport,
    options,
  );
  const travelX = Math.max(0, viewport.width - size.width - margin * 2);
  const travelY = Math.max(0, viewport.height - size.height - margin * 2);
  const xSteps = Math.floor(travelX / stagger) + 1;
  const ySteps = Math.floor(travelY / stagger) + 1;

  return clampWindowBounds({
    ...size,
    x: Math.min(margin, Math.max(0, viewport.width - size.width)) + (index % xSteps) * stagger,
    y: Math.min(margin, Math.max(0, viewport.height - size.height)) + (index % ySteps) * stagger,
  }, viewport, options);
}

export function resizeWindowBounds(
  boundsValue: WindowBounds,
  direction: ResizeDirection,
  deltaValue: WindowPoint,
  viewportValue: WindowViewport,
  minimumSize: WindowMinimumSize = {},
): WindowBounds {
  const viewport = dimensions(viewportValue);
  const bounds = clampWindowBounds(boundsValue, viewport, minimumSize);
  const minimum = minimums(viewport, minimumSize);
  const delta = { x: finite(deltaValue.x), y: finite(deltaValue.y) };
  let { x, y, width, height } = bounds;

  if (direction.includes("w")) {
    const right = x + width;
    x = limit(x + delta.x, 0, right - minimum.width);
    width = right - x;
  } else if (direction.includes("e")) {
    width = limit(width + delta.x, minimum.width, viewport.width - x);
  }

  if (direction.includes("n")) {
    const bottom = y + height;
    y = limit(y + delta.y, 0, bottom - minimum.height);
    height = bottom - y;
  } else if (direction.includes("s")) {
    height = limit(height + delta.y, minimum.height, viewport.height - y);
  }

  return { x, y, width, height };
}
