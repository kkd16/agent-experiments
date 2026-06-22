import { useEffect, useRef } from 'react';

interface Props {
  view: number;
  res: number;
  tick: number;
  showPoints: boolean;
  showWarp: boolean;
  densityGrid: (res: number) => { values: Float64Array; res: number; maxP: number } | null;
  dataPoints: () => Float64Array | null;
  warpLines: () => { polylines: Float64Array[] } | null;
  size?: number;
}

// An inferno-like perceptual ramp (black → purple → red → orange → yellow → near-white) for the
// density field — the same family of luminous look the rest of the studio uses for fields.
const INFERNO: [number, number, number][] = [
  [0, 0, 4],
  [40, 11, 84],
  [101, 21, 110],
  [159, 42, 99],
  [212, 72, 66],
  [245, 125, 21],
  [250, 193, 39],
  [252, 255, 164],
];

function ramp(t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, t)) * (INFERNO.length - 1);
  const i = Math.min(INFERNO.length - 2, Math.floor(x));
  const f = x - i;
  const a = INFERNO[i];
  const b = INFERNO[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

// The headline of the flow lab: the **exact** model density p(x), evaluated in closed form on a
// grid and painted as a heatmap, with the training points scattered on top. Because a flow is a
// proper normalized density (unlike a VAE's lower bound or a diffusion model's score), this
// surface integrates to 1 and you can watch it pour itself into the data's shape as training
// runs. Optionally overlays the learned coordinate warp (a latent-space grid pushed through the
// inverse map).
export default function DensityField({
  view,
  res,
  tick,
  showPoints,
  showWarp,
  densityGrid,
  dataPoints,
  warpLines,
  size = 380,
}: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const W = size;
    const H = size;
    canvas.width = W;
    canvas.height = H;

    ctx.fillStyle = '#000208';
    ctx.fillRect(0, 0, W, H);

    const grid = densityGrid(res);
    if (grid) {
      // gamma-compress so the tails are visible, not just the peak
      const off = document.createElement('canvas');
      off.width = grid.res;
      off.height = grid.res;
      const octx = off.getContext('2d');
      if (octx) {
        const img = octx.createImageData(grid.res, grid.res);
        const inv = 1 / grid.maxP;
        for (let i = 0; i < grid.values.length; i++) {
          const t = Math.pow(grid.values[i] * inv, 0.45);
          const [r, g, b] = ramp(t);
          img.data[i * 4] = r;
          img.data[i * 4 + 1] = g;
          img.data[i * 4 + 2] = b;
          img.data[i * 4 + 3] = 255;
        }
        octx.putImageData(img, 0, 0);
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(off, 0, 0, W, H);
      }
    }

    const toPx = (x: number) => ((x + view) / (2 * view)) * W;
    const toPy = (y: number) => ((view - y) / (2 * view)) * H;

    if (showWarp) {
      const warp = warpLines();
      if (warp) {
        ctx.strokeStyle = 'rgba(125, 211, 252, 0.32)';
        ctx.lineWidth = 1;
        for (const pl of warp.polylines) {
          ctx.beginPath();
          for (let s = 0; s < pl.length / 2; s++) {
            const px = toPx(pl[s * 2]);
            const py = toPy(pl[s * 2 + 1]);
            if (s === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          }
          ctx.stroke();
        }
      }
    }

    if (showPoints) {
      const pts = dataPoints();
      if (pts) {
        ctx.fillStyle = 'rgba(226, 232, 240, 0.55)';
        const rad = pts.length / 2 > 800 ? 0.8 : 1.2;
        for (let i = 0; i < pts.length / 2; i++) {
          const px = toPx(pts[i * 2]);
          const py = toPy(pts[i * 2 + 1]);
          ctx.beginPath();
          ctx.arc(px, py, rad, 0, 2 * Math.PI);
          ctx.fill();
        }
      }
    }
  }, [view, res, tick, showPoints, showWarp, densityGrid, dataPoints, warpLines, size]);

  return <canvas ref={ref} className="flow-canvas" />;
}
