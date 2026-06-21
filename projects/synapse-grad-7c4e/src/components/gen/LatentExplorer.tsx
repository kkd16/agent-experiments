import { useMemo, useState } from 'react';
import PixelGrid from './PixelGrid';
import type { GenHandle } from '../../hooks/useGenTrainer';

interface Props {
  handle: GenHandle;
  tick: number;
  decodePlanePoint: (u: number, v: number) => Float64Array | null;
}

// Drive the decoder by hand: two sliders move a point along the manifold's PC-1 / PC-2 axes
// (in σ units) and the glyph re-decodes live. The most direct way to *feel* the latent space —
// nudge a knob and watch the digit bend.
export default function LatentExplorer({ handle, tick, decodePlanePoint }: Props) {
  const [u, setU] = useState(0);
  const [v, setV] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- tick re-decodes as weights change
  const grid = useMemo(() => decodePlanePoint(u, v), [decodePlanePoint, u, v, tick]);
  if (!handle.data) return null;
  const cell = Math.max(4, Math.floor(120 / handle.imgSize));
  return (
    <div className="explorer">
      {grid ? <PixelGrid pixels={grid} size={handle.imgSize} cell={cell} className="explorer-canvas" /> : null}
      <label className="field">
        <span>PC&nbsp;1 · {u.toFixed(2)}σ</span>
        <input type="range" min={-3} max={3} step={0.05} value={u} onChange={(e) => setU(Number(e.target.value))} />
      </label>
      <label className="field">
        <span>PC&nbsp;2 · {v.toFixed(2)}σ</span>
        <input type="range" min={-3} max={3} step={0.05} value={v} onChange={(e) => setV(Number(e.target.value))} />
      </label>
    </div>
  );
}
