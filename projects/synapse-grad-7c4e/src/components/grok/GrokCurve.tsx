import { useEffect, useRef } from 'react';
import type { GrokPoint } from '../../hooks/useGrokTrainer';

interface Props {
  history: GrokPoint[];
  grokStep: number;
  width: number;
  height: number;
}

// The headline chart: train vs held-out accuracy against optimization steps on a **logarithmic**
// x-axis. Grokking lives across orders of magnitude — the train curve saturates almost
// immediately while the test curve sits at the memorization plateau for a long time before its
// abrupt climb — so a linear x-axis would crush the whole story into the first pixel column. The
// gap between the two curves (memorized-but-not-generalized) is shaded, and the grok step (test
// first crossing 95%) is marked with a vertical rule.
export default function GrokCurve({ history, grokStep, width, height }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const W = width;
    const H = height;
    const padL = 34;
    const padR = 10;
    const padT = 10;
    const padB = 22;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, W, H);

    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    const pts = history.filter((p) => Number.isFinite(p.testAcc));
    const lastStep = pts.length ? pts[pts.length - 1].step : 1;
    const xMax = Math.max(10, lastStep);
    const logMax = Math.log10(xMax);
    const xAt = (step: number) => padL + (Math.log10(Math.max(1, step)) / (logMax || 1)) * plotW;
    const yAt = (acc: number) => padT + (1 - Math.max(0, Math.min(1, acc))) * plotH;

    // horizontal gridlines at 0 / 25 / 50 / 75 / 100 %
    ctx.strokeStyle = 'rgba(148,163,184,0.10)';
    ctx.fillStyle = 'rgba(148,163,184,0.55)';
    ctx.font = '10px ui-monospace, monospace';
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const acc = i / 4;
      const y = yAt(acc);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(W - padR, y);
      ctx.stroke();
      ctx.fillText(`${acc * 100}`, padL - 4, y);
    }

    // vertical decade gridlines (10, 100, 1k, 10k …)
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let d = 1; Math.pow(10, d) <= xMax * 1.0000001; d++) {
      const step = Math.pow(10, d);
      const x = xAt(step);
      ctx.strokeStyle = 'rgba(148,163,184,0.10)';
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + plotH);
      ctx.stroke();
      const label = step >= 1000 ? `${step / 1000}k` : `${step}`;
      ctx.fillStyle = 'rgba(148,163,184,0.55)';
      ctx.fillText(label, x, padT + plotH + 4);
    }

    if (pts.length < 2) {
      ctx.fillStyle = 'rgba(148,163,184,0.5)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('press Train — watch the test curve grok', W / 2, H / 2);
      return;
    }

    // shaded generalization gap (train − test), the "memorized but not understood" region
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) ctx.lineTo(xAt(pts[i].step), yAt(pts[i].trainAcc));
    for (let i = pts.length - 1; i >= 0; i--) ctx.lineTo(xAt(pts[i].step), yAt(pts[i].testAcc));
    ctx.closePath();
    ctx.fillStyle = 'rgba(251,191,36,0.10)';
    ctx.fill();

    const drawLine = (key: 'trainAcc' | 'testAcc', color: string, w: number) => {
      ctx.beginPath();
      let started = false;
      for (const p of pts) {
        const x = xAt(p.step);
        const y = yAt(p[key]);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = w;
      ctx.stroke();
    };

    // grok marker
    if (grokStep > 0) {
      const x = xAt(grokStep);
      ctx.strokeStyle = 'rgba(74,222,128,0.55)';
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(74,222,128,0.9)';
      ctx.textAlign = x > W - 60 ? 'right' : 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(`grok @ ${grokStep}`, x + (x > W - 60 ? -4 : 4), padT + 2);
    }

    drawLine('trainAcc', '#fbbf24', 2); // amber = train
    drawLine('testAcc', '#4ade80', 2.4); // green = held-out
  }, [history, grokStep, width, height]);

  const last = history.length ? history[history.length - 1] : null;
  const fmt = (v: number | undefined) => (v !== undefined && Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '—');

  return (
    <div className="chart-wrap">
      <canvas ref={canvasRef} width={width} height={height} className="chart" />
      <div className="chart-legend">
        <span className="legend-item">
          <span className="swatch" style={{ background: '#fbbf24' }} /> train <b>{fmt(last?.trainAcc)}</b>
        </span>
        <span className="legend-item">
          <span className="swatch" style={{ background: '#4ade80' }} /> held-out <b>{fmt(last?.testAcc)}</b>
        </span>
        <span className="legend-item muted">log steps →</span>
      </div>
    </div>
  );
}
