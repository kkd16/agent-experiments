import { useEffect, useMemo, useRef } from 'react';
import { attentionRollout, type GPT } from '../../engine/transformer';
import { tokenLabel } from '../../engine/seqtasks';

interface Props {
  gpt: GPT;
  probeIds: Int32Array;
  answerStart: number;
  tick: number;
}

// Dark → violet → white ramp, distinct from the teal attention heatmap so the two views read
// as different things (raw attention vs. compounded information flow).
function rollColor(v: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, Math.sqrt(v))); // sqrt lifts the small compounded weights
  if (x < 0.5) {
    const t = x / 0.5; // [12,14,30] -> violet
    return [Math.round(12 + (139 - 12) * t), Math.round(14 + (92 - 14) * t), Math.round(30 + (246 - 30) * t)];
  }
  const t = (x - 0.5) / 0.5; // violet -> white
  return [Math.round(139 + (245 - 139) * t), Math.round(92 + (243 - 92) * t), Math.round(246 + (255 - 246) * t)];
}

export default function AttentionRollout({ gpt, probeIds, answerStart, tick }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  const roll = useMemo(() => {
    gpt.forward(probeIds, true);
    return gpt.lastAttn ? attentionRollout(gpt.lastAttn) : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gpt, probeIds, tick]);

  const labels = useMemo(() => Array.from(probeIds, (t) => tokenLabel(t)), [probeIds]);
  const T = labels.length;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !roll) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const pad = 15;
    const cell = Math.max(10, Math.min(30, Math.floor(210 / T)));
    const grid = cell * T;
    const W = grid + pad;
    const H = grid + pad;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const img = ctx.createImageData(grid, grid);
    for (let i = 0; i < T; i++) {
      for (let j = 0; j < T; j++) {
        const [r, g, b] = rollColor(roll.final[i * T + j]);
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

    ctx.font = `${Math.min(12, cell - 1)}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let k = 0; k < T; k++) {
      const isAns = k >= answerStart;
      ctx.fillStyle = isAns ? '#c4b5fd' : '#64748b';
      ctx.fillText(labels[k], pad + k * cell + cell / 2, pad / 2);
      ctx.fillText(labels[k], pad / 2, pad + k * cell + cell / 2);
    }
    if (answerStart > 0 && answerStart < T) {
      ctx.strokeStyle = 'rgba(196,181,253,0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(pad + answerStart * cell, pad);
      ctx.lineTo(pad + answerStart * cell, pad + grid);
      ctx.moveTo(pad, pad + answerStart * cell);
      ctx.lineTo(pad + grid, pad + answerStart * cell);
      ctx.stroke();
    }
  }, [roll, labels, answerStart, T]);

  // The attribution of the *last* answer token over every input position — the headline row.
  const lastRow = useMemo(() => {
    if (!roll || T === 0) return [];
    const base = (T - 1) * T;
    const row: number[] = [];
    for (let j = 0; j < T; j++) row.push(roll.final[base + j]);
    return row;
  }, [roll, T]);
  const maxRow = Math.max(1e-9, ...lastRow);

  if (!roll) return null;
  return (
    <div className="card attn-card">
      <div className="card-title">
        Attention rollout{' '}
        <span className="muted small">
          · information flow compounded across layers (Â = ½A + ½I) — how much of each output token
          traces back to each input
        </span>
      </div>
      <div className="rollout-body">
        <canvas ref={ref} />
        <div className="rollout-attrib">
          <div className="muted small">last token “{labels[T - 1]}” traces back to:</div>
          <div className="rollout-bars">
            {lastRow.map((v, j) => (
              <div key={j} className="rollout-bar-col" title={`${labels[j]}: ${(v * 100).toFixed(1)}%`}>
                <div className="rollout-bar-track">
                  <div
                    className="rollout-bar-fill"
                    style={{ height: `${Math.round((v / maxRow) * 100)}%` }}
                  />
                </div>
                <span className={j >= answerStart ? 'tok ans' : 'tok'}>{labels[j]}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
