import { useEffect, useRef } from 'react';

interface Props {
  raw: number[];
  smooth: number[];
  entropy: number[];
  width: number;
  height: number;
  solvedAt?: number; // optional target line on the return axis (e.g. CartPole = 500)
}

// Learning curve: per-batch mean episode return (faint) with its exponential moving average
// (bold) on the left axis, and the policy entropy (nats) on its own auto-scaled axis — entropy
// starts near log(nActions) when the policy is random and falls as it commits to a strategy.
export default function ReturnChart({ raw, smooth, entropy, width, height, solvedAt }: Props) {
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
    const fr = finite(raw);
    if (fr.length < 1) return;

    const lo = Math.min(...fr, ...finite(smooth));
    let hi = Math.max(...fr, ...finite(smooth));
    if (solvedAt !== undefined) hi = Math.max(hi, solvedAt);
    if (hi - lo < 1e-6) hi = lo + 1;
    const span = hi - lo;

    const xAt = (i: number, n: number) => pad + (n <= 1 ? 0 : (i / (n - 1)) * (W - 2 * pad));
    const yAt = (v: number) => pad + (1 - (v - lo) / span) * (H - 2 * pad);

    // Target / solved line.
    if (solvedAt !== undefined && solvedAt <= hi && solvedAt >= lo) {
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = 'rgba(74,222,128,0.5)';
      ctx.beginPath();
      const y = yAt(solvedAt);
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    const drawSeries = (data: number[], color: string, lw: number, valueAxis: (v: number) => number) => {
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < data.length; i++) {
        if (!Number.isFinite(data[i])) continue;
        const x = xAt(i, data.length);
        const y = valueAxis(data[i]);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = lw;
      ctx.stroke();
    };

    drawSeries(raw, 'rgba(56,189,248,0.30)', 1, yAt);
    drawSeries(smooth, '#38bdf8', 2, yAt);

    // Entropy on its own axis.
    const fe = finite(entropy);
    if (fe.length >= 2) {
      const elo = Math.min(...fe);
      const ehi = Math.max(...fe);
      const espan = ehi - elo < 1e-6 ? 1 : ehi - elo;
      drawSeries(entropy, '#fbbf24', 1.5, (v) => pad + (1 - (v - elo) / espan) * (H - 2 * pad));
    }
  }, [raw, smooth, entropy, width, height, solvedAt]);

  const last = (arr: number[]) => (arr.length ? arr[arr.length - 1] : NaN);
  const f = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');

  return (
    <div className="chart-wrap">
      <canvas ref={canvasRef} width={width} height={height} className="chart" />
      <div className="chart-legend">
        <span className="legend-item">
          <span className="swatch" style={{ background: '#38bdf8' }} /> mean return <b>{f(last(smooth))}</b>
        </span>
        <span className="legend-item">
          <span className="swatch" style={{ background: '#fbbf24' }} /> entropy <b>{f(last(entropy), 3)}</b>
        </span>
      </div>
    </div>
  );
}
