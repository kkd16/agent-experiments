import { useEffect, useMemo, useRef, useState } from 'react';
import type { MambaLM } from '../../engine/ssm';
import { tokenLabel } from '../../engine/ssmtasks';

interface Props {
  model: MambaLM;
  probeIds: Int32Array;
  answerStart: number;
  tick: number;
}

// How information lives in the recurrence over a worked example: the per-token state magnitude
// ‖h_l‖ (amber, how much is being held) and the mean selectivity Δ̄ over channels (cyan, how
// much each token writes). Together they read the SSM the way the attention map reads a
// Transformer — but it is O(L) memory, not O(L²).
export default function StateView({ model, probeIds, answerStart, tick }: Props) {
  const [layer, setLayer] = useState(0);
  const ref = useRef<HTMLCanvasElement>(null);
  const snap = useMemo(() => {
    model.forward(probeIds, true);
    return model.lastSnapshot;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, probeIds, tick]);
  const labels = useMemo(() => Array.from(probeIds, (t) => tokenLabel(t)), [probeIds]);

  const L = snap ? Math.min(layer, snap.nLayers - 1) : 0;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !snap) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const T = snap.T;
    const padL = 30;
    const padR = 30;
    const padT = 12;
    const padB = 20;
    const cw = Math.max(18, Math.min(40, Math.floor(480 / T)));
    const W = padL + padR + cw * T;
    const H = 150;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, W, H);

    const state = snap.stateNorm[L];
    const dmean = snap.deltaTokenMean[L];
    const maxState = Math.max(...state, 1e-6);
    const maxDelta = Math.max(...dmean, 1e-6);
    const xAt = (t: number) => padL + cw * t + cw / 2;
    const plotH = H - padT - padB;

    // answer boundary
    if (answerStart > 0 && answerStart < T) {
      const bx = padL + cw * answerStart;
      ctx.strokeStyle = 'rgba(251,191,36,0.35)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(bx, padT);
      ctx.lineTo(bx, padT + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // state-norm bars (amber)
    for (let t = 0; t < T; t++) {
      const h = (state[t] / maxState) * plotH;
      ctx.fillStyle = 'rgba(245,158,11,0.5)';
      ctx.fillRect(padL + cw * t + 3, padT + plotH - h, cw - 6, h);
    }
    // mean-Δ line (cyan)
    ctx.strokeStyle = '#22d3ee';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let t = 0; t < T; t++) {
      const y = padT + plotH - (dmean[t] / maxDelta) * plotH;
      if (t === 0) ctx.moveTo(xAt(t), y);
      else ctx.lineTo(xAt(t), y);
    }
    ctx.stroke();
    for (let t = 0; t < T; t++) {
      const y = padT + plotH - (dmean[t] / maxDelta) * plotH;
      ctx.fillStyle = '#22d3ee';
      ctx.beginPath();
      ctx.arc(xAt(t), y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
    // token labels
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let t = 0; t < T; t++) {
      ctx.fillStyle = t >= answerStart ? '#fbbf24' : '#64748b';
      ctx.fillText(labels[t], xAt(t), H - padB / 2);
    }
  }, [snap, L, labels, answerStart]);

  if (!snap) return null;

  return (
    <div className="card">
      <div className="card-title">
        State &amp; selectivity over the sequence{' '}
        <span className="muted small">· amber bars = ‖state‖, cyan line = mean Δ per token</span>
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
      <canvas ref={ref} />
    </div>
  );
}
