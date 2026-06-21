// Small helpers for painting flat intensity grids onto a canvas — shared by the vision
// views (input thumbnails, learned filters, feature maps, the draw pad).

import { diverging } from './colors';

export type ColorFn = (v: number) => [number, number, number];

// Grayscale-ish ramp for input images: value ≈ -0.5 (background) → dark, ≈ +0.5 (ink) →
// bright cool-white. Clamped to a sensible display range.
export function inkColor(v: number): [number, number, number] {
  const b = Math.max(0, Math.min(1, v + 0.5));
  return [Math.round(8 + b * 228), Math.round(12 + b * 226), Math.round(20 + b * 235)];
}

// Diverging blue/pink ramp for signed fields (filters, feature activations), normalized by
// the supplied scale so faint maps still read.
export function signedColor(v: number, scale: number): [number, number, number] {
  return diverging(scale > 0 ? v / scale : 0);
}

// Paint a [h*w] grid into the canvas at an integer cell size with crisp (nearest) pixels.
export function drawGrid(
  canvas: HTMLCanvasElement | null,
  data: Float64Array | number[],
  w: number,
  h: number,
  cell: number,
  color: ColorFn,
): void {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  canvas.width = w * cell;
  canvas.height = h * cell;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = color(data[y * w + x]);
      ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
      ctx.fillRect(x * cell, y * cell, cell, cell);
    }
  }
}

// Max absolute value of a slice, for normalizing signed color maps.
export function maxAbs(data: Float64Array | number[], start = 0, end = data.length): number {
  let m = 1e-9;
  for (let i = start; i < end; i++) {
    const a = Math.abs(data[i]);
    if (a > m) m = a;
  }
  return m;
}
