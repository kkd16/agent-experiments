import { useEffect, useRef, useState } from 'react';
import { useNCATrainer, type NCAConfigUI } from '../../hooks/useNCATrainer';
import { NCA_TARGETS } from '../../engine/nca';
import type { GridMeta } from '../../engine/nca';
import type { GradCheckResult } from '../../engine/gradcheck';
import {
  listSlots,
  loadSlot,
  saveSlot,
  deleteSlot,
  makeState,
  shareUrl,
  writeHashState,
  readHashState,
  NCA_SLOT_PREFIX,
} from '../../engine/serialize';
import NCAPanel from './NCAPanel';
import Organism from './Organism';
import PoolStrip from './PoolStrip';
import NCAChart from './NCAChart';

const HASH_KEY = 'm';

const NCA_INITIAL: NCAConfigUI = {
  target: 'heart',
  grid: 20,
  channels: 12,
  hidden: 64,
  fireRate: 0.5,
  mode: 'regenerate',
  poolSize: 256,
  batchSize: 4,
  stepsMin: 20,
  stepsMax: 28,
  optimizer: 'adam',
  lr: 0.002,
  clipNorm: 1,
  damageRadius: 0.18,
  seed: 1,
  demoScale: 2,
  loadId: 0,
};

function sanitize(raw: unknown): NCAConfigUI {
  const c = (raw ?? {}) as Partial<NCAConfigUI>;
  const target = NCA_TARGETS.some((t) => t.id === c.target) ? (c.target as string) : NCA_INITIAL.target;
  const grid = [16, 20, 24, 28, 32].includes(Number(c.grid)) ? Number(c.grid) : NCA_INITIAL.grid;
  const channels = [8, 12, 16].includes(Number(c.channels)) ? Number(c.channels) : NCA_INITIAL.channels;
  const mode = ['grow', 'persist', 'regenerate'].includes(c.mode as string) ? (c.mode as NCAConfigUI['mode']) : NCA_INITIAL.mode;
  return {
    ...NCA_INITIAL,
    ...c,
    target,
    grid,
    channels,
    mode,
    demoScale: [1, 2].includes(Number(c.demoScale)) ? Number(c.demoScale) : NCA_INITIAL.demoScale,
  };
}

// A small static reference render of the target glyph.
function TargetView({ target, meta }: { target: Float64Array | null; meta: GridMeta }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const SIZE = 128;
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !target) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { H, W } = meta;
    const img = ctx.createImageData(W, H);
    const bg = [10, 13, 20];
    for (let p = 0; p < H * W; p++) {
      const a = Math.min(1, Math.max(0, target[p * 4 + 3]));
      img.data[p * 4] = Math.min(1, target[p * 4]) * 255 + (1 - a) * bg[0];
      img.data[p * 4 + 1] = Math.min(1, target[p * 4 + 1]) * 255 + (1 - a) * bg[1];
      img.data[p * 4 + 2] = Math.min(1, target[p * 4 + 2]) * 255 + (1 - a) * bg[2];
      img.data[p * 4 + 3] = 255;
    }
    const off = document.createElement('canvas');
    off.width = W;
    off.height = H;
    off.getContext('2d')!.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.drawImage(off, 0, 0, SIZE, SIZE);
  }, [target, meta]);
  return <canvas ref={ref} width={SIZE} height={SIZE} className="target-view" />;
}

