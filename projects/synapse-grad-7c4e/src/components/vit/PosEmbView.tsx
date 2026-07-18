import { useEffect, useRef } from 'react';
import type { ViTHandle } from '../../hooks/useViTTrainer';
import { positionalSimilarity } from '../../engine/vit';
import { diverging } from '../../lib/colors';
import { drawGrid } from '../../lib/raster';

interface Props {
  handle: ViTHandle;
  tick: number;
}

// One P×P similarity tile for patch position `pos`: its cosine similarity to every position.
function SimTile({ row, gridSide, cell }: { row: Float64Array; gridSide: number; cell: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    // similarities are in [-1,1]; map straight through the diverging ramp
    drawGrid(ref.current, row, gridSide, gridSide, cell, (v) => diverging(v));
  }, [row, gridSide, cell]);
  return <canvas ref={ref} className="vit-mini" />;
}

// The learned positional-embedding similarity grid — a P×P arrangement of P×P tiles. In a
// trained ViT each tile lights up around its own location, i.e. the model has recovered the 2-D
// patch layout from data even though nothing in the architecture imposes it.
export default function PosEmbView({ handle, tick }: Props) {
  const model = handle.model;
  if (!model) return <p className="muted small">Train the model to see the positions organise.</p>;
  void tick; // recompute each training tick
  const { sim, numPatches, gridSide } = positionalSimilarity(model);
  const cell = gridSide <= 4 ? 12 : gridSide <= 8 ? 7 : 5;

  const tiles: Float64Array[] = [];
  for (let i = 0; i < numPatches; i++) tiles.push(sim.subarray(i * numPatches, i * numPatches + numPatches));

  return (
    <div className="vit-posemb" style={{ gridTemplateColumns: `repeat(${gridSide}, auto)` }}>
      {tiles.map((row, i) => (
        <SimTile key={i} row={row} gridSide={gridSide} cell={cell} />
      ))}
    </div>
  );
}
