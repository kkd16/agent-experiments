import { useEffect, useRef } from 'react';

interface Props {
  view: number;
  tick: number;
  seed: number;
  count: number;
  dataPoints: () => Float64Array | null;
  modelSamples: (k: number, seed: number) => Float64Array | null;
  size?: number;
}

// The generator's output on its own, with the real data faint underneath: z ~ N(0, I) → G(z).
// As training converges the amber generated cloud should sit exactly on the grey data — the
// only thing a GAN ever promises is good *samples*, so this is the panel that says whether it
// worked. (Mode collapse — the generator's favourite failure — shows up here as the amber
// points piling onto a single blob or arm instead of covering the whole shape.)
export default function GANSamples({ view, tick, seed, count, dataPoints, modelSamples, size = 300 }: Props) {
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

    const toPx = (x: number) => ((x + view) / (2 * view)) * W;
    const toPy = (y: number) => ((view - y) / (2 * view)) * H;

    const data = dataPoints();
    if (data) {
      ctx.fillStyle = 'rgba(148,163,184,0.28)';
      for (let i = 0; i < data.length / 2; i++) {
        ctx.beginPath();
        ctx.arc(toPx(data[i * 2]), toPy(data[i * 2 + 1]), 0.8, 0, 2 * Math.PI);
        ctx.fill();
      }
    }

    const s = modelSamples(count, seed);
    if (s) {
      ctx.fillStyle = 'rgba(251,191,36,0.85)';
      for (let i = 0; i < s.length / 2; i++) {
        ctx.beginPath();
        ctx.arc(toPx(s[i * 2]), toPy(s[i * 2 + 1]), 1.6, 0, 2 * Math.PI);
        ctx.fill();
      }
    }
  }, [view, tick, seed, count, dataPoints, modelSamples, size]);

  return <canvas ref={ref} className="flow-canvas small" />;
}
