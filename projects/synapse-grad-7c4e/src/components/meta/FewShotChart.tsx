import { useEffect, useRef } from 'react';
import type { FewShotView } from '../../hooks/useMetaTrainer';

interface Props {
  view: FewShotView | null;
  trainInnerSteps: number; // where to draw the "trained horizon" marker
  width: number;
  height: number;
}

// Average query MSE on a batch of held-out *novel* tasks as a function of adaptation steps, on a
// log scale. The meta-learned init (emerald) plunges in the first step or two; the random init
// (slate) barely moves. This is the empirical proof of "learning to learn".
export default function FewShotChart({ view, trainInnerSteps, width, height }: Props) {
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
    if (!view || view.steps.length < 2) return;

    const padL = 40;
    const padR = 10;
    const padT = 12;
    const padB = 22;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    const all = [...view.meta, ...view.random].filter((v) => Number.isFinite(v) && v > 0);
    if (all.length === 0) return;
    const lo = Math.min(...all);
    const hi = Math.max(...all);
    const logLo = Math.floor(Math.log10(Math.max(lo, 1e-4)));
    const logHi = Math.ceil(Math.log10(Math.max(hi, 1e-3)));
    const L0 = logLo;
    const L1 = Math.max(logHi, logLo + 1);

    const n = view.steps.length;
    const sx = (i: number) => padL + (i / (n - 1)) * plotW;
    const sy = (v: number) => {
      const lg = Math.log10(Math.max(v, Math.pow(10, L0)));
      return padT + (1 - (lg - L0) / (L1 - L0)) * plotH;
    };

    // log gridlines + labels
    ctx.font = '10px ui-monospace, monospace';
    for (let e = L0; e <= L1; e++) {
      const yy = padT + (1 - (e - L0) / (L1 - L0)) * plotH;
      ctx.strokeStyle = 'rgba(148,163,184,0.10)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, yy);
      ctx.lineTo(W - padR, yy);
      ctx.stroke();
      ctx.fillStyle = 'rgba(148,163,184,0.55)';
      ctx.fillText(`1e${e}`, 2, yy + 3);
    }

    // trained-horizon marker
    if (trainInnerSteps >= 0 && trainInnerSteps <= n - 1) {
      const xx = sx(trainInnerSteps);
      ctx.strokeStyle = 'rgba(148,163,184,0.35)';
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(xx, padT);
      ctx.lineTo(xx, H - padB);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(148,163,184,0.6)';
      ctx.fillText('train', xx - 10, padT + 9);
    }

    const drawLine = (arr: number[], stroke: string, w: number) => {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = w;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < arr.length; i++) {
        if (!Number.isFinite(arr[i])) continue;
        const xx = sx(i);
        const yy = sy(arr[i]);
        if (!started) {
          ctx.moveTo(xx, yy);
          started = true;
        } else ctx.lineTo(xx, yy);
      }
      ctx.stroke();
      // dots
      ctx.fillStyle = stroke;
      for (let i = 0; i < arr.length; i++) {
        if (!Number.isFinite(arr[i])) continue;
        ctx.beginPath();
        ctx.arc(sx(i), sy(arr[i]), 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    drawLine(view.random, 'rgba(148,163,184,0.85)', 1.75);
    drawLine(view.meta, 'rgba(52,211,153,1)', 2.25);

    // x-axis labels (a few)
    ctx.fillStyle = 'rgba(148,163,184,0.55)';
    for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 6))) {
      ctx.fillText(String(view.steps[i]), sx(i) - 3, H - 8);
    }
  }, [view, trainInnerSteps, width, height]);

  return <canvas ref={ref} style={{ width, height, display: 'block', borderRadius: 8 }} />;
}
