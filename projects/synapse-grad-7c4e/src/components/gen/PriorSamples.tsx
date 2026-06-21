import { useMemo } from 'react';
import PixelGrid from './PixelGrid';
import type { GenHandle } from '../../hooks/useGenTrainer';

interface Props {
  handle: GenHandle;
  tick: number;
  seed: number;
  count: number;
  priorSamples: (k: number, seed: number) => Float64Array[];
}

// Pure generation: draw z ~ N(0, I) straight from the prior and decode. These glyphs were never
// in any dataset — the network is dreaming them up from noise. Hit "new sample" for a fresh draw.
export default function PriorSamples({ handle, tick, seed, count, priorSamples }: Props) {
  // eslint-disable-next-line react-hooks/exhaustive-deps -- tick re-decodes as weights change
  const grids = useMemo(() => priorSamples(count, seed), [priorSamples, count, seed, tick]);
  if (!handle.data || grids.length === 0) return null;
  const cell = Math.max(2, Math.floor(46 / handle.imgSize));
  return (
    <div className="prior-grid">
      {grids.map((g, i) => (
        <PixelGrid key={i} pixels={g} size={handle.imgSize} cell={cell} className="prior-cell" />
      ))}
    </div>
  );
}
