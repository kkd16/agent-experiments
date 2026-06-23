// The hex viewport renderer: lay the rhombus board out to fit the backing store, then paint each
// cell — a collapsed cell blits its variant's transparent-cornered hex bitmap; a still-superposed
// cell shows either a ghost of its averaged colour or an entropy-heat tint. Optional hairline hex
// outlines make the lattice legible. No GPU, no library — just `drawImage` and a hex path.

import { hexCenter, hexPath, SQRT3 } from './hexgrid';
import type { HexSolver } from './hexsolver';
import type { CompiledHexTileset } from './types_hex';

export type HexLayout = { s: number; ox: number; oy: number };

export type HexRenderOpts = {
  showGhost: boolean;
  showEntropy: boolean;
  showGrid: boolean;
};

/** Pick a circumradius + offset that frames the whole `cols × rows` rhombus inside `W × H`. */
export function layoutHex(cols: number, rows: number, W: number, H: number, pad: number): HexLayout {
  // board geometry at unit circumradius
  const maxCX = SQRT3 * (cols - 1 + (rows - 1) / 2);
  const maxCY = 1.5 * (rows - 1);
  const boardW = maxCX + SQRT3; // + half a hex width each side
  const boardH = maxCY + 2; // + circumradius each side
  const s = Math.max(2, Math.min((W - 2 * pad) / boardW, (H - 2 * pad) / boardH));
  const ox = (W - s * boardW) / 2 + (s * SQRT3) / 2;
  const oy = (H - s * boardH) / 2 + s;
  return { s, ox, oy };
}

/** Centre pixel of cell (q, r) under a layout. */
export function cellCenter(q: number, r: number, lay: HexLayout): [number, number] {
  const [x, y] = hexCenter(q, r, lay.s);
  return [lay.ox + x, lay.oy + y];
}

function heatColor(t: number): string {
  // cool → hot ramp (a √ ramp so rare high-entropy cells still read)
  const v = Math.sqrt(Math.max(0, Math.min(1, t)));
  const r = Math.round(40 + v * 200);
  const g = Math.round(70 + (1 - Math.abs(v - 0.5) * 2) * 120);
  const b = Math.round(200 - v * 150);
  return `rgba(${r},${g},${b},0.85)`;
}

export function renderHex(
  ctx: CanvasRenderingContext2D,
  set: CompiledHexTileset,
  solver: HexSolver,
  W: number,
  H: number,
  opts: HexRenderOpts,
): HexLayout {
  const lay = layoutHex(solver.cols, solver.rows, W, H, 18);
  const { s } = lay;
  for (let r = 0; r < solver.rows; r++) {
    for (let q = 0; q < solver.cols; q++) {
      const cell = q + solver.cols * r;
      const [cx, cy] = cellCenter(q, r, lay);
      const t = solver.collapsedTile(cell);
      if (t >= 0) {
        const bmp = set.variants[t].bitmap;
        try {
          ctx.drawImage(bmp, cx - s, cy - s, 2 * s, 2 * s);
        } catch {
          // a tainted/blocked bitmap (sandboxed thumbnail) — fall back to a flat fill
          const [rr, gg, bb] = set.variants[t].avg;
          hexPath(ctx, cx, cy, s);
          ctx.fillStyle = `rgb(${rr},${gg},${bb})`;
          ctx.fill();
        }
      } else if (opts.showEntropy) {
        hexPath(ctx, cx, cy, s);
        ctx.fillStyle = heatColor(solver.entropy01(cell));
        ctx.fill();
      } else if (opts.showGhost) {
        const [rr, gg, bb] = solver.ghostColor(cell);
        hexPath(ctx, cx, cy, s);
        ctx.fillStyle = `rgba(${Math.round(rr)},${Math.round(gg)},${Math.round(bb)},0.5)`;
        ctx.fill();
      }
      if (opts.showGrid) {
        hexPath(ctx, cx, cy, s);
        ctx.strokeStyle = 'rgba(255,255,255,0.12)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  }
  return lay;
}
