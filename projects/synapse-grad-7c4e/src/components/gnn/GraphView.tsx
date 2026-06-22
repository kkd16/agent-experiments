import { useEffect, useRef, useState } from 'react';
import type { NodeView } from '../../hooks/useGNNTrainer';
import { GRAPH_CLASS_COLORS, rgbCss } from '../../lib/colors';

const RANGE = 2.15;

interface Props {
  view: NodeView | null;
  tick: number;
  size: number;
  showAttention: boolean;
}

function toPx(v: number, size: number): number {
  return ((v / RANGE + 1) / 2) * size;
}

// The headline: the graph itself. Every node is filled with the class the network currently
// *predicts* and ringed with its *true* class — so a node whose fill and ring disagree is a
// live mistake, and you watch those mismatches heal as message passing sharpens the labels.
// Labeled (training) nodes wear a white halo; for GAT the edges glow with attention weight.
export default function GraphView({ view, tick, size, showAttention }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<number | null>(null);

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

    const { positions, edges, preds, labels, split, confidence, numClasses, attention, n } = view;
    const col = (c: number) => GRAPH_CLASS_COLORS[c % GRAPH_CLASS_COLORS.length];

    // adjacency for hover highlight
    const neighbors = new Set<number>();
    if (hover !== null) {
      for (const [u, v] of edges) {
        if (u === hover) neighbors.add(v);
        if (v === hover) neighbors.add(u);
      }
    }

    // edges
    const useAtt = showAttention && attention;
    for (const [u, v] of edges) {
      const x1 = toPx(positions[u * 2], size);
      const y1 = toPx(positions[u * 2 + 1], size);
      const x2 = toPx(positions[v * 2], size);
      const y2 = toPx(positions[v * 2 + 1], size);
      const isHi = hover !== null && (u === hover || v === hover);
      let alpha = isHi ? 0.85 : hover !== null ? 0.05 : 0.16;
      let width = 1;
      if (useAtt) {
        const a = Math.max(attention[u * n + v], attention[v * n + u]);
        alpha = isHi ? 0.95 : hover !== null ? 0.06 : 0.1 + Math.min(0.85, a * 2.2);
        width = 0.6 + Math.min(3.2, a * 7);
      }
      ctx.strokeStyle = isHi ? `rgba(226,232,240,${alpha})` : `rgba(148,163,184,${alpha})`;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }

    // nodes
    const baseR = Math.max(3.5, Math.min(8, 360 / n));
    for (let i = 0; i < n; i++) {
      const x = toPx(positions[i * 2], size);
      const y = toPx(positions[i * 2 + 1], size);
      const dim = hover !== null && i !== hover && !neighbors.has(hover);
      const r = baseR * (hover === i ? 1.5 : 1) + (split[i] === 0 ? 1.2 : 0);
      const pc = col(preds[i]);
      const tc = col(labels[i]);
      // halo for labeled training nodes
      if (split[i] === 0) {
        ctx.beginPath();
        ctx.arc(x, y, r + 3.2, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(248,250,252,${dim ? 0.12 : 0.32})`;
        ctx.fill();
      }
      // fill = predicted class, opacity scaled by confidence
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      const conf = 0.45 + 0.55 * confidence[i];
      ctx.fillStyle = rgbCss(pc, dim ? 0.18 : conf);
      ctx.fill();
      // ring = true class (numClasses>1 makes mistakes visible as a colour mismatch)
      ctx.lineWidth = preds[i] === labels[i] ? 1.4 : 2.4;
      ctx.strokeStyle = rgbCss(tc, dim ? 0.25 : 1);
      ctx.stroke();
    }

    void numClasses;
    void tick;
  }, [view, tick, size, showAttention, hover]);

  const onMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!view) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * size;
    const my = ((e.clientY - rect.top) / rect.height) * size;
    let best = -1;
    let bestD = 14 * 14;
    for (let i = 0; i < view.n; i++) {
      const x = toPx(view.positions[i * 2], size);
      const y = toPx(view.positions[i * 2 + 1], size);
      const d = (x - mx) ** 2 + (y - my) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    setHover(best >= 0 ? best : null);
  };

  return (
    <canvas
      ref={ref}
      style={{ width: size, height: size, borderRadius: 12, cursor: 'crosshair' }}
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
    />
  );
}
