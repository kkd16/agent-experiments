import { useEffect, useRef } from 'react';
import type { FitView } from '../../hooks/useKANTrainer';

interface Props {
  view: FitView | null;
  tick: number;
  size: number;
}

// The regression headline: the noisy 1-D dataset (points) with the KAN's learned function drawn
// through it (the sky curve). Because each edge is a spline, a tiny KAN can fit sharp features —
// steps, sawtooths, kinks — that a same-size ReLU MLP smears.
export default function KANFunctionFit({ view, tick, size }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !view) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, size, size);

    const D = view.domain;
    // y-range from data and curve
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < view.n; i++) {
      lo = Math.min(lo, view.y[i]);
      hi = Math.max(hi, view.y[i]);
    }
    for (const v of view.ys) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    if (hi - lo < 1e-6) {
      lo -= 1;
      hi += 1;
    }
    const pad = (hi - lo) * 0.1;
    lo -= pad;
    hi += pad;
    const m = 10;
    const toX = (x: number) => m + ((size - 2 * m) * (x + D)) / (2 * D);
    const toY = (v: number) => size - m - ((size - 2 * m) * (v - lo)) / (hi - lo);

    // gridlines
    ctx.strokeStyle = 'rgba(148,163,184,0.10)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = m + (i / 4) * (size - 2 * m);
      ctx.beginPath();
      ctx.moveTo(m, y);
      ctx.lineTo(size - m, y);
      ctx.stroke();
    }
    if (lo < 0 && hi > 0) {
      ctx.strokeStyle = 'rgba(148,163,184,0.3)';
      ctx.beginPath();
      ctx.moveTo(m, toY(0));
      ctx.lineTo(size - m, toY(0));
      ctx.stroke();
    }

    // data points (validation = haloed)
    for (let i = 0; i < view.n; i++) {
      const px = toX(view.X[i]);
      const py = toY(view.y[i]);
      const isVal = view.split[i] === 1;
      ctx.beginPath();
      ctx.arc(px, py, isVal ? 3 : 2.3, 0, Math.PI * 2);
      ctx.fillStyle = isVal ? 'rgba(244,114,182,0.9)' : 'rgba(148,163,184,0.55)';
      ctx.fill();
    }

    // model curve
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    for (let s = 0; s < view.xs.length; s++) {
      const px = toX(view.xs[s]);
      const py = toY(view.ys[s]);
      if (s === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }, [view, tick, size]);

  return <canvas ref={ref} style={{ width: size, height: size, maxWidth: '100%' }} className="board" />;
}
