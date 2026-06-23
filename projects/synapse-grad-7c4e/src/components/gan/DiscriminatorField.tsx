import { useEffect, useRef } from 'react';
import type { DiscGrid } from '../../hooks/useGANTrainer';

interface Props {
  view: number;
  res: number;
  tick: number;
  showReal: boolean;
  showFake: boolean;
  showWarp: boolean;
  discGrid: (res: number) => DiscGrid | null;
  dataPoints: () => Float64Array | null;
  modelSamples: (k: number, seed: number) => Float64Array | null;
  generatorWarp: () => { polylines: Float64Array[] } | null;
  sampleSeed: number;
  sampleCount: number;
  size?: number;
}

// A diverging ramp: deep blue (the discriminator calls it FAKE) → neutral slate at the decision
// boundary → warm amber (it calls it REAL). The boundary — where D ≈ ½ for the probabilistic
// games, or the critic crosses 0 for WGAN — is the bright seam the two players fight over.
function diverging(t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, t));
  // blue (56,128,220) → slate (30,41,59) → amber (251,191,36)
  if (x < 0.5) {
    const f = x / 0.5;
    return [56 + (30 - 56) * f, 128 + (41 - 128) * f, 220 + (59 - 220) * f];
  }
  const f = (x - 0.5) / 0.5;
  return [30 + (251 - 30) * f, 41 + (191 - 41) * f, 59 + (36 - 59) * f];
}

// The headline of the GAN lab: the discriminator's **decision surface**, painted live as the
// two networks train. Real data is scattered in cyan, the generator's fakes in amber. Early on
// D paints a sharp boundary that fences the fakes out; as G learns to mimic the data the
// surface flattens toward a uniform ½ ("can't tell anymore") and the amber fakes settle right
// on top of the cyan data — the equilibrium of the game, made visible.
export default function DiscriminatorField({
  view,
  res,
  tick,
  showReal,
  showFake,
  showWarp,
  discGrid,
  dataPoints,
  modelSamples,
  generatorWarp,
  sampleSeed,
  sampleCount,
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
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, W, H);

    const grid = discGrid(res);
    if (grid) {
      const off = document.createElement('canvas');
      off.width = grid.res;
      off.height = grid.res;
      const octx = off.getContext('2d');
      if (octx) {
        const img = octx.createImageData(grid.res, grid.res);
        for (let i = 0; i < grid.values.length; i++) {
          // Map the score into [0,1] for the diverging ramp: σ values are already there; raw
          // WGAN critic scores are squashed by their grid max so the sign — not the scale —
          // drives the colour.
          const t = grid.signed ? 0.5 + 0.5 * Math.max(-1, Math.min(1, grid.values[i] / grid.maxAbs)) : grid.values[i];
          const [r, g, b] = diverging(t);
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
      const warp = generatorWarp();
      if (warp) {
        ctx.strokeStyle = 'rgba(226,232,240,0.22)';
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

    if (showReal) {
      const pts = dataPoints();
      if (pts) {
        ctx.fillStyle = 'rgba(56,189,248,0.55)';
        for (let i = 0; i < pts.length / 2; i++) {
          ctx.beginPath();
          ctx.arc(toPx(pts[i * 2]), toPy(pts[i * 2 + 1]), 1.1, 0, 2 * Math.PI);
          ctx.fill();
        }
      }
    }

    if (showFake) {
      const s = modelSamples(sampleCount, sampleSeed);
      if (s) {
        ctx.fillStyle = 'rgba(251,191,36,0.9)';
        for (let i = 0; i < s.length / 2; i++) {
          ctx.beginPath();
          ctx.arc(toPx(s[i * 2]), toPy(s[i * 2 + 1]), 1.5, 0, 2 * Math.PI);
          ctx.fill();
        }
      }
    }
  }, [view, res, tick, showReal, showFake, showWarp, discGrid, dataPoints, modelSamples, generatorWarp, sampleSeed, sampleCount, size]);

  return <canvas ref={ref} className="flow-canvas" />;
}
