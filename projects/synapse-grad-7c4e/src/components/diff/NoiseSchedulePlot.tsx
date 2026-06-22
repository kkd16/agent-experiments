import { useEffect, useRef } from 'react';
import type { NoiseSchedule } from '../../engine/diffusion';

interface Props {
  schedule: NoiseSchedule | null;
  width: number;
  height: number;
}

// The math made visible: the cumulative signal coefficient ᾱ_t (how much of the original glyph
// survives at step t), the per-step noise rate β_t, and the log signal-to-noise ratio. Together
// they *are* the forward process — ᾱ sliding from 1 (clean) to 0 (pure noise) as t runs 1→T.
export default function NoiseSchedulePlot({ schedule, width, height }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx || !schedule) return;
    const W = width;
    const H = height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, W, H);
    const pad = 6;
    ctx.strokeStyle = 'rgba(148,163,184,0.10)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad + (i / 4) * (H - 2 * pad);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }
    const T = schedule.T;

    const plot = (fn: (i: number) => number, lo: number, hi: number, color: string) => {
      ctx.beginPath();
      for (let i = 0; i < T; i++) {
        const x = pad + (i / (T - 1)) * (W - 2 * pad);
        const v = (fn(i) - lo) / (hi - lo);
        const y = pad + (1 - Math.max(0, Math.min(1, v))) * (H - 2 * pad);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
    };

    // ᾱ_t in [0,1]
    plot((i) => schedule.alphaBar[i], 0, 1, '#34d399');
    // β_t scaled to its own max so its shape reads
    let maxBeta = 1e-6;
    for (let i = 0; i < T; i++) maxBeta = Math.max(maxBeta, schedule.beta[i]);
    plot((i) => schedule.beta[i], 0, maxBeta, '#f59e0b');
    // log10 SNR mapped into a readable window
    plot((i) => Math.log10(Math.max(1e-6, schedule.snr(i))), -3, 4, '#60a5fa');
  }, [schedule, width, height]);

  return (
    <div className="chart-wrap">
      <canvas ref={canvasRef} width={width} height={height} className="chart" />
      <div className="chart-legend">
        <span className="legend-item">
          <span className="swatch" style={{ background: '#34d399' }} /> ᾱ<sub>t</sub>
        </span>
        <span className="legend-item">
          <span className="swatch" style={{ background: '#f59e0b' }} /> β<sub>t</sub>
        </span>
        <span className="legend-item">
          <span className="swatch" style={{ background: '#60a5fa' }} /> log SNR
        </span>
      </div>
    </div>
  );
}
