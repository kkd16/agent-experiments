import { useEffect, useRef, useState } from 'react';
import PixelGrid from '../gen/PixelGrid';
import type { TrajFrame } from '../../hooks/useDiffusionTrainer';

interface Props {
  frames: TrajFrame[];
  imgSize: number;
}

// The headline: watch a single glyph emerge from pure Gaussian noise. The big left canvas is the
// live latent x_t as the sampler walks it backwards; the big right canvas is the model's *current
// guess* of the clean image x̂0 (sharp early-on it is mush, then it snaps into a digit). The strip
// underneath is the whole trajectory at a glance, and the scrubber lets you step through it by hand.
export default function ReverseTrajectory({ frames, imgSize }: Props) {
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(true);
  const timer = useRef<number | null>(null);

  // Restart the animation whenever a fresh trajectory arrives.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIdx(0);
    setPlaying(true);
  }, [frames]);

  useEffect(() => {
    if (!playing || frames.length === 0) return;
    timer.current = window.setInterval(() => {
      setIdx((i) => {
        if (i >= frames.length - 1) {
          window.clearInterval(timer.current!);
          return i;
        }
        return i + 1;
      });
    }, 70);
    return () => {
      if (timer.current !== null) window.clearInterval(timer.current);
    };
  }, [playing, frames]);

  if (frames.length === 0) {
    return <p className="muted small">Train a little, then hit <b>Sample</b> to watch a glyph condense out of noise.</p>;
  }

  const cur = frames[Math.min(idx, frames.length - 1)];
  // A compact, evenly-spaced strip across the whole reverse run.
  const stripCount = Math.min(14, frames.length);
  const strip = Array.from({ length: stripCount }, (_, i) =>
    frames[Math.round((i / (stripCount - 1)) * (frames.length - 1))],
  );

  return (
    <div className="traj">
      <div className="traj-big">
        <div className="traj-pane">
          <PixelGrid pixels={cur.xt} size={imgSize} cell={9} />
          <span className="muted small">x<sub>t</sub> · t = {cur.t}</span>
        </div>
        <div className="traj-arrow">→</div>
        <div className="traj-pane">
          <PixelGrid pixels={cur.x0} size={imgSize} cell={9} />
          <span className="muted small">predicted x̂<sub>0</sub></span>
        </div>
      </div>

      <div className="traj-controls">
        <button className="ghost" onClick={() => setPlaying((p) => !p)}>
          {playing && idx < frames.length - 1 ? '❚❚' : '▶'}
        </button>
        <input
          type="range"
          min={0}
          max={frames.length - 1}
          value={idx}
          onChange={(e) => {
            setPlaying(false);
            setIdx(Number(e.target.value));
          }}
        />
        <span className="muted small mono">{idx + 1}/{frames.length}</span>
      </div>

      <div className="traj-strip">
        {strip.map((f, i) => (
          <div key={i} className={`traj-cell ${f.t === 0 ? 'final' : ''}`}>
            <PixelGrid pixels={f.xt} size={imgSize} cell={3} />
          </div>
        ))}
      </div>
    </div>
  );
}
