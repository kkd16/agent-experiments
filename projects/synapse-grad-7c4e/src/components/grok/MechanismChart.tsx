import { useEffect, useRef } from 'react';
import type { GrokPoint } from '../../hooks/useGrokTrainer';

interface Props {
  history: GrokPoint[];
  grokStep: number;
  width: number;
  height: number;
}

// Why grokking happens, in two traces. Plotted against the same log-step axis as the accuracy
// curve: (1) the **weight norm** ‖θ‖, normalized to its own running maximum — weight decay grinds
// it down, and the network is pushed off the sharp, high-norm memorizing solution onto the
// smoother, low-norm generalizing one; (2) the **DFT sparsity** of the embedding table, which
// climbs from ~0 (energy everywhere) toward 1 (energy on a few key frequencies) exactly as the
// circle forms. The generalization jump in the headline chart lines up with the crossover here.
export default function MechanismChart({ history, grokStep, width, height }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const W = width;
    const H = height;
    const padL = 6;
    const padR = 6;
    const padT = 8;
    const padB = 18;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, W, H);

    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const pts = history.filter((p) => Number.isFinite(p.weightNorm));
    if (pts.length < 2) return;

    const lastStep = pts[pts.length - 1].step;
    const xMax = Math.max(10, lastStep);
    const logMax = Math.log10(xMax) || 1;
    const xAt = (step: number) => padL + (Math.log10(Math.max(1, step)) / logMax) * plotW;

    let wnMax = 1e-6;
    for (const p of pts) wnMax = Math.max(wnMax, p.weightNorm);
    const yWN = (v: number) => padT + (1 - v / wnMax) * plotH;
    const ySp = (v: number) => padT + (1 - Math.max(0, Math.min(1, v))) * plotH;

    // decade gridlines
    ctx.strokeStyle = 'rgba(148,163,184,0.08)';
    ctx.lineWidth = 1;
    for (let d = 1; Math.pow(10, d) <= xMax * 1.0000001; d++) {
      const x = xAt(Math.pow(10, d));
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + plotH);
      ctx.stroke();
    }

    if (grokStep > 0) {
      const x = xAt(grokStep);
      ctx.strokeStyle = 'rgba(74,222,128,0.4)';
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    const draw = (fy: (p: GrokPoint) => number, color: string) => {
      ctx.beginPath();
      let started = false;
      for (const p of pts) {
        const x = xAt(p.step);
        const y = fy(p);
        if (!Number.isFinite(y)) continue;
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
    };

    draw((p) => yWN(p.weightNorm), '#a78bfa'); // violet = weight norm
    draw((p) => ySp(p.sparsity), '#38bdf8'); // sky = DFT sparsity
  }, [history, grokStep, width, height]);

  const last = history.length ? history[history.length - 1] : null;

  return (
    <div className="chart-wrap">
      <canvas ref={canvasRef} width={width} height={height} className="chart" />
      <div className="chart-legend">
        <span className="legend-item">
          <span className="swatch" style={{ background: '#a78bfa' }} /> ‖weights‖{' '}
          <b>{last && Number.isFinite(last.weightNorm) ? last.weightNorm.toFixed(1) : '—'}</b>
        </span>
        <span className="legend-item">
          <span className="swatch" style={{ background: '#38bdf8' }} /> DFT sparsity{' '}
          <b>{last && Number.isFinite(last.sparsity) ? last.sparsity.toFixed(3) : '—'}</b>
        </span>
      </div>
    </div>
  );
}
