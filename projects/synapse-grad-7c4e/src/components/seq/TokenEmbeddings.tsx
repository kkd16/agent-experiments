import { useEffect, useRef } from 'react';
import type { GPT } from '../../engine/transformer';
import { VOCAB, tokenLabel } from '../../engine/seqtasks';

interface Props {
  gpt: GPT;
  tick: number;
}

// Top-2 principal directions of a small row matrix via power iteration with deflation.
function pca2(rows: Float64Array, n: number, d: number): { x: number[]; y: number[] } {
  const mean = new Float64Array(d);
  for (let i = 0; i < n; i++) for (let j = 0; j < d; j++) mean[j] += rows[i * d + j];
  for (let j = 0; j < d; j++) mean[j] /= n;
  const X = new Float64Array(n * d);
  for (let i = 0; i < n; i++) for (let j = 0; j < d; j++) X[i * d + j] = rows[i * d + j] - mean[j];

  // Covariance C = X^T X (d×d).
  const C = new Float64Array(d * d);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < d; a++) {
      const xa = X[i * d + a];
      if (xa === 0) continue;
      for (let b = 0; b < d; b++) C[a * d + b] += xa * X[i * d + b];
    }
  }
  const powerIter = (M: Float64Array): Float64Array => {
    let v = new Float64Array(d);
    for (let j = 0; j < d; j++) v[j] = Math.sin(j * 1.7 + 0.5);
    for (let it = 0; it < 40; it++) {
      const w = new Float64Array(d);
      for (let a = 0; a < d; a++) {
        let s = 0;
        for (let b = 0; b < d; b++) s += M[a * d + b] * v[b];
        w[a] = s;
      }
      let norm = 0;
      for (let j = 0; j < d; j++) norm += w[j] * w[j];
      norm = Math.sqrt(norm) || 1;
      for (let j = 0; j < d; j++) w[j] /= norm;
      v = w;
    }
    return v;
  };
  const v1 = powerIter(C);
  // Deflate: C' = C - λ v1 v1^T.
  let lambda = 0;
  const Cv = new Float64Array(d);
  for (let a = 0; a < d; a++) {
    let s = 0;
    for (let b = 0; b < d; b++) s += C[a * d + b] * v1[b];
    Cv[a] = s;
    lambda += v1[a] * s;
  }
  const C2 = C.slice();
  for (let a = 0; a < d; a++) for (let b = 0; b < d; b++) C2[a * d + b] -= lambda * v1[a] * v1[b];
  const v2 = powerIter(C2);

  const x: number[] = [];
  const y: number[] = [];
  for (let i = 0; i < n; i++) {
    let px = 0;
    let py = 0;
    for (let j = 0; j < d; j++) {
      px += X[i * d + j] * v1[j];
      py += X[i * d + j] * v2[j];
    }
    x.push(px);
    y.push(py);
  }
  return { x, y };
}

export default function TokenEmbeddings({ gpt, tick }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const d = gpt.cfg.dModel;
    const { x, y } = pca2(gpt.tokEmb.data, VOCAB, d);

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = 232;
    const H = 180;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, W, H);

    const pad = 18;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < VOCAB; i++) {
      minX = Math.min(minX, x[i]);
      maxX = Math.max(maxX, x[i]);
      minY = Math.min(minY, y[i]);
      maxY = Math.max(maxY, y[i]);
    }
    const sx = (v: number) => pad + ((v - minX) / (maxX - minX || 1)) * (W - 2 * pad);
    const sy = (v: number) => H - pad - ((v - minY) / (maxY - minY || 1)) * (H - 2 * pad);

    ctx.font = '12px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < VOCAB; i++) {
      const isDigit = i < 10;
      ctx.fillStyle = isDigit ? 'rgba(56,189,248,0.18)' : 'rgba(167,139,250,0.22)';
      ctx.beginPath();
      ctx.arc(sx(x[i]), sy(y[i]), 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = isDigit ? '#7dd3fc' : '#c4b5fd';
      ctx.fillText(tokenLabel(i), sx(x[i]), sy(y[i]));
    }
  }, [gpt, tick]);

  return (
    <div className="card">
      <div className="card-title">
        Token embeddings <span className="muted small">· learned vectors, PCA to 2-D</span>
      </div>
      <canvas ref={ref} className="emb-canvas" />
    </div>
  );
}
