import { useEffect, useRef } from 'react';
import type { SimView } from '../../hooks/useContrastiveTrainer';

interface Props {
  sim: SimView | null;
  tick: number;
  size: number;
}

// Warm ramp for a cosine similarity in [-1, 1]: deep blue (dissimilar) → near-black (orthogonal)
// → amber/white (aligned).
function simColor(v: number): [number, number, number] {
  const t = Math.max(-1, Math.min(1, v));
  if (t >= 0) {
    // 0 → dark, 1 → amber-white
    return [Math.round(11 + t * 240), Math.round(17 + t * 200), Math.round(28 + t * 120)];
  }
  // 0 → dark, -1 → blue
  const a = -t;
  return [Math.round(11 + a * 20), Math.round(17 + a * 70), Math.round(28 + a * 190)];
}

// The 2N×2N cosine-similarity matrix of one contrastive batch. NT-Xent's whole job is to push the
// off-diagonal *positive* cells (boxed) toward bright and every other off-diagonal cell toward
// dark — a softmax classification with one correct neighbour per row. Early on the matrix is mush;
// as it trains the boxed cells light up.
export default function SimilarityMatrix({ sim, tick, size }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !sim) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const m = sim.m;
    const cell = Math.max(6, Math.floor(size / m));
    const W = cell * m;
    canvas.width = W;
    canvas.height = W;
    ctx.clearRect(0, 0, W, W);
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < m; j++) {
        if (i === j) {
          ctx.fillStyle = 'rgb(30,41,59)'; // self-similarity is masked out of the loss
        } else {
          const c = simColor(sim.mat[i * m + j]);
          ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
        }
        ctx.fillRect(j * cell, i * cell, cell, cell);
      }
    }
    // box each row's positive cell
    ctx.strokeStyle = 'rgba(110,231,183,0.95)';
    ctx.lineWidth = 1.5;
    for (let i = 0; i < m; i++) {
      const j = sim.posIdx[i];
      ctx.strokeRect(j * cell + 0.75, i * cell + 0.75, cell - 1.5, cell - 1.5);
    }
    void tick;
  }, [sim, tick, size]);

  return (
    <div className="simmat">
      <canvas ref={ref} className="simmat-canvas" />
      <div className="simmat-legend muted small">
        <span className="sim-key">
          <span className="sim-swatch pos" /> positive pair (target)
        </span>
        <span className="sim-key">
          <span className="sim-swatch hi" /> high cos · <span className="sim-swatch lo" /> low cos
        </span>
      </div>
    </div>
  );
}
