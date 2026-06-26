import { useEffect, useRef } from 'react';

interface Props {
  loss: number[];
  width: number;
  height: number;
}

// The reconstruction MSE over training, auto-scaled on a log axis (it spans orders of
// magnitude as the organism resolves), with min/last read-outs.
export default function NCAChart({ loss, width, height }: Props) {
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

    const fl = loss.filter((v) => Number.isFinite(v) && v > 0);
    if (fl.length >= 2) {
      const logs = fl.map((v) => Math.log10(v));
      let lo = Math.min(...logs);
      let hi = Math.max(...logs);
      if (hi - lo < 1e-6) {
        lo -= 0.5;
        hi += 0.5;
      }
      const grad = ctx.createLinearGradient(0, 0, W, 0);
      grad.addColorStop(0, '#a78bfa');
      grad.addColorStop(1, '#38bdf8');
      ctx.strokeStyle = grad;
      ctx.lineWidth = 2;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < loss.length; i++) {
        if (!Number.isFinite(loss[i]) || loss[i] <= 0) continue;
        const x = pad + (i / (loss.length - 1)) * (W - 2 * pad);
        const y = pad + (1 - (Math.log10(loss[i]) - lo) / (hi - lo)) * (H - 2 * pad);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }, [loss, width, height]);

  const last = loss.length ? loss[loss.length - 1] : NaN;
  const min = loss.length ? Math.min(...loss.filter((v) => Number.isFinite(v))) : NaN;
  const f = (v: number) => (Number.isFinite(v) ? v.toExponential(2) : '—');

  return (
    <div className="chart-wrap">
      <canvas ref={ref} width={width} height={height} className="chart" />
      <div className="chart-legend">
        <span className="legend-item">
          <span className="swatch" style={{ background: '#38bdf8' }} /> MSE <b>{f(last)}</b>
        </span>
        <span className="legend-item">
          best <b>{f(min)}</b> <span className="muted small">(log axis)</span>
        </span>
      </div>
    </div>
  );
}
