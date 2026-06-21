import { useEffect, useMemo, useRef } from 'react';
import type { GPT } from '../../engine/transformer';
import { tokenLabel } from '../../engine/seqtasks';

interface Props {
  gpt: GPT;
  probeIds: Int32Array;
  answerStart: number;
  tick: number;
}

// Dark → teal → white sequential ramp for an attention weight in [0,1].
function attnColor(v: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, v));
  if (x < 0.5) {
    const t = x / 0.5; // [12,18,32] -> teal
    return [Math.round(12 + (45 - 12) * t), Math.round(18 + (212 - 18) * t), Math.round(32 + (191 - 32) * t)];
  }
  const t = (x - 0.5) / 0.5; // teal -> white
  return [Math.round(45 + (240 - 45) * t), Math.round(212 + (250 - 212) * t), Math.round(191 + (255 - 191) * t)];
}

function HeadCanvas({ map, labels, answerStart, layer, head }: {
  map: Float64Array;
  labels: string[];
  answerStart: number;
  layer: number;
  head: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const T = labels.length;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const pad = 13;
    const cell = Math.max(8, Math.min(22, Math.floor(150 / T)));
    const grid = cell * T;
    const W = grid + pad;
    const H = grid + pad;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // heatmap cells (row = query position, col = key position)
    const img = ctx.createImageData(grid, grid);
    for (let i = 0; i < T; i++) {
      for (let j = 0; j < T; j++) {
        const [r, g, b] = attnColor(map[i * T + j]);
        for (let dy = 0; dy < cell; dy++) {
          for (let dx = 0; dx < cell; dx++) {
            const px = ((i * cell + dy) * grid + (j * cell + dx)) * 4;
            img.data[px] = r;
            img.data[px + 1] = g;
            img.data[px + 2] = b;
            img.data[px + 3] = 255;
          }
        }
      }
    }
    ctx.putImageData(img, pad, pad);

    // axis token labels
    ctx.font = `${Math.min(11, cell - 1)}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let k = 0; k < T; k++) {
      const isAns = k >= answerStart;
      ctx.fillStyle = isAns ? '#7dd3fc' : '#64748b';
      ctx.fillText(labels[k], pad + k * cell + cell / 2, pad / 2); // top = keys
      ctx.fillText(labels[k], pad / 2, pad + k * cell + cell / 2); // left = queries
    }
    // separator at the answer boundary
    if (answerStart > 0 && answerStart < T) {
      ctx.strokeStyle = 'rgba(125,211,252,0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(pad + answerStart * cell, pad);
      ctx.lineTo(pad + answerStart * cell, pad + grid);
      ctx.moveTo(pad, pad + answerStart * cell);
      ctx.lineTo(pad + grid, pad + answerStart * cell);
      ctx.stroke();
    }
  }, [map, labels, answerStart, T]);

  return (
    <div className="attn-head">
      <div className="attn-head-label">
        L{layer} · H{head}
      </div>
      <canvas ref={ref} />
    </div>
  );
}

export default function AttentionMaps({ gpt, probeIds, answerStart, tick }: Props) {
  // Re-run a single forward with attention capture whenever the weights change (tick).
  const snap = useMemo(() => {
    gpt.forward(probeIds, true);
    return gpt.lastAttn;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gpt, probeIds, tick]);

  const labels = useMemo(() => Array.from(probeIds, (t) => tokenLabel(t)), [probeIds]);

  if (!snap) return null;
  return (
    <div className="card attn-card">
      <div className="card-title">
        Attention · <span className="muted small">causal self-attention weights on a worked example — row = query
        token, column = key it attends to</span>
      </div>
      <div className="attn-probe">
        {labels.map((c, i) => (
          <span key={i} className={i >= answerStart ? 'tok ans' : 'tok'}>
            {c}
          </span>
        ))}
        <span className="muted small attn-probe-note">↑ the example the maps below are reading</span>
      </div>
      <div className="attn-grid">
        {snap.maps.map((layer, li) =>
          layer.map((map, hi) => (
            <HeadCanvas
              key={`${li}-${hi}`}
              map={map}
              labels={labels}
              answerStart={answerStart}
              layer={li}
              head={hi}
            />
          )),
        )}
      </div>
    </div>
  );
}
