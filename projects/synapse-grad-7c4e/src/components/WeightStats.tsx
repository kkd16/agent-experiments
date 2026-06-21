import { useEffect, useRef } from 'react';
import type { TrainerHandle, TrainerMetrics } from '../hooks/useTrainer';

interface Props {
  handle: TrainerHandle;
  metrics: TrainerMetrics;
  tick: number;
}

interface LayerStat {
  name: string;
  wNorm: number;
  gNorm: number;
  count: number;
}

// Per-layer weight & gradient L2 norms (a quick read on whether signals are vanishing or
// exploding) plus a live sparkline of the global gradient norm across training.
export default function WeightStats({ handle, metrics, tick }: Props) {
  const sparkRef = useRef<HTMLCanvasElement>(null);
  const model = handle.model;

  const stats: LayerStat[] = [];
  if (model) {
    model.layers.forEach((layer, i) => {
      let w = 0;
      let g = 0;
      for (let k = 0; k < layer.weight.size; k++) {
        w += layer.weight.data[k] * layer.weight.data[k];
        g += layer.weight.grad[k] * layer.weight.grad[k];
      }
      stats.push({
        name: i === model.layers.length - 1 ? 'out' : `L${i + 1}`,
        wNorm: Math.sqrt(w),
        gNorm: Math.sqrt(g),
        count: layer.weight.size + layer.bias.size,
      });
    });
  }
  const maxW = Math.max(...stats.map((s) => s.wNorm), 1e-6);
  const maxG = Math.max(...stats.map((s) => s.gNorm), 1e-6);

  useEffect(() => {
    const canvas = sparkRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, W, H);
    const hist = metrics.gradNormHistory;
    if (hist.length < 2) return;
    const max = Math.max(...hist, 1e-6);
    ctx.beginPath();
    for (let i = 0; i < hist.length; i++) {
      const x = (i / (hist.length - 1)) * W;
      const y = H - (hist[i] / max) * (H - 4) - 2;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }, [tick, metrics.gradNormHistory]);

  if (!model) return null;

  return (
    <div className="wstats">
      <div className="wstats-rows">
        {stats.map((s) => (
          <div className="wstat-row" key={s.name}>
            <span className="wstat-name">{s.name}</span>
            <span className="wstat-bars">
              <span className="wbar"><span className="wbar-fill w" style={{ width: `${(s.wNorm / maxW) * 100}%` }} /></span>
              <span className="wbar"><span className="wbar-fill g" style={{ width: `${(s.gNorm / maxG) * 100}%` }} /></span>
            </span>
            <span className="wstat-vals">
              <b>{s.wNorm.toFixed(2)}</b>
              <i>{s.gNorm.toExponential(1)}</i>
            </span>
          </div>
        ))}
      </div>
      <div className="wstats-legend">
        <span><span className="swatch" style={{ background: '#38bdf8' }} /> ‖W‖</span>
        <span><span className="swatch" style={{ background: '#a78bfa' }} /> ‖∂W‖</span>
        <span className="gn">
          grad‑norm <b>{Number.isFinite(metrics.gradNorm) ? metrics.gradNorm.toFixed(3) : '—'}</b>
        </span>
      </div>
      <canvas ref={sparkRef} width={260} height={40} className="wstats-spark" />
    </div>
  );
}
