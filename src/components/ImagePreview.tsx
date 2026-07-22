import { useEffect, useRef, useState } from "react";

type Props = {
  src: string;
  alt: string;
  zoom: "fit" | number;
  onZoomChange: (zoom: number) => void;
};

type Pan = {
  x: number;
  y: number;
  scrollLeft: number;
  scrollTop: number;
};

type Point = { x: number; y: number };

type Pinch = {
  distance: number;
  zoom: number;
  imageXRatio: number;
  imageYRatio: number;
  midpoint: Point;
};

function gestureDetails(points: Point[], viewport: HTMLDivElement) {
  const [first, second] = points;
  const bounds = viewport.getBoundingClientRect();
  return {
    distance: Math.hypot(second.x - first.x, second.y - first.y),
    midpoint: {
      x: (first.x + second.x) / 2 - bounds.left,
      y: (first.y + second.y) / 2 - bounds.top,
    },
  };
}

export function ImagePreview({ src, alt, zoom, onZoomChange }: Props) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const panRef = useRef<Pan | null>(null);
  const pointersRef = useRef(new Map<number, Point>());
  const pinchRef = useRef<Pinch | null>(null);
  const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 });
  const fitted = zoom === "fit";

  useEffect(() => {
    const animationFrame = requestAnimationFrame(() => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      const pinch = pinchRef.current;
      if (pinch) {
        const currentZoom = zoom === "fit" ? pinch.zoom : zoom;
        const imageWidth = naturalSize.width * currentZoom;
        const imageHeight = naturalSize.height * currentZoom;
        const imageLeft = Math.max(0, (viewport.scrollWidth - imageWidth) / 2);
        const imageTop = Math.max(0, (viewport.scrollHeight - imageHeight) / 2);
        viewport.scrollLeft = imageLeft + pinch.imageXRatio * imageWidth - pinch.midpoint.x;
        viewport.scrollTop = imageTop + pinch.imageYRatio * imageHeight - pinch.midpoint.y;
      } else {
        viewport.scrollLeft = fitted ? 0 : (viewport.scrollWidth - viewport.clientWidth) / 2;
        viewport.scrollTop = fitted ? 0 : (viewport.scrollHeight - viewport.clientHeight) / 2;
      }
    });
    return () => cancelAnimationFrame(animationFrame);
  }, [fitted, naturalSize, zoom]);

  function finishPointer(pointerId: number) {
    const viewport = viewportRef.current;
    if (!viewport || !pointersRef.current.has(pointerId)) return;
    pointersRef.current.delete(pointerId);
    if (viewport.hasPointerCapture(pointerId)) viewport.releasePointerCapture(pointerId);

    const remaining = [...pointersRef.current.values()];
    const wasPinching = pinchRef.current !== null;
    pinchRef.current = null;
    if (remaining.length === 1 && (zoom !== "fit" || wasPinching)) {
      panRef.current = {
        x: remaining[0].x,
        y: remaining[0].y,
        scrollLeft: viewport.scrollLeft,
        scrollTop: viewport.scrollTop,
      };
      return;
    }

    panRef.current = null;
    delete viewport.dataset.panning;
  }

  return (
    <div
      ref={viewportRef}
      className="image-preview"
      data-fitted={fitted || undefined}
      onPointerDown={(event) => {
        if (event.pointerType === "mouse" && event.button !== 0) return;
        const viewport = viewportRef.current;
        if (!viewport || pointersRef.current.size >= 2) return;
        const point = { x: event.clientX, y: event.clientY };
        pointersRef.current.set(event.pointerId, point);
        viewport.setPointerCapture(event.pointerId);
        viewport.dataset.panning = "";

        const points = [...pointersRef.current.values()];
        if (points.length === 1) {
          if (!fitted) {
            panRef.current = {
              ...point,
              scrollLeft: viewport.scrollLeft,
              scrollTop: viewport.scrollTop,
            };
          }
          return;
        }

        if (points.length === 2 && naturalSize.width && naturalSize.height) {
          const gesture = gestureDetails(points, viewport);
          const initialZoom = fitted
            ? Math.min(1, viewport.clientWidth / naturalSize.width, viewport.clientHeight / naturalSize.height)
            : zoom;
          const imageWidth = naturalSize.width * initialZoom;
          const imageHeight = naturalSize.height * initialZoom;
          const imageLeft = Math.max(0, (viewport.scrollWidth - imageWidth) / 2);
          const imageTop = Math.max(0, (viewport.scrollHeight - imageHeight) / 2);
          pinchRef.current = {
            ...gesture,
            zoom: initialZoom,
            imageXRatio: Math.min(1, Math.max(0, (viewport.scrollLeft + gesture.midpoint.x - imageLeft) / imageWidth)),
            imageYRatio: Math.min(1, Math.max(0, (viewport.scrollTop + gesture.midpoint.y - imageTop) / imageHeight)),
          };
          panRef.current = null;
        }
      }}
      onPointerMove={(event) => {
        const viewport = viewportRef.current;
        if (!viewport || !pointersRef.current.has(event.pointerId)) return;
        pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

        const pinch = pinchRef.current;
        const points = [...pointersRef.current.values()];
        if (pinch && points.length >= 2) {
          const gesture = gestureDetails(points, viewport);
          pinch.midpoint = gesture.midpoint;
          const nextZoom = Math.min(8, Math.max(0.01, pinch.zoom * gesture.distance / pinch.distance));
          onZoomChange(Math.round(nextZoom * 1000) / 1000);
          return;
        }

        const pan = panRef.current;
        if (!pan || points.length !== 1) return;
        viewport.scrollLeft = pan.scrollLeft - (event.clientX - pan.x);
        viewport.scrollTop = pan.scrollTop - (event.clientY - pan.y);
      }}
      onPointerUp={(event) => finishPointer(event.pointerId)}
      onPointerCancel={(event) => finishPointer(event.pointerId)}
      onLostPointerCapture={(event) => finishPointer(event.pointerId)}
    >
      <div className="image-preview__stage">
        <img
          className="preview-image"
          src={src}
          alt={alt}
          draggable={false}
          onLoad={(event) => setNaturalSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
          style={fitted || !naturalSize.width ? undefined : {
            width: `${naturalSize.width * zoom}px`,
            height: `${naturalSize.height * zoom}px`,
          }}
        />
      </div>
    </div>
  );
}
