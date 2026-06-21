import { useEffect, useRef } from 'react';

interface Props {
  loss: number[];
  acc: number[];
  valLoss?: number[];
  valAcc?: number[];
  accLabel: string; // "accuracy" or "R²"
  width: number;
  height: number;
}

export default function LossChart({ loss, acc, valLoss, valAcc, accLabel, width, height }: Props) {
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

    const finite = (arr: number[]) => arr.filter((v) => Number.isFinite(v));
    const maxLoss = Math.max(...finite(loss), ...finite(valLoss ?? []), 1e-6);
    const xAt = (i: number, len: number) => pad + (i / (len - 1)) * (W - 2 * pad);

    const line = (data: number[], norm: (v: number) => number, color: string, dashed: boolean) => {
      if (data.length < 2) return;
      ctx.setLineDash(dashed ? [4, 3] : []);
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < data.length; i++) {
        if (!Number.isFinite(data[i])) continue;
        const y = pad + (1 - norm(data[i])) * (H - 2 * pad);
        const x = xAt(i, data.length);
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

    const lossNorm = (v: number) => Math.min(1, v / maxLoss);
    const accNorm = (v: number) => Math.max(0, Math.min(1, v));

    // loss (train solid, val dashed) in rose; accuracy/R² (train solid, val dashed) in green
    line(loss, lossNorm, '#fb7185', false);
    if (valLoss && finite(valLoss).length) line(valLoss, lossNorm, '#fda4af', true);
    line(acc, accNorm, '#4ade80', false);
    if (valAcc && finite(valAcc).length) line(valAcc, accNorm, '#86efac', true);
  }, [loss, acc, valLoss, valAcc, width, height]);

  const last = (arr: number[]) => (arr.length ? arr[arr.length - 1] : NaN);
  const fmtAcc = (v: number) =>
    Number.isFinite(v) ? (accLabel === 'R²' ? v.toFixed(3) : `${(v * 100).toFixed(1)}%`) : '—';
  const lastLoss = last(loss);
  const lastAcc = last(acc);
  const lastValAcc = valAcc ? last(valAcc) : NaN;
  const hasVal = !!(valAcc && valAcc.some((v) => Number.isFinite(v)));

  return (
    <div className="chart-wrap">
      <canvas ref={canvasRef} width={width} height={height} className="chart" />
      <div className="chart-legend">
        <span className="legend-item">
          <span className="swatch" style={{ background: '#fb7185' }} /> loss{' '}
          <b>{Number.isFinite(lastLoss) ? lastLoss.toFixed(4) : '—'}</b>
        </span>
        <span className="legend-item">
          <span className="swatch" style={{ background: '#4ade80' }} /> {accLabel} <b>{fmtAcc(lastAcc)}</b>
        </span>
        {hasVal && (
          <span className="legend-item">
            <span className="swatch dashed" style={{ background: '#86efac' }} /> val <b>{fmtAcc(lastValAcc)}</b>
          </span>
        )}
      </div>
    </div>
  );
}
