import { useEffect, useMemo, useRef } from 'react';
import type { VisionHandle, Prediction } from '../../hooks/useVisionTrainer';
import { drawGrid, inkColor } from '../../lib/raster';

interface Props {
  handle: VisionHandle;
  tick: number;
  predict: (pixels: Float64Array) => Prediction | null;
  onPick: (idx: number) => void;
  selected: number;
  count?: number;
}

// A small gallery of dataset samples with the network's live prediction overlaid — green
// border when correct, pink when wrong, so you can watch errors disappear as it learns.
export default function ImageSamples({ handle, tick, predict, onPick, selected, count = 24 }: Props) {
  const { data, imgSize, labels } = handle;
  const idxs = useMemo(() => {
    if (!data) return [] as number[];
    const out: number[] = [];
    const stride = Math.max(1, Math.floor(data.n / count));
    for (let i = 0; i < data.n && out.length < count; i += stride) out.push(i);
    return out;
  }, [data, count]);

  if (!data) return null;
  const px = imgSize * imgSize;

  return (
    <div className="img-samples">
      {idxs.map((i) => (
        <Sample
          key={i}
          idx={i}
          pixels={data.X.subarray(i * px, i * px + px)}
          size={imgSize}
          trueLabel={labels[data.y[i]]}
          predict={predict}
          labels={labels}
          tick={tick}
          selected={selected === i}
          onPick={onPick}
        />
      ))}
    </div>
  );
}

function Sample({
  idx,
  pixels,
  size,
  trueLabel,
  labels,
  predict,
  tick,
  selected,
  onPick,
}: {
  idx: number;
  pixels: Float64Array;
  size: number;
  trueLabel: string;
  labels: string[];
  predict: (p: Float64Array) => Prediction | null;
  tick: number;
  selected: boolean;
  onPick: (idx: number) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    drawGrid(ref.current, pixels, size, size, Math.max(2, Math.floor(48 / size)), inkColor);
  }, [pixels, size, tick]);

  const pred = predict(Float64Array.from(pixels));
  const correct = pred ? labels[pred.pred] === trueLabel : true;
  return (
    <button
      className={`img-sample ${selected ? 'sel' : ''} ${correct ? 'right' : 'wrong'}`}
      onClick={() => onPick(idx)}
      title={`true ${trueLabel} · pred ${pred ? labels[pred.pred] : '—'}`}
    >
      <canvas ref={ref} className="img-canvas" />
      <span className="img-tag">{pred ? labels[pred.pred] : '—'}</span>
    </button>
  );
}
