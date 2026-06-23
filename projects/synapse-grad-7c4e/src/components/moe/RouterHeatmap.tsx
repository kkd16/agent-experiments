import { useEffect, useMemo, useRef, useState } from 'react';
import type { MoEGPT } from '../../engine/moe';
import { tokenLabel } from '../../engine/seqtasks';

interface Props {
  moe: MoEGPT;
  probeIds: Int32Array;
  answerStart: number;
  tick: number;
}

// Dark → violet → white ramp for a router weight in [0,1] (a different palette than the teal
// attention maps, so the two views are never confused).
function routeColor(v: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, v));
  if (x < 0.5) {
    const t = x / 0.5; // [12,16,30] -> violet
    return [Math.round(12 + (124 - 12) * t), Math.round(16 + (58 - 16) * t), Math.round(30 + (237 - 30) * t)];
  }
  const t = (x - 0.5) / 0.5; // violet -> white
  return [Math.round(124 + (245 - 124) * t), Math.round(58 + (243 - 58) * t), Math.round(237 + (255 - 237) * t)];
}

function LayerHeatmap({
  combine,
  topIdx,
  labels,
  answerStart,
  T,
  E,
  k,
}: {
  combine: Float64Array;
  topIdx: Int32Array;
  labels: string[];
  answerStart: number;
  T: number;
  E: number;
  k: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const padL = 26;
    const padT = 18;
    const cellW = Math.max(20, Math.min(46, Math.floor(360 / E)));
    const cellH = Math.max(14, Math.min(24, Math.floor(300 / T)));
    const gridW = cellW * E;
    const gridH = cellH * T;
    const W = gridW + padL + 4;
    const H = gridH + padT + 4;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // membership set per token for the top-k outline
    for (let t = 0; t < T; t++) {
      for (let e = 0; e < E; e++) {
        const v = combine[t * E + e];
        const [r, g, b] = routeColor(v);
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(padL + e * cellW, padT + t * cellH, cellW - 1, cellH - 1);
        if (v > 0.14) {
          ctx.fillStyle = v > 0.55 ? '#0b1220' : '#e8e6ff';
          ctx.font = `${Math.min(11, cellH - 3)}px ui-monospace, monospace`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(`${Math.round(v * 100)}`, padL + e * cellW + cellW / 2, padT + t * cellH + cellH / 2);
        }
      }
      // outline the chosen experts
      ctx.strokeStyle = 'rgba(167,139,250,0.9)';
      ctx.lineWidth = 1.5;
      for (let s = 0; s < k; s++) {
        const e = topIdx[t * k + s];
        ctx.strokeRect(padL + e * cellW + 0.5, padT + t * cellH + 0.5, cellW - 2, cellH - 2);
      }
    }

    // expert column labels
    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let e = 0; e < E; e++) ctx.fillText(`E${e}`, padL + e * cellW + cellW / 2, padT / 2);
    // token row labels
    ctx.textAlign = 'center';
    for (let t = 0; t < T; t++) {
      ctx.fillStyle = t >= answerStart ? '#c4b5fd' : '#64748b';
      ctx.fillText(labels[t], padL / 2, padT + t * cellH + cellH / 2);
    }
    // answer boundary
    if (answerStart > 0 && answerStart < T) {
      ctx.strokeStyle = 'rgba(196,181,253,0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, padT + answerStart * cellH);
      ctx.lineTo(padL + gridW, padT + answerStart * cellH);
      ctx.stroke();
    }
  }, [combine, topIdx, labels, answerStart, T, E, k]);

  return <canvas ref={ref} />;
}

// The headline routing view: for a worked example, which expert each token is sent to in each
// layer, with the renormalised top-k router weights shaded and the chosen experts outlined.
export default function RouterHeatmap({ moe, probeIds, answerStart, tick }: Props) {
  const [layer, setLayer] = useState(0);
  const snap = useMemo(() => {
    moe.forward(probeIds);
    return moe.lastRouting;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moe, probeIds, tick]);
  const labels = useMemo(() => Array.from(probeIds, (t) => tokenLabel(t)), [probeIds]);

  if (!snap) return null;
  const L = Math.min(layer, snap.nLayers - 1);

  return (
    <div className="card">
      <div className="card-title">
        Router · <span className="muted small">where each token is sent — row = token, column = expert, cell =
        router weight %, outline = the top-{snap.topK} it was dispatched to</span>
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
          combine={snap.combine[L]}
          topIdx={snap.topIdx[L]}
          labels={labels}
          answerStart={answerStart}
          T={snap.T}
          E={snap.nExperts}
          k={snap.topK}
        />
      </div>
    </div>
  );
}
