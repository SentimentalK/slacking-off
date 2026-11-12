// Camera + pointer plumbing shared by the live and replay boards. Rendering
// stays in each page (they call `drawWorld` themselves); this hook only owns
// the camera, the integer-zoom wheel/drag gestures and tap-to-select.

import { useEffect, useRef } from 'preact/hooks';
import type { RefObject } from 'preact';
import { ZOOM_MAX, ZOOM_MIN, centerCamera, clampCamera, hitTest } from './render';
import type { Camera } from './render';
import type { Projection, Terrain } from './types';

const TILE = 16;

export interface BoardControlsOptions {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  wrapRef: RefObject<HTMLDivElement | null>;
  terrain: Terrain | null;
  /** Reads the frame currently on screen; the getter may close over a ref. */
  projection: () => Projection | null;
  onSelect?: (id: number | null) => void;
  /** Drag/wheel gestures; turn them off for a read-only board. */
  interactive?: boolean;
}

export function useBoardControls({
  canvasRef,
  wrapRef,
  terrain,
  projection,
  onSelect,
  interactive = true,
}: BoardControlsOptions): RefObject<Camera> {
  const cameraRef = useRef<Camera>({ zoom: 2, originX: 0, originY: 0 });
  const selectRef = useRef(onSelect);
  const projectionRef = useRef(projection);
  const centeredRef = useRef(false);

  useEffect(() => {
    selectRef.current = onSelect;
    projectionRef.current = projection;
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const map = terrain;
    const camera = cameraRef.current;

    const viewClamp = () => {
      if (!map) return;
      clampCamera(camera, map.width, map.height, wrap.clientWidth, wrap.clientHeight);
    };

    const center = () => {
      if (!map || wrap.clientWidth <= 0 || wrap.clientHeight <= 0) return false;
      centerCamera(camera, map, wrap.clientWidth, wrap.clientHeight);
      centeredRef.current = true;
      return true;
    };

    if (!centeredRef.current) center();

    const observer = new ResizeObserver(() => {
      if (!centeredRef.current && center()) return;
      viewClamp();
    });
    observer.observe(wrap);

    if (!interactive) {
      return () => observer.disconnect();
    }

    let dragging = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let startOriginX = 0;
    let startOriginY = 0;

    const onWheel = (event: WheelEvent) => {
      const current = projectionRef.current();
      if (!current) return;
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const localX = event.clientX - rect.left;
      const localY = event.clientY - rect.top;
      const before = TILE * Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(camera.zoom)));
      const worldX = camera.originX + localX / before;
      const worldY = camera.originY + localY / before;
      const nextZoom = Math.min(
        ZOOM_MAX,
        Math.max(ZOOM_MIN, Math.round(camera.zoom) + (event.deltaY < 0 ? 1 : -1)),
      );
      if (nextZoom === camera.zoom) return;
      const after = TILE * nextZoom;
      camera.zoom = nextZoom;
      camera.originX = worldX - localX / after;
      camera.originY = worldY - localY / after;
      viewClamp();
    };

    const onPointerDown = (event: PointerEvent) => {
      dragging = true;
      moved = false;
      startX = event.clientX;
      startY = event.clientY;
      startOriginX = camera.originX;
      startOriginY = camera.originY;
      canvas.setPointerCapture(event.pointerId);
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!dragging) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
      if (!moved) return;
      const rect = canvas.getBoundingClientRect();
      const tile = TILE * Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(camera.zoom)));
      camera.originX = startOriginX - dx / tile;
      camera.originY = startOriginY - dy / tile;
      clampCamera(camera, map?.width ?? 0, map?.height ?? 0, rect.width, rect.height);
    };

    const onPointerUp = (event: PointerEvent) => {
      if (dragging && !moved) {
        const current = projectionRef.current();
        if (current && map) {
          const rect = canvas.getBoundingClientRect();
          const id = hitTest(
            current,
            map,
            camera,
            event.clientX - rect.left,
            event.clientY - rect.top,
          );
          selectRef.current?.(id);
        }
      }
      dragging = false;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    };

    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    return () => {
      observer.disconnect();
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
    };
  }, [canvasRef, wrapRef, terrain, interactive]);

  return cameraRef;
}
