import { useEffect, useRef } from 'react';

interface Props {
  loss: number[];
  valLoss?: number[];
  width: number;
  height: number;
}

// The ε-prediction loss curve (train + validation). The diffusion objective is a single MSE on the
// noise estimate, so unlike the VAE there's just one series — but the train/val pair still shows the
// model fitting the noising process and generalising to held-out glyphs.
export default function DiffChart({ loss, valLoss, width, height }: Props) {
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
    if (finite(loss).length < 2) return;
    const max = Math.max(...finite(loss), ...finite(valLoss ?? []), 1e-6);

    const draw = (data: number[], color: string, dashed: boolean) => {
      if (finite(data).length < 2) return;
      ctx.setLineDash(dashed ? [4, 3] : []);
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < data.length; i++) {
        if (!Number.isFinite(data[i])) continue;
        const x = pad + (i / (data.length - 1)) * (W - 2 * pad);
        const y = pad + (1 - Math.min(1, data[i] / max)) * (H - 2 * pad);
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

    if (valLoss) draw(valLoss, '#fda4af', true);
    draw(loss, '#a78bfa', false);
  }, [loss, valLoss, width, height]);

  const last = (arr: number[]) => (arr.length ? arr[arr.length - 1] : NaN);
  const f = (v: number) => (Number.isFinite(v) ? v.toFixed(3) : '—');

  return (
    <div className="chart-wrap">
      <canvas ref={canvasRef} width={width} height={height} className="chart" />
      <div className="chart-legend">
        <span className="legend-item">
          <span className="swatch" style={{ background: '#a78bfa' }} /> ε-MSE <b>{f(last(loss))}</b>
        </span>
        {valLoss && (
          <span className="legend-item">
            <span className="swatch" style={{ background: '#fda4af' }} /> val <b>{f(last(valLoss))}</b>
          </span>
        )}
      </div>
    </div>
  );
}
