import { useEffect, useMemo, useRef, useState } from 'react';
import { gradientThroughTime } from '../../engine/gradflow';
import type { CellKind } from '../../engine/recurrent';

const CELL_COLOR: Record<CellKind, string> = {
  rnn: '#fb7185', // rose — the one that vanishes
  gru: '#fbbf24', // amber
  lstm: '#4ade80', // green — the one that survives
};

// THE pedagogical centrepiece: backprop one long-range loss through a fresh RNN / GRU / LSTM and
// plot ‖∂L/∂h_t‖ on a log axis against timestep. The RNN's curve plunges toward the cue; the
// gated cells stay roughly flat — Hochreiter's vanishing gradient, drawn from the engine's own
// tape. This is an architectural property of the *untrained* nets, which is exactly why it
// predicts which ones can learn the dependency at all.
export default function GradientFlowView() {
  const [lag, setLag] = useState(30);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const W = 540;
  const Hpx = 200;

  const result = useMemo(() => gradientThroughTime(lag, 32, 2), [lag]);

  const stats = useMemo(() => {
    const cueOverEnd = (norms: number[]) => norms[0] / (norms[norms.length - 1] + 1e-12);
    return result.series.map((s) => ({ cell: s.cell, ratio: cueOverEnd(s.norms) }));
  }, [result]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, W, Hpx);
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, W, Hpx);
    const padL = 38;
    const padR = 8;
    const padT = 10;
    const padB = 22;

    // log10 range across all series (clamp tiny values to a floor)
    const FLOOR = 1e-9;
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of result.series)
      for (const v of s.norms) {
        const l = Math.log10(Math.max(v, FLOOR));
        if (l < lo) lo = l;
        if (l > hi) hi = l;
      }
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi - lo < 1) {
      lo = Math.min(lo, hi - 1);
    }
    const T = result.timesteps;
    const xAt = (t: number) => padL + (t / Math.max(1, T - 1)) * (W - padL - padR);
    const yAt = (v: number) => {
      const l = Math.log10(Math.max(v, FLOOR));
      return padT + (1 - (l - lo) / (hi - lo)) * (Hpx - padT - padB);
    };

    // gridlines at each decade
    ctx.strokeStyle = 'rgba(148,163,184,0.12)';
    ctx.fillStyle = 'rgba(148,163,184,0.7)';
    ctx.font = '10px ui-monospace, monospace';
    for (let d = Math.ceil(lo); d <= Math.floor(hi); d++) {
      const y = yAt(Math.pow(10, d));
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(W - padR, y);
      ctx.stroke();
      ctx.fillText(`1e${d}`, 2, y + 3);
    }

    // cue & query markers
    const marker = (t: number, label: string) => {
      const x = xAt(t);
      ctx.strokeStyle = 'rgba(248,250,252,0.25)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, Hpx - padB);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(226,232,240,0.8)';
      ctx.fillText(label, x - (t === 0 ? 0 : 28), Hpx - 8);
    };
    marker(0, 'cue');
    marker(T - 1, 'query');

    for (const s of result.series) {
      ctx.strokeStyle = CELL_COLOR[s.cell];
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let t = 0; t < s.norms.length; t++) {
        const x = xAt(t);
        const y = yAt(s.norms[t]);
        if (t === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }, [result]);

  const fmt = (r: number) => (r < 1 ? `${r.toExponential(1)}` : r.toFixed(1));

  return (
    <div className="card">
      <div className="card-title">
        Gradient through time <span className="muted small">· why RNNs forget</span>
      </div>
      <p className="muted small">
        One long-range loss (recall the cue after {lag} distractors), backpropagated through a freshly-initialised cell
        of each type. The curve is ‖∂L/∂h_t‖ at every step, log scale. A plain RNN's gradient collapses toward the cue —
        it cannot assign credit that far back — while the gated cells keep it alive.
      </p>
      <canvas ref={canvasRef} width={W} height={Hpx} className="chart" />
      <label className="field rnn-lag">
        <span>
          lag <b>{lag}</b> distractor steps
        </span>
        <input type="range" min={5} max={60} step={1} value={lag} onChange={(e) => setLag(Number(e.target.value))} />
      </label>
      <div className="rnn-gradstats">
        {stats.map((s) => (
          <span className="legend-item" key={s.cell}>
            <span className="swatch" style={{ background: CELL_COLOR[s.cell] }} /> {s.cell.toUpperCase()}{' '}
            <b>
              {fmt(s.ratio)}
              <span className="muted small"> ×grad cue/query</span>
            </b>
          </span>
        ))}
      </div>
      <p className="muted small chart-foot">
        A ratio near 1 means the gradient reaches the cue undamped; ≪1 is the vanishing gradient. The LSTM/GRU beat the
        RNN by orders of magnitude — the whole reason they exist.
      </p>
    </div>
  );
}
