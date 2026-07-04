import { useEffect, useRef } from 'react';
import type { SNNTrace } from '../../engine/snn';

interface Props {
  trace: SNNTrace | null;
  threshold: number;
  width?: number;
  height?: number;
}

// The classic LIF plot: a handful of hidden neurons' membrane potential U(t) integrating input
// current, climbing toward the threshold θ (dashed), firing a spike (dot) the instant it crosses,
// then resetting by −θ. This is what the surrogate gradient is silently differentiating.
export default function MembraneTraces({ trace, threshold, width = 560, height = 190 }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !trace || trace.layers.length === 0) return;
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

    const layer = trace.layers[0];
    const T = trace.T;
    const H = layer.H;
    const nShow = Math.min(5, H);
    // Pick the most active neurons so the trace is lively.
    const activity = new Array(H).fill(0);
    for (const f of layer.spikes) for (let j = 0; j < H; j++) activity[j] += f[j];
    const order = Array.from({ length: H }, (_, j) => j).sort((a, b) => activity[b] - activity[a]);
    const picks = order.slice(0, nShow);

    const pad = 8;
    const plotW = width - 2 * pad;
    const plotH = height - 2 * pad;
    // vertical range: cover reset trough to a bit above threshold
    let lo = -threshold * 1.2;
    let hi = threshold * 1.6;
    for (const j of picks) for (let t = 0; t < T; t++) {
      const v = layer.membrane[t][j];
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    const span = hi - lo < 1e-6 ? 1 : hi - lo;
    const xAt = (t: number) => pad + (T <= 1 ? 0 : (t / (T - 1)) * plotW);
    const yAt = (v: number) => pad + (1 - (v - lo) / span) * plotH;

    // threshold line
    ctx.strokeStyle = 'rgba(74,222,128,0.55)';
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad, yAt(threshold));
    ctx.lineTo(width - pad, yAt(threshold));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(74,222,128,0.8)';
    ctx.font = '9px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText('θ = ' + threshold, pad + 2, yAt(threshold) - 2);
    // zero line
    ctx.strokeStyle = 'rgba(148,163,184,0.15)';
    ctx.beginPath();
    ctx.moveTo(pad, yAt(0));
    ctx.lineTo(width - pad, yAt(0));
    ctx.stroke();

    const colors = ['#38bdf8', '#f472b6', '#a3e635', '#fbbf24', '#a78bfa'];
    picks.forEach((j, k) => {
      const color = colors[k % colors.length];
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let t = 0; t < T; t++) {
        const x = xAt(t);
        const yv = yAt(layer.membrane[t][j]);
        if (t === 0) ctx.moveTo(x, yv);
        else ctx.lineTo(x, yv);
      }
      ctx.stroke();
      // spike markers
      ctx.fillStyle = color;
      for (let t = 0; t < T; t++) {
        if (layer.spikes[t][j] > 0) {
          const x = xAt(t);
          ctx.beginPath();
          ctx.arc(x, yAt(threshold), 2.6, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    });
  }, [trace, threshold, width, height]);

  if (!trace) return <div className="muted small">Initializing…</div>;
  return <canvas ref={ref} className="chart" />;
}
