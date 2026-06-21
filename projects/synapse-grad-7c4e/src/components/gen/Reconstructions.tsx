import { useMemo } from 'react';
import PixelGrid from './PixelGrid';
import type { GenHandle } from '../../hooks/useGenTrainer';

interface Props {
  handle: GenHandle;
  tick: number;
  indices: number[];
  reconstructionsFor: (indices: number[]) => { input: Float64Array; recon: Float64Array }[];
}

// Input glyphs (top) above the VAE's own reconstruction of each (bottom). The encoder squeezes
// the image down to a handful of latent numbers and the decoder rebuilds it — watch the bottom
// row sharpen toward the top one as training proceeds.
export default function Reconstructions({ handle, tick, indices, reconstructionsFor }: Props) {
  // eslint-disable-next-line react-hooks/exhaustive-deps -- tick re-decodes as weights change
  const pairs = useMemo(() => reconstructionsFor(indices), [reconstructionsFor, indices, tick]);
  if (!handle.data || pairs.length === 0) return null;
  const cell = Math.max(2, Math.floor(48 / handle.imgSize));
  return (
    <div className="recon-grid">
      {pairs.map((p, i) => (
        <div className="recon-pair" key={i}>
          <PixelGrid pixels={p.input} size={handle.imgSize} cell={cell} title="input" />
          <PixelGrid pixels={p.recon} size={handle.imgSize} cell={cell} className="recon-out" title="reconstruction" />
        </div>
      ))}
    </div>
  );
}
