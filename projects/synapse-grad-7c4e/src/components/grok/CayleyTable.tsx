import { useEffect, useMemo, useRef } from 'react';
import type { GPT } from '../../engine/transformer';
import type { GrokDataset } from '../../engine/grok';

interface Props {
  gpt: GPT;
  ds: GrokDataset;
  step: number;
  running: boolean;
  width: number;
}

const REFRESH_EVERY = 5; // recompute the p×p table at most every few steps

// The operation's Cayley table, live. Every cell (a, b) is the model's answer for that pair,
// coloured green when it matches (a ∘ b) mod p and rose when it doesn't. Held-out cells (the pairs
// the network never trained on) are drawn as filled squares; trained cells get a thin outline. The
// whole point of grokking made visual: early on, only the outlined (trained) cells are green and the
// held-out field is a wash of rose — the network has memorized the table it was shown. At the grok
// transition the held-out cells flip green in a sweep as the network *derives* the entries it was
// never taught.
export default function CayleyTable({ gpt, ds, step, running, width }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bucket = Math.floor(step / REFRESH_EVERY);

  const grid = useMemo(() => {
    void bucket;
    const p = ds.p;
    const V = ds.vocab;
    const trainSet = new Set<number>();
    for (let i = 0; i < ds.trainIdx.length; i++) {
      const ex = ds.all[ds.trainIdx[i]];
      trainSet.add(ex.a * p + ex.b);
    }
    // correct[a*p+b] = 1 right, 0 wrong; train[a*p+b] = 1 seen
    const correct = new Uint8Array(p * p);
    const train = new Uint8Array(p * p);
    let testCorrect = 0;
    let testTotal = 0;
    for (const ex of ds.all) {
      const logits = gpt.forward(ex.ids);
      const base = 2 * V;
      let best = 0;
      let bv = -Infinity;
      for (let j = 0; j < V; j++) {
        const v = logits.data[base + j];
        if (v > bv) {
          bv = v;
          best = j;
        }
      }
      const idx = ex.a * p + ex.b;
      const ok = best === ex.c ? 1 : 0;
      correct[idx] = ok;
      if (trainSet.has(idx)) train[idx] = 1;
      else {
        testTotal++;
        if (ok) testCorrect++;
      }
    }
    return { p, correct, train, testCorrect, testTotal };
  }, [gpt, ds, bucket]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const p = grid.p;
    const size = width;
    const cell = size / p;
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, size, size);
    for (let a = 0; a < p; a++) {
      for (let b = 0; b < p; b++) {
        const idx = a * p + b;
        const ok = grid.correct[idx] === 1;
        const seen = grid.train[idx] === 1;
        const x = b * cell;
        const y = a * cell;
        if (seen) {
          // trained cell: subdued, thin outline
          ctx.fillStyle = ok ? 'rgba(74,222,128,0.28)' : 'rgba(251,113,133,0.28)';
          ctx.fillRect(x, y, cell, cell);
          ctx.strokeStyle = 'rgba(148,163,184,0.35)';
          ctx.lineWidth = 0.5;
          ctx.strokeRect(x + 0.5, y + 0.5, cell - 1, cell - 1);
        } else {
          // held-out cell: solid, the thing that lights up at grokking
          ctx.fillStyle = ok ? 'rgba(74,222,128,0.95)' : 'rgba(251,113,133,0.8)';
          ctx.fillRect(x, y, cell, cell);
        }
      }
    }
  }, [grid, width]);

  const acc = grid.testTotal ? (grid.testCorrect / grid.testTotal) * 100 : NaN;

  return (
    <div className="chart-wrap">
      <canvas ref={canvasRef} width={width} height={width} className="chart" style={{ imageRendering: 'pixelated' }} />
      <div className="chart-legend">
        <span className="legend-item">
          <span className="swatch" style={{ background: 'rgba(74,222,128,0.95)' }} /> held-out solved
        </span>
        <span className="legend-item">
          <span className="swatch" style={{ background: 'rgba(148,163,184,0.5)' }} /> outlined = trained
        </span>
        <span className="legend-item">
          held-out <b>{Number.isFinite(acc) ? `${acc.toFixed(1)}%` : '—'}</b>
        </span>
      </div>
      {running && <p className="muted small chart-foot">table refreshes every {REFRESH_EVERY} steps</p>}
    </div>
  );
}
