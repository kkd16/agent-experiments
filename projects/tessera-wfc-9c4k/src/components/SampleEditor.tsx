import { useCallback, useEffect, useRef, useState } from 'react';
import { blankSample, type Sample } from '../wfc/samples';

// An interactive pixel-art editor for the overlapping model's example bitmap. Draw on the grid
// and the studio re-learns its patterns from your drawing live — the clearest possible window
// into what "WFC learns local constraints from an example" actually means.

const SWATCHES = blankSample().palette; // the editor's default colour wells
const MIN = 4;
const MAX = 24;
const DISPLAY = 264; // target on-screen size (px); the backing store is crisp & integer-scaled

type Props = {
  value: Sample;
  onChange: (s: Sample) => void; // committed at the end of a stroke / on structural edits
  onClose: () => void;
};

/** Merge an incoming sample's palette with the default wells so any sample is forkable. */
function buildPalette(value: Sample): string[] {
  const pal = value.palette.length >= 2 ? value.palette.slice() : [];
  for (const c of SWATCHES) if (!pal.includes(c) && pal.length < 12) pal.push(c);
  return pal;
}

export default function SampleEditor({ value, onChange, onClose }: Props) {
  const [palette] = useState<string[]>(() => buildPalette(value));
  const [w, setW] = useState(Math.min(MAX, Math.max(MIN, value.width)));
  const [h, setH] = useState(Math.min(MAX, Math.max(MIN, value.height)));
  const [grid, setGrid] = useState<Int32Array>(() => Int32Array.from(value.grid));
  const [color, setColor] = useState(1 % palette.length);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const painting = useRef(false);
  const cellPx = Math.max(6, Math.floor(DISPLAY / Math.max(w, h)));

  const commit = useCallback(
    (g: Int32Array, width: number, height: number) => {
      onChange({ key: 'custom', name: 'Custom', blurb: 'Your own hand-drawn sample.', width, height, palette, grid: g });
    },
    [onChange, palette],
  );

  // ---- redraw the editor canvas whenever the bitmap changes ----------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = w * cellPx;
    canvas.height = h * cellPx;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        ctx.fillStyle = palette[grid[y * w + x]] ?? '#000';
        ctx.fillRect(x * cellPx, y * cellPx, cellPx, cellPx);
      }
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= w; x++) {
      ctx.moveTo(x * cellPx + 0.5, 0);
      ctx.lineTo(x * cellPx + 0.5, h * cellPx);
    }
    for (let y = 0; y <= h; y++) {
      ctx.moveTo(0, y * cellPx + 0.5);
      ctx.lineTo(w * cellPx, y * cellPx + 0.5);
    }
    ctx.stroke();
  }, [grid, w, h, cellPx, palette]);

  // ---- painting ------------------------------------------------------------
  const paintAt = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const x = Math.floor(((clientX - rect.left) / rect.width) * w);
      const y = Math.floor(((clientY - rect.top) / rect.height) * h);
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      setGrid((prev) => {
        if (prev[y * w + x] === color) return prev;
        const next = Int32Array.from(prev);
        next[y * w + x] = color;
        return next;
      });
    },
    [w, h, color],
  );

  const onPointerDown = (e: React.PointerEvent) => {
    painting.current = true;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    paintAt(e.clientX, e.clientY);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (painting.current) paintAt(e.clientX, e.clientY);
  };
  const endStroke = () => {
    if (!painting.current) return;
    painting.current = false;
    commit(grid, w, h);
  };

  // ---- structural edits ----------------------------------------------------
  const resize = (nw: number, nh: number) => {
    const next = new Int32Array(nw * nh);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) next[y * nw + x] = x < w && y < h ? grid[y * w + x] : 0;
    setW(nw);
    setH(nh);
    setGrid(next);
    commit(next, nw, nh);
  };
  const fill = () => {
    const next = new Int32Array(w * h).fill(color);
    setGrid(next);
    commit(next, w, h);
  };
  const clear = () => {
    const next = new Int32Array(w * h);
    setGrid(next);
    commit(next, w, h);
  };

  return (
    <div className="editor-overlay" role="dialog" aria-label="Sample editor" onPointerUp={endStroke} onPointerLeave={endStroke}>
      <div className="editor">
        <header className="editor-head">
          <h3>Draw a sample</h3>
          <button className="btn btn-icon" onClick={onClose} title="Close" type="button">
            ✕
          </button>
        </header>
        <p className="editor-hint">Paint local structure; WFC re-learns its patterns from your drawing as you go.</p>

        <div className="editor-body">
          <canvas
            ref={canvasRef}
            className="editor-canvas"
            style={{ width: w * cellPx, height: h * cellPx, touchAction: 'none' }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
          />
          <div className="editor-side">
            <div className="swatches">
              {palette.map((c, i) => (
                <button
                  key={c + i}
                  className={`swatch ${i === color ? 'sel' : ''}`}
                  style={{ background: c }}
                  onClick={() => setColor(i)}
                  title={c}
                  type="button"
                />
              ))}
            </div>
            <div className="editor-dims">
              <label className="field">
                <span className="field-label">
                  width <em>{w}</em>
                </span>
                <input type="range" min={MIN} max={MAX} value={w} onChange={(e) => resize(Number(e.target.value), h)} />
              </label>
              <label className="field">
                <span className="field-label">
                  height <em>{h}</em>
                </span>
                <input type="range" min={MIN} max={MAX} value={h} onChange={(e) => resize(w, Number(e.target.value))} />
              </label>
            </div>
            <div className="editor-actions">
              <button className="btn" onClick={fill} type="button">
                Fill
              </button>
              <button className="btn" onClick={clear} type="button">
                Clear
              </button>
            </div>
          </div>
        </div>

        <footer className="editor-foot">
          <button className="btn btn-primary" onClick={onClose} type="button">
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
