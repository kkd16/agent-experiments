import { useEffect, useRef } from 'react';
import type { PoolThumb } from '../../hooks/useNCATrainer';
import type { GridMeta } from '../../engine/nca';

interface Props {
  thumbs: PoolThumb[];
  meta: GridMeta; // train grid (thumbs are rendered at this resolution)
  tick: number;
}

const PX = 44;

function PoolCell({ thumb, meta }: { thumb: PoolThumb; meta: GridMeta }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { H, W } = meta;
    const img = ctx.createImageData(W, H);
    img.data.set(thumb.rgba);
    const off = document.createElement('canvas');
    off.width = W;
    off.height = H;
    off.getContext('2d')!.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, PX, PX);
    ctx.drawImage(off, 0, 0, PX, PX);
  });
  return <canvas ref={ref} width={PX} height={PX} className="pool-cell" title={`MSE ${thumb.loss.toExponential(2)}`} />;
}

// A live window into the sample pool — the population of past final states the Persist /
// Regenerate recipes train against. You watch seeds (blank) grow into organisms here.
export default function PoolStrip({ thumbs, meta, tick }: Props) {
  void tick;
  if (!thumbs.length) return <div className="muted small">— pool is used by Persist / Regenerate modes —</div>;
  return (
    <div className="pool-strip">
      {thumbs.map((t, i) => (
        <PoolCell key={i} thumb={t} meta={meta} />
      ))}
    </div>
  );
}
