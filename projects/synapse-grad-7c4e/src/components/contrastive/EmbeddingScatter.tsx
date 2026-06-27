import { useEffect, useRef } from 'react';
import type { ScatterView } from '../../hooks/useContrastiveTrainer';
import { rgbCss } from '../../lib/colors';

interface Props {
  scatter: ScatterView | null;
  labels: string[];
  tick: number;
  size: number;
}

// A 10-way palette (covers both the 4 shapes and the 10 digits).
const PALETTE: [number, number, number][] = [
  [56, 189, 248],
  [244, 114, 182],
  [163, 230, 53],
  [251, 191, 36],
  [167, 139, 250],
  [45, 212, 191],
  [248, 113, 113],
  [129, 140, 248],
  [251, 146, 60],
  [52, 211, 153],
];

// A 2-D PCA of the *representation* (the backbone output, never the projection used by the loss),
// colored by the hidden class label. The punchline of the whole lab: the encoder never saw a
// single label, yet as it trains the classes separate into their own islands here — proof the
// contrastive objective discovered the structure on its own.
export default function EmbeddingScatter({ scatter, labels, tick, size }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !scatter) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, size, size);

    const pts = scatter.points;
    if (!pts.length) return;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of pts) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
    const span = Math.max(maxX - minX, maxY - minY) || 1;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const pad = 16;
    const map = (x: number, y: number): [number, number] => [
      pad + ((x - cx) / span + 0.5) * (size - 2 * pad),
      pad + ((y - cy) / span + 0.5) * (size - 2 * pad),
    ];
    for (let i = 0; i < pts.length; i++) {
      const [x, y] = map(pts[i].x, pts[i].y);
      const c = PALETTE[scatter.labels[i] % PALETTE.length];
      ctx.beginPath();
      ctx.arc(x, y, 3.6, 0, Math.PI * 2);
      ctx.fillStyle = rgbCss(c, 0.85);
      ctx.fill();
    }
    void tick;
  }, [scatter, tick, size]);

  return (
    <div className="scatter">
      <canvas ref={ref} className="scatter-canvas" style={{ width: size, height: size }} />
      <div className="scatter-legend">
        {labels.map((l, i) => (
          <span className="scatter-key" key={l}>
            <span className="dot" style={{ background: rgbCss(PALETTE[i % PALETTE.length]) }} />
            {l}
          </span>
        ))}
      </div>
    </div>
  );
}
