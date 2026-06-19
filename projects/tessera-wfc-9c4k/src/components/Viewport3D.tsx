import { useCallback, useEffect, useRef } from 'react';
import type { Controller3, Stats3 } from '../wfc3d/controller3';

/**
 * The 3D viewport — a canvas the {@link Controller3} draws into, plus pointer handling that turns
 * a drag into an orbit and the wheel into zoom. The controller owns the camera; this component
 * only translates input into `orbit`/`zoomBy` calls.
 */
export default function Viewport3D({ controller, onStats }: { controller: Controller3; onStats: (s: Stats3) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    controller.attach(canvas, onStats);
    return () => controller.detach();
  }, [controller, onStats]);

  const onDown = useCallback((e: React.PointerEvent) => {
    drag.current = { x: e.clientX, y: e.clientY };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  }, []);

  const onMove = useCallback(
    (e: React.PointerEvent) => {
      if (!drag.current) return;
      const dx = e.clientX - drag.current.x;
      const dy = e.clientY - drag.current.y;
      drag.current = { x: e.clientX, y: e.clientY };
      // drag right → spin clockwise; drag up → tilt down toward a top view
      controller.orbit(dx * 0.012, dy * 0.012);
    },
    [controller],
  );

  const onUp = useCallback(() => {
    drag.current = null;
  }, []);

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      controller.zoomBy(e.deltaY < 0 ? 1.1 : 0.9);
    },
    [controller],
  );

  return (
    <div className="viewport viewport3d">
      <canvas
        ref={canvasRef}
        className="board board3d"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerLeave={onUp}
        onWheel={onWheel}
      />
      <span className="orbit-hint">drag to orbit · scroll to zoom</span>
    </div>
  );
}
