import { useEffect, useRef } from 'react';
import { META_DOMAIN } from '../../engine/meta';

interface Props {
  grid: Float64Array;
  curves: Float64Array[]; // ground-truth curves of sampled tasks
  width: number;
  height: number;
}

// A faint overlay of many sampled task curves — the "task distribution" the meta-learner trains
// over. Seeing the fan of sines makes concrete that no single function fits them all, which is why
// the joint-training baseline collapses to the flat mean.
export default function TaskGallery({ grid, curves, width, height }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = width;
    const H = height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, W, H);
    if (curves.length === 0) return;

    const pad = 8;
    const plotW = W - 2 * pad;
    const plotH = H - 2 * pad;

    let ymax = 0;
    for (const c of curves) for (let i = 0; i < c.length; i++) ymax = Math.max(ymax, Math.abs(c[i]));
    if (ymax < 1e-6) ymax = 1;
    ymax *= 1.05;

    const xlo = META_DOMAIN.lo;
    const xhi = META_DOMAIN.hi;
    const sx = (x: number) => pad + ((x - xlo) / (xhi - xlo)) * plotW;
    const sy = (y: number) => pad + (1 - (y + ymax) / (2 * ymax)) * plotH;

    // zero line
    ctx.strokeStyle = 'rgba(148,163,184,0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad, sy(0));
    ctx.lineTo(W - pad, sy(0));
    ctx.stroke();

    // mean curve (the collapse target of joint training)
    const mean = new Float64Array(grid.length);
    for (const c of curves) for (let i = 0; i < c.length; i++) mean[i] += c[i] / curves.length;

    ctx.strokeStyle = 'rgba(96,165,250,0.5)';
    ctx.lineWidth = 1;
    for (let k = 0; k < curves.length; k++) {
      const c = curves[k];
      ctx.beginPath();
      for (let i = 0; i < c.length; i++) {
        const xx = sx(grid[i]);
        const yy = sy(c[i]);
        if (i === 0) ctx.moveTo(xx, yy);
        else ctx.lineTo(xx, yy);
      }
      ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(251,191,36,0.95)';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    for (let i = 0; i < mean.length; i++) {
      const xx = sx(grid[i]);
      const yy = sy(mean[i]);
      if (i === 0) ctx.moveTo(xx, yy);
      else ctx.lineTo(xx, yy);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }, [grid, curves, width, height]);

  return <canvas ref={ref} style={{ width, height, display: 'block', borderRadius: 8 }} />;
}
