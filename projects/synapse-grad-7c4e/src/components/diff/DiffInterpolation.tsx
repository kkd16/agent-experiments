import { useMemo } from 'react';
import PixelGrid from '../gen/PixelGrid';

interface Props {
  cls: number;
  seedA: number;
  seedB: number;
  steps: number;
  imgSize: number;
  slerp: (cls: number, seedA: number, seedB: number, steps: number) => Float64Array[];
  tick: number;
}

// A smooth walk through *noise* space: two random seeds are spherically interpolated and each
// blend is decoded by the deterministic DDIM map. Because DDIM is an (almost) invertible ODE
// solver, neighbouring seeds decode to neighbouring glyphs — so the row morphs continuously from
// one digit to another, the diffusion analogue of the VAE's latent interpolation.
export default function DiffInterpolation({ cls, seedA, seedB, steps, imgSize, slerp, tick }: Props) {
  const grids = useMemo(
    () => slerp(cls, seedA, seedB, steps),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cls, seedA, seedB, steps, tick],
  );

  if (grids.length === 0) return <p className="muted small">Train, then morph between two noise seeds.</p>;
  return (
    <div className="interp-strip">
      {grids.map((g, i) => (
        <PixelGrid key={i} pixels={g} size={imgSize} cell={4} className={i === 0 || i === grids.length - 1 ? 'interp-end' : ''} />
      ))}
    </div>
  );
}
