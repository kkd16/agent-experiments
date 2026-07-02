import { useEffect, useRef } from 'react';

interface Props {
  raw: number[];
  smooth: number[];
  loss: number[];
  eps: number[];
  width: number;
  height: number;
  solvedAt?: number;
}

// The DQN learning curve: per-episode return (faint) with its moving average (bold cyan) on the
// left axis; the TD (Huber) loss on a log axis (amber); and the exploration rate ε (violet) on a
// fixed [0,1] axis. Return climbs, loss falls, ε decays — the three things you watch during a DQN
// run, on one canvas.
export default function LearningChart({ raw, smooth, loss, eps, width, height, solvedAt }: Props) {
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
    const xAt = (i: number, n: number) => pad + (n <= 1 ? 0 : (i / (n - 1)) * (W - 2 * pad));
    const drawSeries = (data: number[], color: string, lw: number, yFn: (v: number) => number) => {
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < data.length; i++) {
        if (!Number.isFinite(data[i])) continue;
        const x = xAt(i, data.length);
        const y = yFn(data[i]);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = lw;
      ctx.stroke();
    };

    // Return axis.
    const fr = finite(raw);
    if (fr.length >= 1) {
      const lo = Math.min(...fr, ...finite(smooth));
      let hi = Math.max(...fr, ...finite(smooth));
      if (solvedAt !== undefined) hi = Math.max(hi, solvedAt);
      const span = hi - lo < 1e-6 ? 1 : hi - lo;
      const yAt = (v: number) => pad + (1 - (v - lo) / span) * (H - 2 * pad);
      if (solvedAt !== undefined && solvedAt <= hi && solvedAt >= lo) {
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = 'rgba(74,222,128,0.5)';
        ctx.beginPath();
        ctx.moveTo(0, yAt(solvedAt));
        ctx.lineTo(W, yAt(solvedAt));
        ctx.stroke();
        ctx.setLineDash([]);
      }
      drawSeries(raw, 'rgba(56,189,248,0.28)', 1, yAt);
      drawSeries(smooth, '#38bdf8', 2, yAt);
    }

    // TD loss on a log axis.
    const fl = finite(loss).filter((v) => v > 0);
    if (fl.length >= 2) {
      const llo = Math.log(Math.min(...fl));
      const lhi = Math.log(Math.max(...fl));
      const lspan = lhi - llo < 1e-6 ? 1 : lhi - llo;
      drawSeries(loss.map((v) => (v > 0 ? v : NaN)), '#fbbf24', 1.5, (v) => pad + (1 - (Math.log(v) - llo) / lspan) * (H - 2 * pad));
    }

    // ε on a fixed [0,1] axis.
    drawSeries(eps, 'rgba(167,139,250,0.9)', 1.2, (v) => pad + (1 - Math.max(0, Math.min(1, v))) * (H - 2 * pad));
  }, [raw, smooth, loss, eps, width, height, solvedAt]);

  const last = (arr: number[]) => (arr.length ? arr[arr.length - 1] : NaN);
  const f = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');

  return (
    <div className="chart-wrap">
      <canvas ref={canvasRef} width={width} height={height} className="chart" />
      <div className="chart-legend">
        <span className="legend-item">
          <span className="swatch" style={{ background: '#38bdf8' }} /> return <b>{f(last(smooth))}</b>
        </span>
        <span className="legend-item">
          <span className="swatch" style={{ background: '#fbbf24' }} /> TD loss <b>{f(last(loss), 3)}</b>
        </span>
        <span className="legend-item">
          <span className="swatch" style={{ background: '#a78bfa' }} /> ε <b>{f(last(eps), 2)}</b>
        </span>
      </div>
    </div>
  );
}
