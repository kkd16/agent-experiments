import { useEffect, useMemo, useRef } from 'react';
import type { GPT } from '../../engine/transformer';
import { numberEmbeddings } from '../../engine/grok';
import { pca2d } from '../../lib/pca';

interface Props {
  gpt: GPT;
  p: number;
  tick: number;
  width: number;
  height: number;
}

// The mechanistic payoff, part 1. Nanda et al. (2023) showed a grokked network represents the
// number n as an *angle* — it drives the embedding of n onto a circle, so that addition becomes
// rotation. We flatten the learned number-embedding table to 2-D with the engine's own PCA
// (`lib/pca`), colour each token by n around a hue wheel, and connect them in numeric order. Before
// grokking the cloud is a shapeless blob; after grokking it snaps to a clean ring — and the *winding*
// of the ring (how many times the path loops as n runs 0…p−1) reveals the dominant key frequency.
export default function EmbeddingCircle({ gpt, p, tick, width, height }: Props) {
  // tick forces recompute as training progresses.
  const proj = useMemo(() => {
    void tick;
    const rows = numberEmbeddings(gpt, p);
    return pca2d(rows, gpt.cfg.dModel, 12345);
  }, [gpt, p, tick]);

  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const W = width;
    const H = height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, W, H);

    const pts = proj.points;
    if (!pts.length) return;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const q of pts) {
      minX = Math.min(minX, q.x);
      maxX = Math.max(maxX, q.x);
      minY = Math.min(minY, q.y);
      maxY = Math.max(maxY, q.y);
    }
    const pad = 22;
    const spanX = maxX - minX || 1;
    const spanY = maxY - minY || 1;
    const span = Math.max(spanX, spanY);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const scale = (Math.min(W, H) - 2 * pad) / span;
    const sx = (x: number) => W / 2 + (x - cx) * scale;
    const sy = (y: number) => H / 2 - (y - cy) * scale;

    // connecting path in numeric order
    ctx.strokeStyle = 'rgba(148,163,184,0.28)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let n = 0; n < pts.length; n++) {
      const x = sx(pts[n].x);
      const y = sy(pts[n].y);
      if (n === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();

    // points, coloured by n
    for (let n = 0; n < pts.length; n++) {
      const hue = (n / pts.length) * 360;
      ctx.fillStyle = `hsl(${hue}, 75%, 60%)`;
      ctx.beginPath();
      ctx.arc(sx(pts[n].x), sy(pts[n].y), pts.length <= 40 ? 6 : 4, 0, Math.PI * 2);
      ctx.fill();
      if (pts.length <= 40) {
        ctx.fillStyle = 'rgba(2,6,23,0.9)';
        ctx.font = '8px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(n), sx(pts[n].x), sy(pts[n].y));
      }
    }
  }, [proj, width, height]);

  return (
    <div className="chart-wrap">
      <canvas ref={canvasRef} width={width} height={height} className="chart" />
      <p className="muted small chart-foot">
        Number embeddings in their top-2 principal components, coloured 0→{p - 1}. A grokked model lays them on a
        <b> circle</b> — n becomes an angle, and addition becomes rotation.
      </p>
    </div>
  );
}
