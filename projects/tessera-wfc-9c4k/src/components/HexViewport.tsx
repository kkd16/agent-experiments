import { useCallback, useEffect, useRef, useState } from 'react';
import type { ControllerHex, StatsHex } from '../hex/controller_hex';

/**
 * The hex viewport — a canvas the {@link ControllerHex} paints into, plus a hover lens that reads
 * any cell's surviving possibility count straight out of the live wavefunction. The controller owns
 * all drawing; this component only converts pointer position into a backing-store hit-test.
 */
export default function HexViewport({ controller, onStats }: { controller: ControllerHex; onStats: (s: StatsHex) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [lens, setLens] = useState<{ x: number; y: number; count: number; total: number } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    controller.attach(canvas, onStats);
    return () => controller.detach();
  }, [controller, onStats]);

  const onMove = useCallback(
    (e: React.PointerEvent) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const { w, h } = controller.backingSize;
      const px = ((e.clientX - rect.left) / rect.width) * w;
      const py = ((e.clientY - rect.top) / rect.height) * h;
      const cell = controller.cellAtBackingPx(px, py);
      if (cell < 0) {
        setLens(null);
        return;
      }
      const info = controller.lensInfo(cell);
      setLens({ x: e.clientX - rect.left, y: e.clientY - rect.top, count: info.count, total: info.total });
    },
    [controller],
  );

  const onLeave = useCallback(() => setLens(null), []);

  return (
    <div className="viewport viewport-hex" style={{ position: 'relative' }}>
      <canvas ref={canvasRef} className="board board-hex" onPointerMove={onMove} onPointerLeave={onLeave} />
      {lens && (
        <div className="hex-lens" style={{ left: lens.x + 14, top: lens.y + 14 }}>
          <strong>{lens.count === 1 ? 'collapsed' : `${lens.count} options`}</strong>
          <span>{lens.count}/{lens.total} tiles</span>
        </div>
      )}
      <span className="orbit-hint">hover a cell to inspect its possibilities</span>
    </div>
  );
}
