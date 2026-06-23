import { useEffect, useRef } from 'react';
import type { BoundaryView } from '../../hooks/useKANTrainer';
import { CLASS_COLORS, mix } from '../../lib/colors';

interface Props {
  view: BoundaryView | null;
  tick: number;
  size: number;
}

const BG: [number, number, number] = [15, 23, 42];

// Decision boundary of the KAN classifier: the argmax-class probability field behind the data
// points (true class = fill color). Identical in spirit to the playground's boundary, but every
// nonlinearity here is a learned spline rather than a fixed ReLU/tanh.
export default function KANBoundary({ view, tick, size }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !view) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const R = view.res;
    const C = view.classes;

    const img = ctx.createImageData(R, R);
    for (let i = 0; i < R * R; i++) {
      const best = view.field[i];
      const conf = (view.conf[i] - 1 / C) / (1 - 1 / C);
      const col = mix(BG, CLASS_COLORS[best % CLASS_COLORS.length], 0.18 + 0.6 * Math.max(0, conf));
      const o = i * 4;
      img.data[o] = col[0];
      img.data[o + 1] = col[1];
      img.data[o + 2] = col[2];
      img.data[o + 3] = 255;
    }
    const off = document.createElement('canvas');
    off.width = R;
    off.height = R;
    off.getContext('2d')!.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(off, 0, 0, size, size);

    const D = view.domain;
    const toPx = (v: number) => ((v + D) / (2 * D)) * size;
    for (let i = 0; i < view.n; i++) {
      const px = toPx(view.X[i * 2]);
      const py = size - toPx(view.X[i * 2 + 1]);
      const col = CLASS_COLORS[view.y[i] % CLASS_COLORS.length];
      const isVal = view.split[i] === 1;
      ctx.beginPath();
      ctx.arc(px, py, isVal ? 3.2 : 2.6, 0, Math.PI * 2);
      ctx.fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`;
      ctx.fill();
      ctx.lineWidth = isVal ? 1.6 : 1;
      ctx.strokeStyle = isVal ? '#f8fafc' : 'rgba(2,6,23,0.85)';
      ctx.stroke();
    }
  }, [view, tick, size]);

  return <canvas ref={ref} width={size} height={size} className="board" style={{ cursor: 'default' }} />;
}
