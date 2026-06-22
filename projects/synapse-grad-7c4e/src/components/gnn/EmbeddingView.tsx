import { useEffect, useRef } from 'react';
import type { NodeView } from '../../hooks/useGNNTrainer';
import { GRAPH_CLASS_COLORS, rgbCss } from '../../lib/colors';

interface Props {
  view: NodeView | null;
  tick: number;
  size: number;
}

// A 2-D PCA of the penultimate-layer node embeddings. As the network learns, nodes of the same
// class are pulled together and different classes pushed apart — you watch the representation
// linearise the problem the final layer then trivially separates. Fill = predicted class, ring
// = true class (same trick as the graph view: a mismatch is a mistake).
export default function EmbeddingView({ view, tick, size }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !view) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, size, size);

    const pts = view.embed2d;
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
    const pad = 18;
    const map = (x: number, y: number): [number, number] => [
      pad + ((x - cx) / span + 0.5) * (size - 2 * pad),
      pad + ((y - cy) / span + 0.5) * (size - 2 * pad),
    ];
    const col = (c: number) => GRAPH_CLASS_COLORS[c % GRAPH_CLASS_COLORS.length];

    for (let i = 0; i < pts.length; i++) {
      const [x, y] = map(pts[i].x, pts[i].y);
      const r = view.split[i] === 0 ? 5 : 3.4;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = rgbCss(col(view.preds[i]), 0.9);
      ctx.fill();
      ctx.lineWidth = view.preds[i] === view.labels[i] ? 1 : 2;
      ctx.strokeStyle = rgbCss(col(view.labels[i]), 1);
      ctx.stroke();
    }
    void tick;
  }, [view, tick, size]);

  return <canvas ref={ref} style={{ width: size, height: size, borderRadius: 10 }} />;
}
