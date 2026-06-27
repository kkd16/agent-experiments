import { useEffect, useRef } from 'react';
import type { AugView } from '../../hooks/useContrastiveTrainer';
import { drawGrid, inkColor } from '../../lib/raster';

interface Props {
  aug: AugView | null;
  size: number;
  label?: string;
}

function Glyph({ pixels, size, cell }: { pixels: Float64Array; size: number; cell: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    drawGrid(ref.current, pixels, size, size, cell, inkColor);
  }, [pixels, size, cell]);
  return <canvas ref={ref} className="aug-canvas" />;
}

// The augmentation pipeline made visible: one anchor glyph and a strip of the random crops,
// rotations, intensity jitters, noise and cutouts the contrastive loss treats as "the same
// thing". Two of these views are a positive pair; everything else in the batch is a negative.
export default function AugmentationView({ aug, size, label }: Props) {
  if (!aug) return <div className="muted small">—</div>;
  const cell = Math.max(3, Math.floor(72 / size));
  const cellSmall = Math.max(2, Math.floor(56 / size));
  return (
    <div className="aug-row">
      <div className="aug-anchor">
        <Glyph pixels={aug.anchor} size={size} cell={cell} />
        <span className="muted small">anchor{label ? ` · ${label}` : ''}</span>
      </div>
      <div className="aug-arrow">→</div>
      <div className="aug-views">
        {aug.views.map((v, i) => (
          <div className="aug-view" key={i}>
            <Glyph pixels={v} size={size} cell={cellSmall} />
          </div>
        ))}
      </div>
    </div>
  );
}
