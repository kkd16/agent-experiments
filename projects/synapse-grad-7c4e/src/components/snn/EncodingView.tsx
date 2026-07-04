import { useEffect, useRef } from 'react';
import type { SNNTrace, EncodingKind } from '../../engine/snn';

interface Props {
  trace: SNNTrace | null;
  encoding: EncodingKind;
  labels: string[];
  truth: number;
}

const ENC_LABEL: Record<EncodingKind, string> = {
  current: 'constant current',
  poisson: 'Poisson rate',
  latency: 'latency (TTFS)',
};

// The stimulus side: the spotlight glyph (time-averaged input drive) and how it becomes spikes.
export default function EncodingView({ trace, encoding, labels, truth }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const G = trace ? Math.round(Math.sqrt(trace.inDim)) : 0;
  const px = 9;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !trace || G === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = G * px * dpr;
    canvas.height = G * px * dpr;
    canvas.style.width = G * px + 'px';
    canvas.style.height = G * px + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // time-averaged input drive per pixel = firing rate (spike encodings) or brightness (current).
    const avg = new Float64Array(trace.inDim);
    for (const f of trace.input) for (let i = 0; i < trace.inDim; i++) avg[i] += f[i];
    let mx = 1e-6;
    for (let i = 0; i < trace.inDim; i++) {
      avg[i] /= trace.T;
      mx = Math.max(mx, avg[i]);
    }
    for (let y = 0; y < G; y++) {
      for (let x = 0; x < G; x++) {
        const v = avg[y * G + x] / mx;
        const g = Math.round(v * 210);
        ctx.fillStyle = `rgb(${Math.round(g * 0.5)}, ${g}, ${Math.round(g * 0.9)})`;
        ctx.fillRect(x * px, y * px, px, px);
      }
    }
  }, [trace, G]);

  if (!trace) return <div className="muted small">Initializing…</div>;
  const correct = trace.pred === truth;
  return (
    <div className="enc-view">
      <canvas ref={ref} className="enc-canvas" />
      <div className="enc-meta">
        <div className="muted small">encoding · {ENC_LABEL[encoding]}</div>
        <div className="enc-pred">
          predicted <b className={correct ? 'ok-text' : 'warn-text'}>{labels[trace.pred] ?? trace.pred}</b>
          <span className="muted small"> · true {labels[truth] ?? truth}</span>
        </div>
        <div className="muted small">
          {correct ? '✓ correct' : '✗ wrong'} — from {trace.T} timesteps of spikes, no pixel ever read directly.
        </div>
      </div>
    </div>
  );
}