export default function NCALab() {
  const [config, setConfig] = useState<NCAConfigUI>(NCA_INITIAL);
  const [gradResult, setGradResult] = useState<GradCheckResult | null>(null);
  const [slots, setSlots] = useState<string[]>(() => listSlots(NCA_SLOT_PREFIX));
  const [shareMsg, setShareMsg] = useState<string | null>(null);

  const { running, tick, metrics, handle, start, pause, reset, stepOnce, runGradCheck, poolThumbs, snapshot, prepareLoad } =
    useNCATrainer(config);

  useEffect(() => {
    const st = readHashState<NCAConfigUI>(HASH_KEY);
    if (st && Array.isArray(st.weights)) {
      prepareLoad(st.weights);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setConfig({ ...sanitize(st.config), loadId: 1 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doGradCheck = () => setGradResult(runGradCheck());
  const flashShare = (msg: string) => {
    setShareMsg(msg);
    window.setTimeout(() => setShareMsg(null), 2200);
  };
  const onSave = (name: string) => {
    const { weights, step } = snapshot();
    if (saveSlot(name, makeState(config, weights, step), NCA_SLOT_PREFIX)) setSlots(listSlots(NCA_SLOT_PREFIX));
  };
  const onLoadSlot = (name: string) => {
    const st = loadSlot<NCAConfigUI>(name, NCA_SLOT_PREFIX);
    if (!st) return;
    prepareLoad(st.weights);
    setConfig((c) => ({ ...sanitize(st.config), loadId: c.loadId + 1 }));
  };
  const onDeleteSlot = (name: string) => {
    deleteSlot(name, NCA_SLOT_PREFIX);
    setSlots(listSlots(NCA_SLOT_PREFIX));
  };
  const onShare = () => {
    const { weights, step } = snapshot();
    const state = makeState(config, weights, step);
    const url = shareUrl(state, HASH_KEY);
    writeHashState(state, HASH_KEY);
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url).then(
        () => flashShare('Link copied to clipboard ✓'),
        () => flashShare('Link is in the address bar'),
      );
    } else {
      flashShare('Link is in the address bar');
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (running) pause();
        else start();
      } else if (e.key === 'r') reset();
      else if (e.key === 's' && !running) stepOnce();
      else if (e.key === 'g') setGradResult(runGradCheck());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [running, start, pause, reset, stepOnce, runGradCheck]);

  const paramCount = handle.model ? handle.model.paramCount() : 0;
  const thumbs = poolThumbs(24);

  return (
    <div className="lab">
      <NCAPanel
        config={config}
        setConfig={setConfig}
        running={running}
        onStart={start}
        onPause={pause}
        onReset={reset}
        onStep={stepOnce}
        onGradCheck={doGradCheck}
        gradResult={gradResult}
        metrics={metrics}
        paramCount={paramCount}
        slots={slots}
        onSave={onSave}
        onLoadSlot={onLoadSlot}
        onDeleteSlot={onDeleteSlot}
        onShare={onShare}
        shareMsg={shareMsg}
      />

      <main className="stage">
        <div className="card density-card">
          <div className="card-title">
            The organism&nbsp;
            <span className="muted small">— grown live from one seed cell by the trained rule · drag to wound it</span>
          </div>
          <div className="organism-layout">
            <Organism model={handle.model} meta={handle.demoMeta} rebuildKey={handle.rebuildKey} tick={tick} />
            <div className="target-ref">
              <div className="muted small">target</div>
              <TargetView target={handle.target} meta={handle.trainMeta} />
              <div className="muted small" style={{ textAlign: 'center' }}>
                {NCA_TARGETS.find((t) => t.id === handle.targetId)?.label}
              </div>
            </div>
          </div>
        </div>

        <div className="stage-row">
          <div className="card flow-side-card">
            <div className="card-title">Training loss · reconstruction MSE</div>
            <NCAChart loss={metrics.lossHistory} width={320} height={170} />
            <p className="muted small">
              The loss is on the <b>final frame</b> of a {config.stepsMin}–{config.stepsMax}-step rollout; the gradient
              back-propagates through every step (BPTT).
            </p>
          </div>
          <div className="card flow-side-card">
            <div className="card-title">
              Sample pool <span className="muted small">— the population Persist / Regenerate train against</span>
            </div>
            <PoolStrip thumbs={thumbs} meta={handle.trainMeta} tick={tick} />
          </div>
        </div>
      </main>
    </div>
  );
}
