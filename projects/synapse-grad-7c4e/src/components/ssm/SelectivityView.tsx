import { useEffect, useMemo, useRef, useState } from 'react';
import type { MambaLM } from '../../engine/ssm';
import { tokenLabel } from '../../engine/ssmtasks';

interface Props {
  model: MambaLM;
  probeIds: Int32Array;
  answerStart: number;
  tick: number;
}

// Dark → amber → white heat ramp for a normalised selectivity Δ ∈ [0,1] (a different palette
// than the attention teal / MoE violet, so the views are never confused).
function heat(v: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, v));
  if (x < 0.5) {
    const t = x / 0.5; // [12,16,30] → amber
    return [Math.round(12 + (245 - 12) * t), Math.round(16 + (158 - 16) * t), Math.round(30 + (11 - 30) * t)];
  }
  const t = (x - 0.5) / 0.5; // amber → white
  return [Math.round(245 + (255 - 245) * t), Math.round(158 + (255 - 158) * t), Math.round(11 + (250 - 11) * t)];
}

function LayerHeatmap({
  delta,
  labels,
  answerStart,
  T,
  dInner,
}: {
  delta: Float64Array;
  labels: string[];
  answerStart: number;
  T: number;
  dInner: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const padL = 26;
    const padT = 16;
    const cellW = Math.max(5, Math.min(14, Math.floor(420 / dInner)));
    const cellH = Math.max(12, Math.min(22, Math.floor(300 / T)));
    const gridW = cellW * dInner;
    const gridH = cellH * T;
    const W = gridW + padL + 4;
    const H = gridH + padT + 4;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // Robust per-view normalisation: scale by the 98th-percentile Δ so a few large values
    // don't wash everything out.
    const sorted = Array.from(delta).sort((a, b) => a - b);
    const hi = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.98))] || 1e-6;
    const norm = (v: number) => v / (hi + 1e-9);

    for (let t = 0; t < T; t++) {
      for (let d = 0; d < dInner; d++) {
        const [r, g, b] = heat(norm(delta[t * dInner + d]));
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(padL + d * cellW, padT + t * cellH, Math.max(1, cellW - 1), cellH - 1);
      }
    }

    // token row labels (answer span highlighted)
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let t = 0; t < T; t++) {
      ctx.fillStyle = t >= answerStart ? '#fbbf24' : '#64748b';
      ctx.fillText(labels[t], padL / 2, padT + t * cellH + cellH / 2);
    }
    // channel axis caption
    ctx.fillStyle = '#94a3b8';
    ctx.textAlign = 'left';
    ctx.fillText('inner channels →', padL, padT / 2 + 1);
    // answer boundary
    if (answerStart > 0 && answerStart < T) {
      ctx.strokeStyle = 'rgba(251,191,36,0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, padT + answerStart * cellH);
      ctx.lineTo(padL + gridW, padT + answerStart * cellH);
      ctx.stroke();
    }
  }, [delta, labels, answerStart, T, dInner]);

  return <canvas ref={ref} />;
}

// The headline State-Space view: the selectivity Δ per token (row) per inner channel (column).
// Δ = softplus(...) is the *input-dependent timestep* — large Δ means "this input matters, write
// it into the state", small Δ means "ignore it, carry the state forward". This is exactly the
// gate that lets a *selective* SSM (S6) beat a linear-time-invariant one: it can choose, per
// token and per channel, what to remember. Bright stripes mark the tokens the model latches onto.
export default function SelectivityView({ model, probeIds, answerStart, tick }: Props) {
  const [layer, setLayer] = useState(0);
  const snap = useMemo(() => {
    model.forward(probeIds, true);
    return model.lastSnapshot;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, probeIds, tick]);
  const labels = useMemo(() => Array.from(probeIds, (t) => tokenLabel(t)), [probeIds]);

  if (!snap) return null;
  const L = Math.min(layer, snap.nLayers - 1);

  return (
    <div className="card">
      <div className="card-title">
        Selectivity Δ ·{' '}
        <span className="muted small">
          row = token, column = inner channel, brightness = how much the model writes that input
          into its state (the S6 gate)
        </span>
      </div>
      {snap.nLayers > 1 && (
        <div className="seg moe-layer-seg">
          {Array.from({ length: snap.nLayers }, (_, i) => (
            <button key={i} className={i === L ? 'on' : ''} onClick={() => setLayer(i)}>
              Layer {i}
            </button>
          ))}
        </div>
      )}
      <div className="moe-heatmap-wrap">
        <LayerHeatmap
          delta={snap.delta[L]}
          labels={labels}
          answerStart={answerStart}
          T={snap.T}
          dInner={snap.dInner}
        />
      </div>
    </div>
  );
}
