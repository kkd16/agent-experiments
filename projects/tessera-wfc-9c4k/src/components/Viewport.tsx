import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CellInfo, Controller, Stats } from '../wfc/controller';
import type { CompiledTileset } from '../wfc/types';

type Pop = { info: CellInfo; x: number; y: number };

const MAX_THUMBS = 24; // possibility thumbnails shown in the lens before "+N more"

export default function Viewport({
  controller,
  tileset,
  onStats,
  paintActive,
}: {
  controller: Controller;
  tileset: CompiledTileset;
  onStats: (s: Stats) => void;
  paintActive: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [pop, setPop] = useState<Pop | null>(null);
  const painting = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    controller.attach(canvas, onStats);
    return () => controller.detach();
  }, [controller, onStats]);

  // Cached data-URL thumbnails for the active set, for the inspector popover.
  const thumbs = useMemo(() => tileset.variants.map((v) => (v.patternBitmap ?? v.bitmap).toDataURL()), [tileset]);

  const cellFromEvent = useCallback(
    (clientX: number, clientY: number): number => {
      const canvas = canvasRef.current;
      if (!canvas) return -1;
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return -1;
      return controller.cellAtFraction((clientX - rect.left) / rect.width, (clientY - rect.top) / rect.height);
    },
    [controller],
  );

  const onMove = useCallback(
    (e: React.PointerEvent) => {
      const cell = cellFromEvent(e.clientX, e.clientY);
      controller.setHover(cell);
      if (cell < 0) {
        setPop(null);
        return;
      }
      if (painting.current) controller.paint(cell);
      const info = controller.inspect(cell);
      if (info) setPop({ info, x: e.clientX, y: e.clientY });
    },
    [cellFromEvent, controller],
  );

  const onLeave = useCallback(() => {
    controller.clearHover();
    setPop(null);
    painting.current = false;
  }, [controller]);

  const onDown = useCallback(
    (e: React.PointerEvent) => {
      const cell = cellFromEvent(e.clientX, e.clientY);
      if (cell < 0 || !paintActive) return;
      painting.current = true;
      controller.paint(cell);
      const info = controller.inspect(cell);
      if (info) setPop({ info, x: e.clientX, y: e.clientY });
    },
    [cellFromEvent, controller, paintActive],
  );

  const onUp = useCallback(() => {
    painting.current = false;
  }, []);

  return (
    <div className={`viewport ${paintActive ? 'painting' : ''}`}>
      <canvas
        ref={canvasRef}
        className="board"
        onPointerMove={onMove}
        onPointerDown={onDown}
        onPointerUp={onUp}
        onPointerLeave={onLeave}
      />
      {pop && <Lens pop={pop} thumbs={thumbs} />}
    </div>
  );
}

function Lens({ pop, thumbs }: { pop: Pop; thumbs: string[] }) {
  const { info } = pop;
  // Position to the lower-right of the cursor, clamped into the window.
  const W = 196;
  const left = Math.min(pop.x + 16, window.innerWidth - W - 8);
  const top = Math.min(pop.y + 16, window.innerHeight - 220);
  const shown = info.tiles.slice(0, MAX_THUMBS);
  const more = info.count - shown.length;

  return (
    <div className="lens" style={{ left, top, width: W }}>
      <div className="lens-head">
        <span>
          ({info.col}, {info.row})
        </span>
        {info.pinned && <span className="lens-pin">★ pinned</span>}
      </div>
      {info.collapsed >= 0 ? (
        <div className="lens-collapsed">
          {thumbs[info.collapsed] && <img src={thumbs[info.collapsed]} alt="" width={32} height={32} />}
          <span>collapsed</span>
        </div>
      ) : info.count === 0 ? (
        <div className="lens-contra">contradiction</div>
      ) : (
        <>
          <div className="lens-meta">
            <strong>{info.count}</strong> possibilities
          </div>
          <div className="lens-entropy" title={`entropy ${(info.entropy * 100).toFixed(0)}%`}>
            <span style={{ width: `${Math.round(info.entropy * 100)}%` }} />
          </div>
          <div className="lens-thumbs">
            {shown.map((t) => (thumbs[t] ? <img key={t} src={thumbs[t]} alt="" width={20} height={20} /> : null))}
          </div>
          {more > 0 && <div className="lens-more">+{more} more</div>}
        </>
      )}
    </div>
  );
}
