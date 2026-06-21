import { useMemo } from 'react';
import PixelGrid from './PixelGrid';
import type { GenHandle } from '../../hooks/useGenTrainer';

interface Props {
  handle: GenHandle;
  tick: number;
  a: number;
  b: number;
  steps: number;
  interpolate: (a: number, b: number, steps: number) => { input: Float64Array; grids: Float64Array[]; inputB: Float64Array } | null;
}

// Walk a straight line in latent space from sample A's code to sample B's, decoding each step.
// A well-trained VAE has a *smooth* latent space, so the glyph morphs continuously (e.g. a 3
// flows into an 8) rather than cutting between them — visual proof the latent code is meaningful.
export default function Interpolation({ handle, tick, a, b, steps, interpolate }: Props) {
  // tick forces a recompute: the model mutates in place during training, so its identity
  // (and the memoized decode functions') is stable while the weights change underneath.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const res = useMemo(() => interpolate(a, b, steps), [interpolate, a, b, steps, tick]);
  if (!handle.data || !res) return null;
  const cell = Math.max(2, Math.floor(44 / handle.imgSize));
  return (
    <div className="interp">
      <div className="interp-end">
        <PixelGrid pixels={res.input} size={handle.imgSize} cell={cell} title="A" />
        <span className="muted small">A</span>
      </div>
      <span className="interp-arrow">→</span>
      <div className="interp-strip">
        {res.grids.map((g, i) => (
          <PixelGrid key={i} pixels={g} size={handle.imgSize} cell={cell} className="interp-cell" />
        ))}
      </div>
      <span className="interp-arrow">→</span>
      <div className="interp-end">
        <PixelGrid pixels={res.inputB} size={handle.imgSize} cell={cell} title="B" />
        <span className="muted small">B</span>
      </div>
    </div>
  );
}
