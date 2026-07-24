import { useEffect, useRef } from 'react';
import type { FourierSpectrum as Spectrum } from '../../engine/grok';

interface Props {
  spectrum: Spectrum | null;
  width: number;
  height: number;
}

// The mechanistic payoff, part 2 — the smoking gun. Take the Discrete Fourier Transform of the
// learned number-embedding table over the token index and plot the power at each frequency k. A
// *memorizing* network spreads its energy roughly uniformly across all frequencies; a *grokked*
// network concentrates almost all of it on a handful of "key frequencies" — the exact cos/sin
// components it uses to turn addition into rotation. Watching this bar chart collapse from a flat
// hedge to a few sharp spikes *is* watching the algorithm crystallize.
export default function FourierSpectrum({ spectrum, width, height }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const W = width;
    const H = height;
    const padB = 16;
    const padT = 6;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, W, H);
    if (!spectrum) return;

    const kMax = spectrum.power.length - 1;
    if (kMax < 1) return;
    let peak = 1e-6;
    for (let k = 1; k <= kMax; k++) peak = Math.max(peak, spectrum.power[k]);
    const plotH = H - padT - padB;
    const gap = 1;
    const barW = Math.max(1, (W - (kMax - 1) * gap) / kMax);
    const keySet = new Set(spectrum.keyFreqs);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.font = '9px ui-monospace, monospace';
    for (let k = 1; k <= kMax; k++) {
      const x = (k - 1) * (barW + gap);
      const h = (spectrum.power[k] / peak) * plotH;
      const isKey = keySet.has(k);
      ctx.fillStyle = isKey ? '#38bdf8' : 'rgba(148,163,184,0.35)';
      ctx.fillRect(x, padT + plotH - h, barW, h);
      if (isKey) {
        ctx.fillStyle = 'rgba(56,189,248,0.9)';
        ctx.fillText(String(k), x + barW / 2, padT + plotH + 3);
      }
    }
  }, [spectrum, width, height]);

  const spark = spectrum ? spectrum.sparsity : NaN;
  const keys = spectrum ? spectrum.keyFreqs.slice(0, 8) : [];

  return (
    <div className="chart-wrap">
      <canvas ref={canvasRef} width={width} height={height} className="chart" />
      <div className="chart-legend">
        <span className="legend-item">
          <span className="swatch" style={{ background: '#38bdf8' }} /> key freqs{' '}
          <b>{keys.length ? keys.join(', ') : '—'}</b>
        </span>
        <span className="legend-item">
          sparsity <b>{Number.isFinite(spark) ? spark.toFixed(3) : '—'}</b>
        </span>
      </div>
    </div>
  );
}
