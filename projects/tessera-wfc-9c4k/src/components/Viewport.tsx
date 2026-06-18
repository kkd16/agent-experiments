import { useEffect, useRef } from 'react';
import type { Controller, Stats } from '../wfc/controller';

export default function Viewport({ controller, onStats }: { controller: Controller; onStats: (s: Stats) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    controller.attach(canvas, onStats);
    return () => controller.detach();
  }, [controller, onStats]);

  return (
    <div className="viewport">
      <canvas ref={canvasRef} className="board" />
    </div>
  );
}
