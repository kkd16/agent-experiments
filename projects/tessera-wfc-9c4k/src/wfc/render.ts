import type { Solver } from './solver';

export type RenderOptions = {
  cellPx: number;
  showGhost: boolean;
  showEntropy: boolean;
  showGrid: boolean;
  /** Cell currently under the pointer, or -1 — drawn with a highlight outline. */
  hover?: number;
  /** Hand-placed constraints (cell -> tile) — drawn with a corner marker. */
  pins?: ReadonlyMap<number, number>;
};

function heat(t: number): string {
  // t in [0,1]: deep indigo (low) -> teal -> amber (high entropy)
  const stops: [number, [number, number, number]][] = [
    [0, [30, 27, 75]],
    [0.5, [13, 148, 136]],
    [1, [251, 191, 36]],
  ];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [a0, a] = stops[i - 1];
      const [b0, b] = stops[i];
      const k = (t - a0) / (b0 - a0);
      const r = Math.round(a[0] + (b[0] - a[0]) * k);
      const g = Math.round(a[1] + (b[1] - a[1]) * k);
      const bl = Math.round(a[2] + (b[2] - a[2]) * k);
      return `rgb(${r},${g},${bl})`;
    }
  }
  return 'rgb(251,191,36)';
}

export function render(ctx: CanvasRenderingContext2D, solver: Solver, set: { variants: { bitmap: HTMLCanvasElement }[]; background: string }, o: RenderOptions): void {
  const { width, height } = solver;
  const px = o.cellPx;
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = set.background;
  ctx.fillRect(0, 0, width * px, height * px);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cell = y * width + x;
      const dx = x * px;
      const dy = y * px;
      const tile = solver.collapsedTile(cell);
      if (tile >= 0) {
        ctx.drawImage(set.variants[tile].bitmap, dx, dy, px, px);
        continue;
      }
      const poss = solver.possibilities(cell);
      if (poss === 0) {
        // contradiction cell — flag it
        ctx.fillStyle = '#ef4444';
        ctx.fillRect(dx, dy, px, px);
        continue;
      }
      if (o.showEntropy) {
        ctx.fillStyle = heat(solver.normEntropy(cell));
        ctx.fillRect(dx, dy, px, px);
      } else if (o.showGhost) {
        const [r, g, b] = solver.ghostColor(cell);
        const a = 0.25 + 0.5 * (1 - solver.normEntropy(cell));
        ctx.fillStyle = `rgba(${r | 0},${g | 0},${b | 0},${a})`;
        ctx.fillRect(dx, dy, px, px);
      }
    }
  }

  if (o.showGrid && px >= 10) {
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= width; x++) {
      ctx.moveTo(x * px + 0.5, 0);
      ctx.lineTo(x * px + 0.5, height * px);
    }
    for (let y = 0; y <= height; y++) {
      ctx.moveTo(0, y * px + 0.5);
      ctx.lineTo(width * px, y * px + 0.5);
    }
    ctx.stroke();
  }

  // Hand-placed constraints: a small amber corner triangle so painted cells read as deliberate.
  if (o.pins && o.pins.size) {
    const m = Math.max(3, Math.round(px * 0.28));
    ctx.fillStyle = '#fbbf24';
    for (const cell of o.pins.keys()) {
      const x = (cell % width) * px;
      const y = ((cell / width) | 0) * px;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + m, y);
      ctx.lineTo(x, y + m);
      ctx.closePath();
      ctx.fill();
    }
  }

  // Hover highlight: a bright outline on the inspected cell.
  if (o.hover != null && o.hover >= 0 && o.hover < width * height) {
    const x = (o.hover % width) * px;
    const y = ((o.hover / width) | 0) * px;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, px - 2, px - 2);
  }
}
