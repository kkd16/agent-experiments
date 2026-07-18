import { useEffect, useRef } from 'react';
import type { AdaptationView } from '../../hooks/useMetaTrainer';
import { META_DOMAIN } from '../../engine/meta';

interface Props {
  view: AdaptationView | null;
  stepIdx: number; // which inner-step's prediction to draw (0..innerSteps)
  showRandom: boolean;
  width: number;
  height: number;
}

// The signature panel: the true task curve, the K support points, and the model's prediction after
// `stepIdx` inner adaptation steps — drawn from the meta-learned init (bright) and, for contrast,
// from a random init (dim amber). Scrubbing stepIdx animates the flat meta-init snapping onto the
// task; the random init flails.
export default function AdaptationPanel({ view, stepIdx, showRandom, width, height }: Props) {
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
    const W = width;
    const H = height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, W, H);

    if (!view) return;

    const padL = 34;
    const padR = 10;
    const padT = 12;
    const padB = 22;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    // y-range: cover truth + support + the shown predictions, clamped and padded.
    let ymin = Infinity;
    let ymax = -Infinity;
    const consider = (v: number) => {
      if (!Number.isFinite(v)) return;
      if (v < ymin) ymin = v;
      if (v > ymax) ymax = v;
    };
    for (let i = 0; i < view.truth.length; i++) consider(view.truth[i]);
    for (let i = 0; i < view.support.n; i++) consider(view.support.y[i]);
    const mp = view.metaPreds[Math.min(stepIdx, view.metaPreds.length - 1)];
    for (let i = 0; i < mp.length; i++) consider(mp[i]);
    if (showRandom) {
      const rp = view.randomPreds[Math.min(stepIdx, view.randomPreds.length - 1)];
      for (let i = 0; i < rp.length; i++) consider(rp[i]);
    }
    if (!Number.isFinite(ymin) || !Number.isFinite(ymax)) {
      ymin = -6;
      ymax = 6;
    }
    // Clamp wild early predictions so the scale stays readable.
    ymin = Math.max(ymin, -8);
    ymax = Math.min(ymax, 8);
    const ypad = (ymax - ymin) * 0.08 + 0.2;
    ymin -= ypad;
    ymax += ypad;

    const xlo = META_DOMAIN.lo;
    const xhi = META_DOMAIN.hi;
    const sx = (x: number) => padL + ((x - xlo) / (xhi - xlo)) * plotW;
    const sy = (y: number) => padT + (1 - (y - ymin) / (ymax - ymin)) * plotH;

    // grid + zero line
    ctx.strokeStyle = 'rgba(148,163,184,0.10)';
    ctx.lineWidth = 1;
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillStyle = 'rgba(148,163,184,0.55)';
    for (let k = 0; k <= 4; k++) {
      const yv = ymin + (k / 4) * (ymax - ymin);
      const yy = sy(yv);
      ctx.beginPath();
      ctx.moveTo(padL, yy);
      ctx.lineTo(W - padR, yy);
      ctx.stroke();
      ctx.fillText(yv.toFixed(1), 2, yy + 3);
    }
    for (let k = 0; k <= 4; k++) {
      const xv = xlo + (k / 4) * (xhi - xlo);
      const xx = sx(xv);
      ctx.beginPath();
      ctx.moveTo(xx, padT);
      ctx.lineTo(xx, H - padB);
      ctx.stroke();
      ctx.fillText(xv.toFixed(0), xx - 4, H - 8);
    }

    const drawCurve = (ys: Float64Array, stroke: string, w: number, dash: number[]) => {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = w;
      ctx.setLineDash(dash);
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < view.grid.length; i++) {
        const xx = sx(view.grid[i]);
        const yy = sy(ys[i]);
        if (!started) {
          ctx.moveTo(xx, yy);
          started = true;
        } else ctx.lineTo(xx, yy);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    };

    // true task (dashed slate)
    drawCurve(view.truth, 'rgba(226,232,240,0.85)', 1.5, [5, 4]);

    // random-init prediction (amber, thin)
    if (showRandom) {
      const rp = view.randomPreds[Math.min(stepIdx, view.randomPreds.length - 1)];
      drawCurve(rp, 'rgba(251,146,60,0.9)', 1.75, []);
    }

    // meta-init prediction (emerald, bold) — the star
    drawCurve(mp, 'rgba(52,211,153,1)', 2.5, []);

    // support points (pink dots)
    ctx.fillStyle = 'rgba(244,114,182,0.95)';
    ctx.strokeStyle = 'rgba(15,23,42,0.9)';
    ctx.lineWidth = 1;
    for (let i = 0; i < view.support.n; i++) {
      const xx = sx(view.support.x[i]);
      const yy = sy(view.support.y[i]);
      ctx.beginPath();
      ctx.arc(xx, yy, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }, [view, stepIdx, showRandom, width, height]);

  return <canvas ref={ref} style={{ width, height, display: 'block', borderRadius: 8 }} />;
}
