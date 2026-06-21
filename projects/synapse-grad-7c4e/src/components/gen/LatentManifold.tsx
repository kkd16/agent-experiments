import { useMemo } from 'react';
import PixelGrid from './PixelGrid';

interface Props {
  imgSize: number;
  n: number;
  span: number;
  tick: number;
  decodeManifold: (n: number, span: number) => { grids: Float64Array[]; n: number } | null;
}

// The headline: decode an n×n grid sweeping the 2-D latent plane (the top-2 PCA axes of the
// encoded means) into a wall of freshly-synthesised glyphs. Early in training it's a smear;
// as the VAE organises its latent space, recognisable forms emerge and morph smoothly across
// the plane — the classic "latent manifold" picture, generated live, in the browser, from a
// network trained with hand-derived gradients.
export default function LatentManifold({ imgSize, n, span, tick, decodeManifold }: Props) {
  // eslint-disable-next-line react-hooks/exhaustive-deps -- tick re-decodes as weights change
  const res = useMemo(() => decodeManifold(n, span), [decodeManifold, n, span, tick]);
  if (!res) return <p className="muted small">Encoding latent space…</p>;
  const cell = Math.max(2, Math.floor(56 / imgSize));
  return (
    <div className="manifold">
      <div className="manifold-grid" style={{ gridTemplateColumns: `repeat(${res.n}, 1fr)` }}>
        {res.grids.map((g, i) => (
          <PixelGrid key={i} pixels={g} size={imgSize} cell={cell} className="manifold-cell" />
        ))}
      </div>
      <div className="manifold-axes">
        <span>← PC&nbsp;1 →</span>
        <span className="v">← PC&nbsp;2 →</span>
      </div>
    </div>
  );
}
