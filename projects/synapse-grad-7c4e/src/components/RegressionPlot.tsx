import { useEffect, useRef } from 'react';
import { Tensor } from '../engine/tensor';
import type { TrainerHandle } from '../hooks/useTrainer';

const DOMAIN = 1.25;
const YRANGE = 1.8;

interface Props {
  handle: TrainerHandle;
  tick: number;
  size: number;
}

export default function RegressionPlot({ handle, tick, size }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ds = handle.regData;
    const model = handle.model;
    if (!canvas || !ds || !model) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const W = size;
    const H = size;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, W, H);

    const xToPx = (x: number) => ((x + DOMAIN) / (2 * DOMAIN)) * W;
    const yToPx = (y: number) => H / 2 - (y / YRANGE) * H;

    // grid lines
    ctx.strokeStyle = 'rgba(148,163,184,0.12)';
    ctx.lineWidth = 1;
    for (let i = -2; i <= 2; i++) {
      const gx = xToPx((i / 2) * DOMAIN);
      ctx.beginPath();
      ctx.moveTo(gx, 0);
      ctx.lineTo(gx, H);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(148,163,184,0.25)';
    ctx.beginPath();
    ctx.moveTo(0, yToPx(0));
    ctx.lineTo(W, yToPx(0));
    ctx.stroke();

    // data points
    for (let i = 0; i < ds.n; i++) {
      ctx.beginPath();
      ctx.arc(xToPx(ds.X[i]), yToPx(ds.y[i]), 2.4, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(244,114,182,0.85)';
      ctx.fill();
    }

    // model curve
    const N = 220;
    const xs = new Float64Array(N);
    for (let i = 0; i < N; i++) xs[i] = -DOMAIN + (i / (N - 1)) * 2 * DOMAIN;
    const pred = model.forward(Tensor.fromFlat(xs, N, 1));
    ctx.beginPath();
    for (let i = 0; i < N; i++) {
      const px = xToPx(xs[i]);
      const py = yToPx(pred.data[i]);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }, [handle, tick, size]);

  return <canvas ref={canvasRef} width={size} height={size} className="board" />;
}
