import { useCallback, useEffect, useRef } from 'react';
import type { ControllerInf, StatsInf } from '../infinite/controller_inf';

/**
 * The "Boundless" viewport — a canvas the {@link ControllerInf} paints the visible slice of the
 * endless plane into, plus pointer handling that turns a drag into a pan and the wheel into a
 * pointer-anchored zoom. The controller owns the camera; this component only converts on-screen
 * input into backing-store coordinates and forwards it.
 */
export default function InfiniteViewport({
  controller,
  onStats,
}: {
  controller: ControllerInf;
  onStats: (s: StatsInf) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    controller.attach(canvas, onStats);
    return () => controller.detach();
  }, [controller, onStats]);

  // Convert a client point to backing-store pixels (the canvas is CSS-scaled to fit its box).
  const toBacking = useCallback((e: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width / rect.width;
    const sy = canvas.height / rect.height;
    return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy, sx, sy };
  }, []);

  const onDown = useCallback((e: React.PointerEvent) => {
    drag.current = { x: e.clientX, y: e.clientY, moved: false };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  }, []);

  const onMove = useCallback(
    (e: React.PointerEvent) => {
      const p = toBacking(e);
      if (drag.current) {
        const dxClient = e.clientX - drag.current.x;
        const dyClient = e.clientY - drag.current.y;
        drag.current = { x: e.clientX, y: e.clientY, moved: true };
        const canvas = canvasRef.current!;
        const rect = canvas.getBoundingClientRect();
        controller.panByPixels((dxClient * canvas.width) / rect.width, (dyClient * canvas.height) / rect.height);
      } else {
        controller.setHover(p.x, p.y);
      }
    },
    [controller, toBacking],
  );

  const onUp = useCallback(() => {
    drag.current = null;
  }, []);

  const onLeave = useCallback(() => {
    drag.current = null;
    controller.setHover(null);
  }, [controller]);

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const p = toBacking(e);
      controller.zoomAt(p.x, p.y, e.deltaY < 0 ? 1.12 : 1 / 1.12);
    },
    [controller, toBacking],
  );

  return (
    <div className="viewport viewport-inf">
      <canvas
        ref={canvasRef}
        className="board board-inf"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerLeave={onLeave}
        onWheel={onWheel}
      />
      <span className="orbit-hint">drag to pan · scroll to zoom · the world is endless</span>
    </div>
  );
}
