import { useEffect, useRef } from 'react';

interface Props {
  pre: number[]; // pre-adaptation query loss (regression) / accuracy (classification)
  post: number[]; // post-adaptation query loss / accuracy (the meta-objective)
  linear?: boolean; // true = accuracy 0..1 on a linear axis; false = log loss
  width: number;
  height: number;
}

// The meta-training curve: pre-adaptation query loss (amber, how well θ does *without* adapting)
// vs post-adaptation query loss (emerald, the meta-objective — how well θ does *after* K inner
// steps). The gap between them is the value of adaptation, and it widens as meta-learning succeeds.
// Log scale so the whole descent is visible.
export default function MetaLossChart({ pre, post, linear = false, width, height }: Props) {
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

    const padL = 40;
    const padR = 10;
    const padT = 10;
    const padB = 14;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const n = Math.max(pre.length, post.length);
    if (n < 2) return;

    const all = [...pre, ...post].filter((v) => Number.isFinite(v) && (linear || v > 0));
    if (all.length === 0) return;
    const lo = Math.min(...all);
    const hi = Math.max(...all);
    const L0 = Math.floor(Math.log10(Math.max(lo, 1e-4)));
    const L1 = Math.max(Math.ceil(Math.log10(Math.max(hi, 1e-3))), L0 + 1);

    const sx = (i: number) => padL + (i / (n - 1)) * plotW;
    const sy = linear
      ? (v: number) => padT + (1 - Math.max(0, Math.min(1, v))) * plotH
      : (v: number) => {
          const lg = Math.log10(Math.max(v, Math.pow(10, L0)));
          return padT + (1 - (lg - L0) / (L1 - L0)) * plotH;
        };

    ctx.font = '10px ui-monospace, monospace';
    if (linear) {
      for (let k = 0; k <= 4; k++) {
        const v = k / 4;
        const yy = sy(v);
        ctx.strokeStyle = 'rgba(148,163,184,0.10)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(padL, yy);
        ctx.lineTo(W - padR, yy);
        ctx.stroke();
        ctx.fillStyle = 'rgba(148,163,184,0.5)';
        ctx.fillText(`${(v * 100).toFixed(0)}%`, 2, yy + 3);
      }
    } else {
      for (let e = L0; e <= L1; e++) {
        const yy = padT + (1 - (e - L0) / (L1 - L0)) * plotH;
        ctx.strokeStyle = 'rgba(148,163,184,0.10)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(padL, yy);
        ctx.lineTo(W - padR, yy);
        ctx.stroke();
        ctx.fillStyle = 'rgba(148,163,184,0.5)';
        ctx.fillText(`1e${e}`, 2, yy + 3);
      }
    }

    const drawLine = (arr: number[], stroke: string, w: number) => {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = w;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < arr.length; i++) {
        if (!Number.isFinite(arr[i]) || (!linear && arr[i] <= 0)) continue;
        const xx = sx(i);
        const yy = sy(arr[i]);
        if (!started) {
          ctx.moveTo(xx, yy);
          started = true;
        } else ctx.lineTo(xx, yy);
      }
      ctx.stroke();
    };

    drawLine(pre, 'rgba(251,191,36,0.9)', 1.5);
    drawLine(post, 'rgba(52,211,153,1)', 2);
  }, [pre, post, linear, width, height]);

  return <canvas ref={ref} style={{ width, height, display: 'block', borderRadius: 8 }} />;
}
