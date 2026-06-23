import { useEffect, useRef } from 'react';
import type { LayerCurves } from '../../engine/kan';

interface Sel {
  layer: number;
  i: number;
  j: number;
}

interface Props {
  layers: LayerCurves[] | null;
  tick: number;
  selected: Sel | null;
  onSelect: (s: Sel) => void;
  width: number;
  height: number;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  layer: number;
  i: number;
  j: number;
}

// The iconic KAN picture: nodes in columns, and on every edge the *learned univariate function*
// φ_{j,i}(x) drawn inline as a little curve. (An MLP would have a single scalar weight here.)
// Edge prominence tracks each function's mean magnitude, so the network visibly prunes itself as
// unimportant edges fade. Click any edge box to inspect it. Rendered on a canvas so the curves
// animate cheaply while training.
export default function KANDiagram({ layers, tick, selected, onSelect, width, height }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxesRef = useRef<Box[]>([]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !layers || layers.length === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    // Column sizes: inputs of layer 0, then the output count of every layer.
    const counts = [layers[0].inF, ...layers.map((l) => l.outF)];
    const numCols = counts.length;
    const padX = 40;
    const padY = 30;
    const colX = (c: number) => padX + (c / (numCols - 1)) * (width - 2 * padX);
    const nodeY = (c: number, idx: number) => {
      const n = counts[c];
      if (n === 1) return height / 2;
      return padY + (idx / (n - 1)) * (height - 2 * padY);
    };

    const BW = 34;
    const BH = 26;
    const boxes: Box[] = [];

    // Edges + inline spline boxes (drawn first, under the nodes).
    for (let l = 0; l < layers.length; l++) {
      const layer = layers[l];
      let maxImp = 1e-9;
      for (const e of layer.edges) maxImp = Math.max(maxImp, e.importance);
      for (const e of layer.edges) {
        const x0 = colX(l);
        const y0 = nodeY(l, e.i);
        const x1 = colX(l + 1);
        const y1 = nodeY(l + 1, e.j);
        const rel = e.importance / maxImp;
        const isSel = selected && selected.layer === l && selected.i === e.i && selected.j === e.j;

        // connecting line, opacity by importance
        ctx.strokeStyle = `rgba(56,189,248,${0.06 + 0.5 * rel})`;
        ctx.lineWidth = isSel ? 2 : 0.6 + 1.6 * rel;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();

        // inline spline box at the edge midpoint
        const mx = (x0 + x1) / 2;
        const my = (y0 + y1) / 2;
        const bx = mx - BW / 2;
        const by = my - BH / 2;
        boxes.push({ x: bx, y: by, w: BW, h: BH, layer: l, i: e.i, j: e.j });

        ctx.fillStyle = isSel ? 'rgba(56,189,248,0.18)' : 'rgba(11,18,32,0.92)';
        ctx.strokeStyle = isSel ? '#38bdf8' : `rgba(148,163,184,${0.2 + 0.4 * rel})`;
        ctx.lineWidth = isSel ? 1.6 : 1;
        roundRect(ctx, bx, by, BW, BH, 5);
        ctx.fill();
        ctx.stroke();

        // the curve itself, autoscaled to the box
        let lo = Infinity;
        let hi = -Infinity;
        for (const v of e.ys) {
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        const span = Math.max(hi - lo, 1e-6);
        const padb = 4;
        const toX = (s: number) => bx + padb + ((BW - 2 * padb) * s) / (e.xs.length - 1);
        const toY = (v: number) => by + BH - padb - ((BH - 2 * padb) * (v - lo)) / span;
        // zero baseline if it falls inside the range
        if (lo < 0 && hi > 0) {
          ctx.strokeStyle = 'rgba(148,163,184,0.25)';
          ctx.lineWidth = 0.5;
          ctx.beginPath();
          ctx.moveTo(bx + padb, toY(0));
          ctx.lineTo(bx + BW - padb, toY(0));
          ctx.stroke();
        }
        ctx.strokeStyle = isSel ? '#7dd3fc' : `rgba(125,211,252,${0.45 + 0.5 * rel})`;
        ctx.lineWidth = isSel ? 1.8 : 1.2;
        ctx.beginPath();
        for (let s = 0; s < e.ys.length; s++) {
          const px = toX(s);
          const py = toY(e.ys[s]);
          if (s === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
    }

    // Nodes
    for (let c = 0; c < numCols; c++) {
      for (let idx = 0; idx < counts[c]; idx++) {
        const x = colX(c);
        const y = nodeY(c, idx);
        ctx.beginPath();
        ctx.arc(x, y, 7, 0, Math.PI * 2);
        ctx.fillStyle = c === 0 ? '#1e293b' : c === numCols - 1 ? '#312e6b' : '#0f1d33';
        ctx.fill();
        ctx.strokeStyle = 'rgba(148,163,184,0.5)';
        ctx.lineWidth = 1.2;
        ctx.stroke();
        // node sum glyph
        ctx.fillStyle = 'rgba(226,232,240,0.7)';
        ctx.font = '10px ui-sans-serif, system-ui';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('Σ', x, y + 0.5);
      }
    }

    // Column captions
    ctx.fillStyle = 'rgba(148,163,184,0.7)';
    ctx.font = '11px ui-sans-serif, system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let c = 0; c < numCols; c++) {
      const label = c === 0 ? 'in' : c === numCols - 1 ? 'out' : `h${c}`;
      ctx.fillText(label, colX(c), height - 16);
    }

    boxesRef.current = boxes;
  }, [layers, tick, selected, width, height]);

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * width;
    const py = ((e.clientY - rect.top) / rect.height) * height;
    let best: Box | null = null;
    let bestD = Infinity;
    for (const b of boxesRef.current) {
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      const d = (px - cx) ** 2 + (py - cy) ** 2;
      if (px >= b.x - 6 && px <= b.x + b.w + 6 && py >= b.y - 6 && py <= b.y + b.h + 6 && d < bestD) {
        bestD = d;
        best = b;
      }
    }
    if (best) onSelect({ layer: best.layer, i: best.i, j: best.j });
  };

  return (
    <canvas
      ref={canvasRef}
      style={{ width, height, maxWidth: '100%' }}
      onClick={onClick}
      className="kan-diagram"
      title="Click an edge to inspect its learned function"
    />
  );
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
