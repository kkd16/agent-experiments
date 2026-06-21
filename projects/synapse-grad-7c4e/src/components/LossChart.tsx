import { useEffect, useRef } from 'react';

interface Props {
  loss: number[];
  acc: number[];
  accLabel: string; // "accuracy" or "R²"
  width: number;
  height: number;
}

export default function LossChart({ loss, acc, accLabel, width, height }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const W = width;
    const H = height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, W, H);

    const pad = 4;
    const n = loss.length;

    // gridlines
    ctx.strokeStyle = 'rgba(148,163,184,0.10)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad + (i / 4) * (H - 2 * pad);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }
    if (n < 2) return;

    const maxLoss = Math.max(...loss, 1e-6);
    const xAt = (i: number) => pad + (i / (n - 1)) * (W - 2 * pad);

    // loss (log-ish scale by normalizing to its own max)
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const v = Math.min(1, loss[i] / maxLoss);
      const y = pad + (1 - v) * (H - 2 * pad);
      const x = xAt(i);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = '#fb7185';
    ctx.lineWidth = 2;
    ctx.stroke();

    // accuracy / R^2 in [0,1]
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const v = Math.max(0, Math.min(1, acc[i]));
      const y = pad + (1 - v) * (H - 2 * pad);
      const x = xAt(i);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = '#4ade80';
    ctx.lineWidth = 2;
    ctx.stroke();
  }, [loss, acc, width, height]);

  const lastLoss = loss.length ? loss[loss.length - 1] : NaN;
  const lastAcc = acc.length ? acc[acc.length - 1] : NaN;

  return (
    <div className="chart-wrap">
      <canvas ref={canvasRef} width={width} height={height} className="chart" />
      <div className="chart-legend">
        <span className="legend-item">
          <span className="swatch" style={{ background: '#fb7185' }} /> loss{' '}
          <b>{Number.isFinite(lastLoss) ? lastLoss.toFixed(4) : '—'}</b>
        </span>
        <span className="legend-item">
          <span className="swatch" style={{ background: '#4ade80' }} /> {accLabel}{' '}
          <b>{Number.isFinite(lastAcc) ? (accLabel === 'R²' ? lastAcc.toFixed(3) : `${(lastAcc * 100).toFixed(1)}%`) : '—'}</b>
        </span>
      </div>
    </div>
  );
}
