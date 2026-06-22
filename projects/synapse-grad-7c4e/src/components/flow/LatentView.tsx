import { useEffect, useRef } from 'react';

interface Props {
  view: number;
  tick: number;
  latentScatter: () => Float64Array | null;
  size?: number;
}

// The pushforward z = f(x): every data point mapped into latent space. A well-trained flow
// turns the (often wildly non-Gaussian) data cloud into a clean isotropic blob sitting on the
// unit Gaussian — the reference rings mark 1σ and 2σ. Watching the tangled data relax onto the
// rings is the most direct "the bijection is learning" signal there is.
export default function LatentView({ view, tick, latentScatter, size = 300 }: Props) {
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

    const cx = W / 2;
    const cy = H / 2;
    const toPx = (x: number) => ((x + view) / (2 * view)) * W;
    const toPy = (y: number) => ((view - y) / (2 * view)) * H;
    const scale = W / (2 * view);

    // axes
    ctx.strokeStyle = 'rgba(148,163,184,0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, cy);
    ctx.lineTo(W, cy);
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, H);
    ctx.stroke();

    // reference Gaussian rings at 1σ, 2σ
    ctx.strokeStyle = 'rgba(56,189,248,0.35)';
    for (const r of [1, 2]) {
      ctx.beginPath();
      ctx.arc(cx, cy, r * scale, 0, 2 * Math.PI);
      ctx.stroke();
    }

    const z = latentScatter();
    if (z) {
      ctx.fillStyle = 'rgba(244,114,182,0.5)';
      for (let i = 0; i < z.length / 2; i++) {
        ctx.beginPath();
        ctx.arc(toPx(z[i * 2]), toPy(z[i * 2 + 1]), 1, 0, 2 * Math.PI);
        ctx.fill();
      }
    }
  }, [view, tick, latentScatter, size]);

  return <canvas ref={ref} className="flow-canvas small" />;
}
