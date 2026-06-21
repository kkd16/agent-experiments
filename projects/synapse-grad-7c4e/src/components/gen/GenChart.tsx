import { useEffect, useRef } from 'react';

interface Props {
  total: number[];
  recon: number[];
  kl: number[];
  valTotal?: number[];
  width: number;
  height: number;
}

// Training curves for the VAE: total (negative-ELBO) loss and its two terms, the
// reconstruction loss and the KL. Reconstruction dominates the scale, so the loss-like series
// (total / recon / val) share one axis while KL is drawn on its own auto-scaled axis so its
// shape (the latent code coming alive, then settling) stays readable.
export default function GenChart({ total, recon, kl, valTotal, width, height }: Props) {
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
    if (finite(total).length < 2) return;

    const maxLoss = Math.max(...finite(total), ...finite(recon), ...finite(valTotal ?? []), 1e-6);
    const maxKl = Math.max(...finite(kl), 1e-6);

    const draw = (data: number[], max: number, color: string, dashed: boolean) => {
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

    draw(recon, maxLoss, '#fb7185', false);
    if (valTotal) draw(valTotal, maxLoss, '#fda4af', true);
    draw(total, maxLoss, '#e2e8f0', false);
    draw(kl, maxKl, '#38bdf8', false);
  }, [total, recon, kl, valTotal, width, height]);

  const last = (arr: number[]) => (arr.length ? arr[arr.length - 1] : NaN);
  const f = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : '—');

  return (
    <div className="chart-wrap">
      <canvas ref={canvasRef} width={width} height={height} className="chart" />
      <div className="chart-legend">
        <span className="legend-item">
          <span className="swatch" style={{ background: '#e2e8f0' }} /> total <b>{f(last(total))}</b>
        </span>
        <span className="legend-item">
          <span className="swatch" style={{ background: '#fb7185' }} /> recon <b>{f(last(recon))}</b>
        </span>
        <span className="legend-item">
          <span className="swatch" style={{ background: '#38bdf8' }} /> KL <b>{f(last(kl))}</b>
        </span>
      </div>
    </div>
  );
}
