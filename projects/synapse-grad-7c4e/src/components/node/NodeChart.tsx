import { useEffect, useRef } from 'react';

interface Props {
  trainAcc: number[];
  valAcc: number[];
  loss: number[];
  width: number;
  height: number;
}

// Accuracy (0–1, left) with the training cross-entropy drawn as a faint auto-scaled sparkline
// behind it. Train accuracy solid, held-out validation dashed.
export default function NodeChart({ trainAcc, valAcc, loss, width, height }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const W = width;
    const H = height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, W, H);

    const pad = 4;
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

    // loss sparkline (behind), auto-scaled
    const fl = finite(loss);
    if (fl.length >= 2) {
      const lo = Math.min(...fl);
      let hi = Math.max(...fl);
      if (hi - lo < 1e-9) hi = lo + 1;
      ctx.strokeStyle = 'rgba(250, 204, 21, 0.45)';
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < loss.length; i++) {
        if (!Number.isFinite(loss[i])) continue;
        const x = pad + (i / (loss.length - 1)) * (W - 2 * pad);
        const y = pad + (1 - (loss[i] - lo) / (hi - lo)) * (H - 2 * pad);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    const drawAcc = (data: number[], color: string, dashed: boolean) => {
      if (finite(data).length < 2) return;
      ctx.setLineDash(dashed ? [4, 3] : []);
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < data.length; i++) {
        if (!Number.isFinite(data[i])) continue;
        const x = pad + (i / (data.length - 1)) * (W - 2 * pad);
        const y = pad + (1 - data[i]) * (H - 2 * pad);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.setLineDash([]);
    };

    drawAcc(valAcc, '#fda4af', true);
    drawAcc(trainAcc, '#38bdf8', false);
  }, [trainAcc, valAcc, loss, width, height]);

  const last = (arr: number[]) => (arr.length ? arr[arr.length - 1] : NaN);
  const pct = (v: number) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '—');
  const f3 = (v: number) => (Number.isFinite(v) ? v.toFixed(3) : '—');

  return (
    <div className="chart-wrap">
      <canvas ref={ref} width={width} height={height} className="chart" />
      <div className="chart-legend">
        <span className="legend-item">
          <span className="swatch" style={{ background: '#38bdf8' }} /> train <b>{pct(last(trainAcc))}</b>
        </span>
        <span className="legend-item">
          <span className="swatch dashed" style={{ background: '#fda4af' }} /> val <b>{pct(last(valAcc))}</b>
        </span>
        <span className="legend-item">
          <span className="swatch" style={{ background: '#facc15' }} /> loss <b>{f3(last(loss))}</b>
        </span>
      </div>
    </div>
  );
}
