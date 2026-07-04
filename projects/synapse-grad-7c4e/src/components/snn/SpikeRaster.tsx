import { useEffect, useRef } from 'react';
import type { SNNTrace } from '../../engine/snn';

interface Props {
  trace: SNNTrace | null;
  width?: number;
}

// The headline view: the network's activity as a spike raster — neurons stacked vertically, time
// running left→right, a lit cell wherever a neuron fired. The input layer's encoded spike train is
// on top, then each LIF hidden layer, then the readout membrane. This is exactly how neuroscience
// plots a population recording, and how you *read* a spiking net: sparse, event-driven, temporal.
export default function SpikeRaster({ trace, width = 560 }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !trace) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const T = trace.T;

    // Sections: input + each hidden layer. Cap displayed rows per section so tall layers stay legible.
    type Sec = { name: string; rows: number; frames: Float64Array[]; accent: string; binary: boolean };
    const secs: Sec[] = [];
    secs.push({ name: `input · ${trace.inDim}`, rows: trace.inDim, frames: trace.input, accent: '148,163,184', binary: false });
    const layerAccents = ['56,189,248', '244,114,182', '163,230,53'];
    trace.layers.forEach((l, i) =>
      secs.push({ name: `${l.name} · ${l.H}`, rows: l.H, frames: l.spikes, accent: layerAccents[i % layerAccents.length], binary: true }),
    );

    const labelW = 78;
    const plotW = width - labelW - 8;
    const gap = 14;
    const rowH = (rows: number) => Math.max(0.9, Math.min(6, 150 / rows));
    const secH = (s: Sec) => Math.min(160, s.rows * rowH(s.rows));
    const totalH = secs.reduce((a, s) => a + secH(s) + gap, 8) + 4;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = width * dpr;
    canvas.height = totalH * dpr;
    canvas.style.width = width + 'px';
    canvas.style.height = totalH + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, totalH);

    let y = 6;
    const colW = plotW / T;
    for (const s of secs) {
      const h = secH(s);
      const rh = h / s.rows;
      // panel background
      ctx.fillStyle = '#0b1220';
      ctx.fillRect(labelW, y, plotW, h);
      // label
      ctx.fillStyle = 'rgba(226,232,240,0.85)';
      ctx.font = '10px ui-monospace, monospace';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(s.name, labelW - 6, y + h / 2);
      // spikes
      for (let t = 0; t < T; t++) {
        const frame = s.frames[t];
        if (!frame) continue;
        const x = labelW + t * colW;
        for (let r = 0; r < s.rows; r++) {
          const v = frame[r];
          if (v <= 0) continue;
          const a = s.binary ? 0.95 : Math.max(0.12, Math.min(1, v));
          ctx.fillStyle = `rgba(${s.accent},${a})`;
          const cy = y + r * rh;
          ctx.fillRect(x, cy, Math.max(1, colW - 0.5), Math.max(0.8, rh - 0.4));
        }
      }
      y += h + gap;
    }

    // time axis ticks under the last panel
    ctx.strokeStyle = 'rgba(148,163,184,0.15)';
    ctx.fillStyle = 'rgba(148,163,184,0.6)';
    ctx.font = '9px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let t = 0; t <= T; t += Math.max(1, Math.round(T / 8))) {
      const x = labelW + t * colW;
      ctx.fillText(String(t), x, y - gap + 2);
    }
  }, [trace, width]);

  if (!trace) return <div className="muted small">Initializing…</div>;
  return (
    <div className="raster-wrap">
      <canvas ref={ref} className="raster" />
      <div className="muted small" style={{ marginTop: 2, textAlign: 'right' }}>
        time (simulation steps) →
      </div>
    </div>
  );
}
