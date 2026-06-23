import { useEffect, useRef } from 'react';

interface Props {
  loss: number[];
  nll: number[];
  width: number;
  height: number;
}

// Training-objective curve (the per-step loss) alongside the held-out predictive NLL — the honest
// measure of a probabilistic model, since it rewards a calibrated variance, not just an accurate
// mean. Both are auto-scaled on a shared log-friendly axis.
export default function BayesChart({ loss, nll, width, height }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const W = width;
    const H = height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, W, H);

    const pad = 6;
    ctx.strokeStyle = 'rgba(148,163,184,0.10)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad + (i / 4) * (H - 2 * pad);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }

    const finite = (arr: number[]) => arr.filter((v) => Number.isFinite(v));
    const all = [...finite(loss), ...finite(nll)];
    if (all.length < 2) return;
    let lo = Math.min(...all);
    let hi = Math.max(...all);
    if (!(hi > lo)) hi = lo + 1;
    const range = hi - lo;
    lo -= range * 0.06;
    hi += range * 0.06;

    const draw = (data: number[], color: string) => {
      if (finite(data).length < 2) return;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < data.length; i++) {
        if (!Number.isFinite(data[i])) continue;
        const x = pad + (i / (data.length - 1)) * (W - 2 * pad);
        const y = pad + (1 - (data[i] - lo) / (hi - lo)) * (H - 2 * pad);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.8;
      ctx.stroke();
    };

    draw(loss, 'rgba(148,163,184,0.65)');
    draw(nll, '#38bdf8');

    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(148,163,184,0.85)';
    ctx.fillText('loss', 8, 6);
    ctx.fillStyle = '#38bdf8';
    ctx.fillText('test NLL', 44, 6);
  }, [loss, nll, width, height]);

  return <canvas ref={ref} className="uq-chart" />;
}
