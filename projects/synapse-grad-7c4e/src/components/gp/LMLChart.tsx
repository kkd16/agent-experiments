import { useEffect, useRef } from 'react';

interface Props {
  history: number[];
  width: number;
  height: number;
}

// The log marginal likelihood climbing as the hyperparameters are learned. Higher is a better
// explanation of the data by the prior — the exact quantity gradient ascent maximises.
export default function LMLChart({ history, width, height }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, width, height);
    const pad = 4;
    ctx.strokeStyle = 'rgba(148,163,184,0.10)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad + (i / 4) * (height - 2 * pad);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
    const data = history.filter((v) => Number.isFinite(v));
    if (data.length < 2) return;
    let lo = Math.min(...data);
    let hi = Math.max(...data);
    if (hi - lo < 1e-6) hi = lo + 1;
    const padR = (hi - lo) * 0.08;
    lo -= padR;
    hi += padR;
    ctx.beginPath();
    for (let i = 0; i < history.length; i++) {
      if (!Number.isFinite(history[i])) continue;
      const x = pad + (i / (history.length - 1)) * (width - 2 * pad);
      const y = pad + (1 - (history[i] - lo) / (hi - lo)) * (height - 2 * pad);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = '#a3e653';
    ctx.lineWidth = 2;
    ctx.stroke();
  }, [history, width, height]);

  const last = history.length ? history[history.length - 1] : NaN;
  return (
    <div className="chart-wrap">
      <canvas ref={ref} width={width} height={height} className="chart" />
      <div className="chart-legend">
        <span className="legend-item">
          <span className="swatch" style={{ background: '#a3e653' }} /> log marginal likelihood{' '}
          <b>{Number.isFinite(last) ? last.toFixed(3) : '—'}</b>
        </span>
      </div>
    </div>
  );
}
