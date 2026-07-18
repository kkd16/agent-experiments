// A perceptual warm ("inferno"-ish) ramp for attention heatmaps: 0 → near-black, rising through
// magenta/red/orange to a bright yellow-white at 1. Anchored control points, linearly blended.
const STOPS: [number, [number, number, number]][] = [
  [0.0, [10, 8, 30]],
  [0.25, [78, 18, 84]],
  [0.5, [172, 40, 74]],
  [0.7, [224, 92, 40]],
  [0.85, [246, 158, 40]],
  [1.0, [252, 238, 158]],
];

export function heatColor(v: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, v));
  for (let i = 1; i < STOPS.length; i++) {
    if (x <= STOPS[i][0]) {
      const [t0, c0] = STOPS[i - 1];
      const [t1, c1] = STOPS[i];
      const f = (x - t0) / (t1 - t0 || 1);
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * f),
        Math.round(c0[1] + (c1[1] - c0[1]) * f),
        Math.round(c0[2] + (c1[2] - c0[2]) * f),
      ];
    }
  }
  return STOPS[STOPS.length - 1][1];
}

// Bilinear sample of a gridSide×gridSide field of patch weights at continuous grid coords
// (gx,gy) in [0, gridSide-1], so an upsampled overlay looks smooth rather than blocky.
export function bilinear(grid: Float64Array, gridSide: number, gx: number, gy: number): number {
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const x1 = Math.min(gridSide - 1, x0 + 1);
  const y1 = Math.min(gridSide - 1, y0 + 1);
  const fx = gx - x0;
  const fy = gy - y0;
  const a = grid[y0 * gridSide + x0];
  const b = grid[y0 * gridSide + x1];
  const c = grid[y1 * gridSide + x0];
  const d = grid[y1 * gridSide + x1];
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
}

// Paint a glyph with an attention field blended over it. The glyph is dimmed to a cool base and
// the heat ramp is added with opacity proportional to the (max-normalized) attention weight, so
// the region the classifier reads from glows. `smooth` bilinearly upsamples the patch grid.
export function drawAttentionOverlay(
  canvas: HTMLCanvasElement | null,
  pixels: Float64Array,
  imgSize: number,
  grid: Float64Array,
  gridSide: number,
  cell: number,
  smooth: boolean,
): void {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const D = imgSize * cell;
  canvas.width = D;
  canvas.height = D;
  let max = 1e-9;
  for (let i = 0; i < grid.length; i++) max = Math.max(max, grid[i]);
  const img = ctx.createImageData(D, D);
  const patch = imgSize / gridSide;
  for (let dy = 0; dy < D; dy++) {
    for (let dx = 0; dx < D; dx++) {
      const ix = Math.min(imgSize - 1, Math.floor(dx / cell));
      const iy = Math.min(imgSize - 1, Math.floor(dy / cell));
      // dimmed cool base from the glyph intensity
      const g = Math.max(0, Math.min(1, pixels[iy * imgSize + ix] + 0.5));
      let br = 10 + g * 70;
      let bg = 14 + g * 78;
      let bb = 22 + g * 96;
      // attention weight at this location
      let w: number;
      if (smooth) {
        const gx = Math.max(0, Math.min(gridSide - 1, (ix + 0.5) / patch - 0.5));
        const gy = Math.max(0, Math.min(gridSide - 1, (iy + 0.5) / patch - 0.5));
        w = bilinear(grid, gridSide, gx, gy);
      } else {
        const pr = Math.floor(iy / patch);
        const pc = Math.floor(ix / patch);
        w = grid[pr * gridSide + pc];
      }
      const nw = w / max;
      const hc = heatColor(nw);
      const alpha = 0.15 + 0.75 * nw;
      br = br * (1 - alpha) + hc[0] * alpha;
      bg = bg * (1 - alpha) + hc[1] * alpha;
      bb = bb * (1 - alpha) + hc[2] * alpha;
      const o = (dy * D + dx) * 4;
      img.data[o] = br;
      img.data[o + 1] = bg;
      img.data[o + 2] = bb;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}
