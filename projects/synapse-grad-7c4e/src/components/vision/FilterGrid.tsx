import { useEffect, useRef } from 'react';
import type { VisionHandle } from '../../hooks/useVisionTrainer';
import { drawGrid, signedColor, maxAbs } from '../../lib/raster';

interface Props {
  handle: VisionHandle;
  tick: number;
}

// The first convolutional layer's learned kernels, each a small signed (blue/pink) tile.
// On the digit/shape tasks these grow into oriented edge and stroke detectors.
export default function FilterGrid({ handle, tick }: Props) {
  const { model } = handle;
  if (!model) return null;
  const filters = model.firstFilters();
  return (
    <div className="filter-grid">
      {filters.map((f, i) => (
        <Filter key={i} data={f.data} k={f.k} cin={f.Cin} tick={tick} />
      ))}
    </div>
  );
}

function Filter({ data, k, cin, tick }: { data: Float64Array; k: number; cin: number; tick: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    // For single-channel input each filter is one k×k tile; otherwise show channel 0.
    const tile = cin === 1 ? data : data.subarray(0, k * k);
    drawGrid(ref.current, tile, k, k, Math.max(6, Math.floor(40 / k)), (v) => signedColor(v, maxAbs(tile)));
  }, [data, k, cin, tick]);
  return <canvas ref={ref} className="filter-canvas" />;
}
