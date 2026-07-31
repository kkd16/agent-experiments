import { useEffect, useRef } from 'react';

interface Props {
  kanHistory: number[];
  mlpHistory: number[];
  kanParams: number;
  mlpParams: number;
  kanScore: number;
  mlpScore: number;
  scoreLabel: string; // "accuracy" | "R²"
  classify: boolean;
  width: number;
  height: number;
  tick: number;
}

const KAN_COLOR = '#38bdf8';
const MLP_COLOR = '#f472b6';

// The head-to-head: a KAN and an equal-parameter MLP trained in lockstep on the same data. Both
// validation-score curves are drawn on one axis so the accuracy-per-parameter trade-off is concrete.
export default function KANvsMLP({ kanHistory, mlpHistory, kanParams, mlpParams, kanScore, mlpScore, scoreLabel, classify, width, height, tick }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, width, height);

    const padL = 34;
    const padR = 10;
    const padT = 12;
    const padB = 20;
    const plotW = width - padL - padR;
    const plotH = height - padT - padB;

    // score axis: classification accuracy in [0,1]; R² clamped to a sensible [min,1].
    let lo = 0;
    const hi = 1;
    if (!classify) {
      let mn = Infinity;
      for (const v of [...kanHistory, ...mlpHistory]) if (Number.isFinite(v)) mn = Math.min(mn, v);
      lo = Number.isFinite(mn) ? Math.min(0, mn) : 0;
    }
    const n = Math.max(kanHistory.length, mlpHistory.length, 2);
    const toX = (i: number) => padL + (plotW * i) / (n - 1);
    const toY = (v: number) => padT + plotH - (plotH * (v - lo)) / (hi - lo || 1);

    // gridlines at 0, 0.5, 1
    ctx.strokeStyle = 'rgba(148,163,184,0.12)';
    ctx.fillStyle = 'rgba(148,163,184,0.6)';
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const g of [lo, (lo + hi) / 2, hi]) {
      const y = toY(g);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();
      ctx.fillText(g.toFixed(1), padL - 4, y);
    }

    const drawLine = (hist: number[], color: string, dashed: boolean) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash(dashed ? [5, 4] : []);
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < hist.length; i++) {
        const v = hist[i];
        if (!Number.isFinite(v)) continue;
        const px = toX(i);
        const py = toY(v);
        if (!started) {
          ctx.moveTo(px, py);
          started = true;
        } else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    };
    drawLine(mlpHistory, MLP_COLOR, true);
    drawLine(kanHistory, KAN_COLOR, false);

    if (kanHistory.length < 2 && mlpHistory.length < 2) {
      ctx.fillStyle = 'rgba(148,163,184,0.6)';
      ctx.textAlign = 'center';
      ctx.fillText('Train to compare', width / 2, height / 2);
    }
  }, [kanHistory, mlpHistory, classify, width, height, tick]);

  const fmt = (v: number) => (Number.isFinite(v) ? (classify ? `${(v * 100).toFixed(1)}%` : v.toFixed(3)) : '—');

  return (
    <div>
      <canvas ref={ref} style={{ width, height, maxWidth: '100%' }} className="chart" />
      <div className="kan-vs-row">
        <div className="kan-vs-cell">
          <span className="swatch" style={{ background: KAN_COLOR }} /> KAN <b>{kanParams}</b> params · val {scoreLabel} <b style={{ color: KAN_COLOR }}>{fmt(kanScore)}</b>
        </div>
        <div className="kan-vs-cell">
          <span className="swatch" style={{ background: MLP_COLOR }} /> MLP <b>{mlpParams}</b> params · val {scoreLabel} <b style={{ color: MLP_COLOR }}>{fmt(mlpScore)}</b>
        </div>
      </div>
    </div>
  );
}
