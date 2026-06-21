import { useEffect, useRef } from 'react';
import type { VisionHandle } from '../../hooks/useVisionTrainer';
import type { FeatureStack } from '../../engine/vision-nn';
import { drawGrid, signedColor, inkColor, maxAbs } from '../../lib/raster';

interface Props {
  handle: VisionHandle;
  tick: number;
  sampleIdx: number;
  featureMapsFor: (idx: number) => { stacks: FeatureStack[]; pred: { probs: Float64Array; pred: number } | null } | null;
}

// The activations a chosen sample produces inside the network: the input, then every conv
// block's post-activation feature maps. Watching these sharpen during training shows the
// CNN learning to light up on the parts of the glyph that matter.
export default function FeatureMaps({ handle, tick, sampleIdx, featureMapsFor }: Props) {
  const { data, imgSize, labels } = handle;
  const res = featureMapsFor(sampleIdx);
  if (!data || !res) return null;
  const px = imgSize * imgSize;
  const input = data.X.subarray(sampleIdx * px, sampleIdx * px + px);

  return (
    <div className="feat-wrap">
      <div className="feat-row">
        <span className="feat-label">input</span>
        <InputTile pixels={input} size={imgSize} tick={tick} />
        <span className="feat-pred">
          true <b>{labels[data.y[sampleIdx]]}</b> · pred{' '}
          <b className={res.pred && labels[res.pred.pred] === labels[data.y[sampleIdx]] ? 'ok' : 'bad'}>
            {res.pred ? labels[res.pred.pred] : '—'}
          </b>
        </span>
      </div>
      {res.stacks.map((stack, si) => (
        <div className="feat-row" key={si}>
          <span className="feat-label">{stack.label}</span>
          <div className="feat-maps">
            {Array.from({ length: stack.channels }, (_, c) => (
              <MapTile key={c} stack={stack} channel={c} tick={tick} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function InputTile({ pixels, size, tick }: { pixels: Float64Array; size: number; tick: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    drawGrid(ref.current, pixels, size, size, Math.max(3, Math.floor(64 / size)), inkColor);
  }, [pixels, size, tick]);
  return <canvas ref={ref} className="feat-canvas input" />;
}

function MapTile({ stack, channel, tick }: { stack: FeatureStack; channel: number; tick: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const { H, W, data } = stack;
    const start = channel * H * W;
    const slice = data.subarray(start, start + H * W);
    drawGrid(ref.current, slice, W, H, Math.max(3, Math.floor(48 / Math.max(H, W))), (v) => signedColor(v, maxAbs(slice)));
  }, [stack, channel, tick]);
  return <canvas ref={ref} className="feat-canvas" />;
}
