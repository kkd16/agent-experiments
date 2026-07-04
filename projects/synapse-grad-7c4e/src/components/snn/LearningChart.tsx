import { useEffect, useRef } from 'react';

interface Props {
  loss: number[];
  trainAcc: number[];
  testAcc: number[];
  rate: number[];
  width?: number;
  height?: number;
}

// Training telemetry on one canvas: the surrogate-gradient loss on a log axis (amber), train (faint
// cyan) and held-out test (bold cyan) accuracy on a fixed [0,1] axis, and the network's mean firing
// rate (violet) — so you can watch accuracy climb while the spike code stays sparse.
export default function LearningChart({ loss, trainAcc, testAcc, rate, width = 320, height = 160 }: Props) {
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
    const xAt = (i: number, n: number) => pad + (n <= 1 ? 0 : (i / (n - 1)) * (W - 2 * pad));
    const draw = (data: number[], color: string, lw: number, yFn: (v: number) => number) => {
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
    const acc01 = (v: number) => pad + (1 - Math.max(0, Math.min(1, v))) * (H - 2 * pad);

    // loss on a log axis
    const fl = loss.filter((v) => Number.isFinite(v) && v > 0);
    if (fl.length >= 2) {
      const llo = Math.log(Math.min(...fl));
      const lhi = Math.log(Math.max(...fl));
      const lspan = lhi - llo < 1e-6 ? 1 : lhi - llo;
      draw(loss.map((v) => (v > 0 ? v : NaN)), '#fbbf24', 1.5, (v) => pad + (1 - (Math.log(v) - llo) / lspan) * (H - 2 * pad));
    }
    draw(rate, 'rgba(167,139,250,0.85)', 1.2, acc01);
    draw(trainAcc, 'rgba(56,189,248,0.35)', 1, acc01);
    draw(testAcc, '#38bdf8', 2, acc01);
  }, [loss, trainAcc, testAcc, rate, width, height]);

  const last = (arr: number[]) => (arr.length ? arr[arr.length - 1] : NaN);
  const f = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');
  const pc = (v: number) => (Number.isFinite(v) ? (v * 100).toFixed(0) + '%' : '—');

  return (
    <div className="chart-wrap">
      <canvas ref={ref} width={width} height={height} className="chart" />
      <div className="chart-legend">
        <span className="legend-item">
          <span className="swatch" style={{ background: '#38bdf8' }} /> test acc <b>{pc(last(testAcc))}</b>
        </span>
        <span className="legend-item">
          <span className="swatch" style={{ background: '#fbbf24' }} /> loss <b>{f(last(loss), 3)}</b>
        </span>
        <span className="legend-item">
          <span className="swatch" style={{ background: '#a78bfa' }} /> rate <b>{pc(last(rate))}</b>
        </span>
      </div>
    </div>
  );
}
