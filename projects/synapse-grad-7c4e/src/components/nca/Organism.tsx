import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import {
  NCA,
  makeSeed,
  makeRawScratch,
  renderRGBA,
  renderChannel,
  damage,
  type GridMeta,
  type RawScratch,
} from '../../engine/nca';
import { mulberry32 } from '../../engine/nn';

interface Props {
  model: NCA | null;
  meta: GridMeta; // demo grid
  rebuildKey: number; // bumps when the model / grid is rebuilt → reset the demo
  tick: number; // bumps as training updates weights → keep the readout fresh
}

const DISPLAY = 384; // px of the main canvas

// Paint an RGBA cell buffer (grid resolution) into a canvas, nearest-neighbour upscaled.
function blit(ctx: CanvasRenderingContext2D, rgba: Uint8ClampedArray, H: number, W: number, size: number): void {
  const off = document.createElement('canvas');
  off.width = W;
  off.height = H;
  const octx = off.getContext('2d')!;
  const img = octx.createImageData(W, H);
  img.data.set(rgba);
  octx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, size, size);
  ctx.drawImage(off, 0, 0, size, size);
}

// The headline view: an organism grown live from a single seed cell by the trained CA rule.
// Buttery because it runs the engine's no-tape `rawStep` path. Click/drag to wound it, then
// watch the rule regrow the missing tissue.
export default function Organism({ model, meta, rebuildKey, tick }: Props) {
  const mainRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<Float64Array>(new Float64Array());
  const scratchRef = useRef<RawScratch | null>(null);
  const rngRef = useRef<() => number>(mulberry32(1));
  const stepRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const playingRef = useRef(false);
  const speedRef = useRef(2);

  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(2);
  const [showChannels, setShowChannels] = useState(false);
  const [stepDisplay, setStepDisplay] = useState(0);
  const [brush, setBrush] = useState(0.18); // damage radius as a fraction of grid

  useEffect(() => {
    speedRef.current = speed;
  }, [speed]);

  const cells = meta.H * meta.W;

  const renderMain = useCallback(() => {
    const canvas = mainRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    blit(ctx, renderRGBA(stateRef.current, meta), meta.H, meta.W, DISPLAY);
  }, [meta]);

  const resetSeed = useCallback(() => {
    stateRef.current = makeSeed(meta);
    stepRef.current = 0;
    setStepDisplay(0);
    renderMain();
  }, [meta, renderMain]);

  // (re)initialise when the model / grid changes
  useEffect(() => {
    if (!model) return;
    scratchRef.current = makeRawScratch(meta, model.cfg.hidden);
    rngRef.current = mulberry32(0xc0ffee);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    resetSeed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rebuildKey, meta.H, meta.W, meta.C]);

  // keep the playing flag in a ref for the rAF closure
  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);

  // the animation loop
  useEffect(() => {
    let alive = true;
    const frame = () => {
      if (!alive) return;
      const m = model;
      const scratch = scratchRef.current;
      if (playingRef.current && m && scratch) {
        const out = new Float64Array(stateRef.current.length);
        const n = speedRef.current;
        for (let s = 0; s < n; s++) {
          m.rawStep(stateRef.current, out, meta, rngRef.current, scratch);
          stateRef.current = out.slice(); // commit the new state for the next inner step / render
        }
        stepRef.current += n;
        renderMain();
        if (stepRef.current % 8 < n) setStepDisplay(stepRef.current);
      }
      rafRef.current = requestAnimationFrame(frame);
    };
    rafRef.current = requestAnimationFrame(frame);
    return () => {
      alive = false;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [model, meta, renderMain]);

  // re-render when training updates the weights (so a paused demo still reflects progress)
  useEffect(() => {
    renderMain();
  }, [tick, renderMain]);

  const damageAt = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = mainRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const cx = ((clientX - rect.left) / rect.width) * meta.W;
      const cy = ((clientY - rect.top) / rect.height) * meta.H;
      damage(stateRef.current, meta, cx, cy, Math.max(1.5, brush * meta.W));
      renderMain();
    },
    [meta, brush, renderMain],
  );

  const draggingRef = useRef(false);
  const onPointerDown = (e: ReactPointerEvent) => {
    draggingRef.current = true;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    damageAt(e.clientX, e.clientY);
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    if (draggingRef.current) damageAt(e.clientX, e.clientY);
  };
  const onPointerUp = () => {
    draggingRef.current = false;
  };

  const randomDamage = () => {
    const cx = (0.3 + 0.4 * rngRef.current()) * meta.W;
    const cy = (0.3 + 0.4 * rngRef.current()) * meta.H;
    damage(stateRef.current, meta, cx, cy, brush * meta.W * 1.3);
    renderMain();
  };

  const channelList = model ? [3, ...Array.from({ length: Math.min(7, meta.C - 4) }, (_, i) => 4 + i)] : [];

  return (
    <div className="organism">
      <div className="organism-main">
        <canvas
          ref={mainRef}
          width={DISPLAY}
          height={DISPLAY}
          className="organism-canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
        />
        <div className="organism-hint muted small">drag on the organism to wound it · it regrows if trained to</div>
      </div>

      <div className="organism-controls">
        <button className="primary" onClick={() => setPlaying((p) => !p)}>
          {playing ? '❚❚ Pause' : '▶ Grow'}
        </button>
        <button className="ghost" onClick={resetSeed}>
          ⟲ Seed
        </button>
        <button className="ghost" onClick={randomDamage}>
          🩹 Damage
        </button>
        <span className="muted small mono">t = {stepDisplay}</span>
      </div>

      <div className="organism-sliders">
        <label className="field tight">
          <span>Speed · {speed}×</span>
          <input type="range" min={1} max={8} step={1} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} />
        </label>
        <label className="field tight">
          <span>Brush · {(brush * 100).toFixed(0)}%</span>
          <input type="range" min={0.06} max={0.4} step={0.02} value={brush} onChange={(e) => setBrush(Number(e.target.value))} />
        </label>
        <label className="toggle">
          <input type="checkbox" checked={showChannels} onChange={(e) => setShowChannels(e.target.checked)} /> hidden channels
        </label>
      </div>

      {showChannels && (
        <div className="channel-strip">
          {channelList.map((ch) => (
            <ChannelView key={ch} state={stateRef} meta={meta} channel={ch} tick={stepDisplay + tick} />
          ))}
        </div>
      )}
      <div className="muted small">
        grid {meta.W}×{meta.H} · {meta.C} channels ({cells} cells) — the rule is shared by every cell
      </div>
    </div>
  );
}

const CHPX = 56;
function ChannelView({
  state,
  meta,
  channel,
  tick,
}: {
  state: RefObject<Float64Array>;
  meta: GridMeta;
  channel: number;
  tick: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    blit(ctx, renderChannel(state.current, meta, channel), meta.H, meta.W, CHPX);
  });
  void tick;
  return (
    <div className="channel-view">
      <canvas ref={ref} width={CHPX} height={CHPX} />
      <span className="muted small">{channel === 3 ? 'α' : `h${channel - 4}`}</span>
    </div>
  );
}
