import { useEffect, useRef } from 'react';
import { CLASS_COLORS, rgbCss } from '../../lib/colors';
import type { SNNTrace } from '../../engine/snn';

interface Props {
  trace: SNNTrace | null;
  labels: string[];
  truth: number;
  width?: number;
  height?: number;
}

// The decision, as a race. The readout is a non-spiking leaky integrator: each class's membrane
// accumulates evidence from the last hidden layer over time. We plot every class's integrated
// membrane V_c(t) climbing across the T steps — the highest at the end wins. The winning line is
// bold; the true class is ringed. You can watch the network *make up its mind*.
export default function ReadoutView({ trace, labels, truth, width = 560, height = 190 }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !trace) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, width, height);

    const T = trace.T;
    const K = trace.logits.length;
    // cumulative membrane over time already = trace.outMembrane (running integrator)
    const series = trace.outMembrane; // [T][K]
    let lo = Infinity;
    let hi = -Infinity;
    for (let t = 0; t < T; t++) for (let k = 0; k < K; k++) {
      lo = Math.min(lo, series[t][k]);
      hi = Math.max(hi, series[t][k]);
    }
    if (!Number.isFinite(lo)) return;
    const span = hi - lo < 1e-6 ? 1 : hi - lo;
    const pad = 8;
    const plotW = width - 2 * pad - 34;
    const plotH = height - 2 * pad;
    const xAt = (t: number) => pad + (T <= 1 ? 0 : (t / (T - 1)) * plotW);
    const yAt = (v: number) => pad + (1 - (v - lo) / span) * plotH;

    ctx.strokeStyle = 'rgba(148,163,184,0.12)';
    ctx.beginPath();
    ctx.moveTo(pad, yAt(0));
    ctx.lineTo(pad + plotW, yAt(0));
    ctx.stroke();

    for (let k = 0; k < K; k++) {
      const color = CLASS_COLORS[k % CLASS_COLORS.length];
      const winner = k === trace.pred;
      ctx.strokeStyle = rgbCss(color, winner ? 1 : 0.4);
      ctx.lineWidth = winner ? 2.4 : 1;
      ctx.beginPath();
      for (let t = 0; t < T; t++) {
        const x = xAt(t);
        const y = yAt(series[t][k]);
        if (t === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      // end label
      const yEnd = yAt(series[T - 1][k]);
      ctx.fillStyle = rgbCss(color, winner ? 1 : 0.55);
      ctx.font = (winner ? 'bold ' : '') + '10px ui-monospace, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const lab = labels[k] ?? String(k);
      ctx.fillText(k === truth ? '◦' + lab : lab, pad + plotW + 4, yEnd);
    }
  }, [trace, labels, truth, width, height]);

  if (!trace) return <div className="muted small">Initializing…</div>;
  return <canvas ref={ref} className="chart" />;
}
