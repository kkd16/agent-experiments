import { useEffect, useMemo, useState } from 'react';
import { useViTTrainer, vitArch, type ViTConfigUI } from '../../hooks/useViTTrainer';
import { VIT_ARCH_PRESETS } from '../../engine/vit';
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
  VIT_SLOT_PREFIX,
} from '../../engine/serialize';
import ViTPanel from './ViTPanel';
import ViTDrawPad from './ViTDrawPad';
import AttentionView from './AttentionView';
import PosEmbView from './PosEmbView';
import ViTSamples from './ViTSamples';
import ConfusionMatrix from '../vision/ConfusionMatrix';
import LossChart from '../LossChart';

const HASH_KEY = 'i';

const VIT_INITIAL: ViTConfigUI = {
  dataset: 'shapes',
  imgSize: 16,
  samples: 320,
  noise: 0.06,
  jitter: 0.7,
  seed: 1,
  archId: 'small',
  optimizer: 'adam',
  lr: 0.006,
  weightDecay: 0.0001,
  batchSize: 24,
  stepsPerFrame: 2,
  valFraction: 0.2,
  scheduleKind: 'constant',
  schedulePeriod: 600,
  scheduleWarmup: 100,
  clipNorm: 2,
  loadId: 0,
};

function sanitize(raw: unknown): ViTConfigUI {
  const c = (raw ?? {}) as Partial<ViTConfigUI>;
  const archId = VIT_ARCH_PRESETS.some((p) => p.id === c.archId) ? (c.archId as string) : VIT_INITIAL.archId;
  const dataset = c.dataset === 'shapes' || c.dataset === 'digits' ? c.dataset : VIT_INITIAL.dataset;
  return {
    ...VIT_INITIAL,
    ...c,
    dataset,
    archId,
    imgSize: 16,
    samples: Math.max(120, Math.min(960, Math.round(Number(c.samples) || VIT_INITIAL.samples))),
    valFraction: Math.max(0, Math.min(0.5, Number.isFinite(Number(c.valFraction)) ? Number(c.valFraction) : VIT_INITIAL.valFraction)),
  };
}

export default function ViTLab() {
  const [config, setConfig] = useState<ViTConfigUI>(VIT_INITIAL);
  const [selected, setSelected] = useState(0);
  const [gradResult, setGradResult] = useState<GradCheckResult | null>(null);
  const [slots, setSlots] = useState<string[]>(() => listSlots(VIT_SLOT_PREFIX));
  const [shareMsg, setShareMsg] = useState<string | null>(null);

  const {
    running,
    tick,
    metrics,
    confusion,
    start,
    pause,
    reset,
    stepOnce,
    runGradCheck,
    handle,
    snapshot,
    prepareLoad,
    predictImage,
    analyze,
    analyzeSample,
  } = useViTTrainer(config);

  useEffect(() => {
    const st = readHashState<ViTConfigUI>(HASH_KEY);
    if (st && Array.isArray(st.weights)) {
      prepareLoad(st.weights, st.step ?? 0);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setConfig({ ...sanitize(st.config), loadId: 1 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Attention analysis + pixels for the currently-selected sample. Recomputed on training ticks
  // so the rollout sharpens live as the model learns.
  const analysis = useMemo(() => analyzeSample(selected), [analyzeSample, selected, tick]);
  const selectedPixels = useMemo(() => {
    const ds = handle.data;
    if (!ds) return null;
    const px = ds.size * ds.size;
    const safe = Math.min(selected, ds.n - 1);
    return ds.X.slice(safe * px, safe * px + px);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handle.data, selected, tick]);

  const doGradCheck = () => setGradResult(runGradCheck());
  const flashShare = (msg: string) => {
    setShareMsg(msg);
    window.setTimeout(() => setShareMsg(null), 2200);
  };
  const onSave = (name: string) => {
    const { weights, step } = snapshot();
    if (saveSlot(name, makeState(config, weights, step), VIT_SLOT_PREFIX)) setSlots(listSlots(VIT_SLOT_PREFIX));
  };
  const onLoadSlot = (name: string) => {
    const st = loadSlot<ViTConfigUI>(name, VIT_SLOT_PREFIX);
    if (!st) return;
    prepareLoad(st.weights, st.step ?? 0);
    setConfig((c) => ({ ...sanitize(st.config), loadId: c.loadId + 1 }));
  };
  const onDeleteSlot = (name: string) => {
    deleteSlot(name, VIT_SLOT_PREFIX);
    setSlots(listSlots(VIT_SLOT_PREFIX));
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
  const arch = vitArch(config.archId);

  return (
    <div className="lab">
      <ViTPanel
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
        <div className="card">
          <div className="card-title">
            Attention rollout
            <span className="muted small"> — the image as a sequence of {arch.patch}×{arch.patch} patches; the map is where the [CLS] token looks</span>
          </div>
          <AttentionView analysis={analysis} pixels={selectedPixels} imgSize={handle.imgSize} gridSide={handle.gridSide} labels={handle.labels} />
        </div>

        <div className="stage-row">
          <div className="card chart-card">
            <div className="card-title">Training curves</div>
            <LossChart
              loss={metrics.lossHistory}
              acc={metrics.accHistory}
              valLoss={metrics.valLossHistory}
              valAcc={metrics.valAccHistory}
              accLabel="accuracy"
              width={300}
              height={150}
            />
          </div>
          <div className="card conf-card">
            <div className="card-title">
              Confusion matrix
              <span className="muted small"> — true (row) vs. predicted (col)</span>
            </div>
            <ConfusionMatrix confusion={confusion} labels={handle.labels} />
          </div>
        </div>

        <div className="card">
          <div className="card-title">
            Positional-embedding similarity
            <span className="muted small"> — each tile: one patch position vs. all others; a trained ViT recovers the 2-D grid</span>
          </div>
          <PosEmbView handle={handle} tick={tick} />
        </div>

        <div className="card draw-card">
          <div className="card-title">
            Draw &amp; classify
            <span className="muted small"> — sketch a {config.dataset === 'digits' ? 'digit' : 'shape'}; watch the ViT read it and show its attention</span>
          </div>
          <ViTDrawPad handle={handle} tick={tick} analyze={analyze} />
        </div>
      </main>

      <section className="neurons card">
        <div className="card-title">Samples</div>
        <p className="muted small">Live predictions on dataset samples — green = correct, pink = wrong. Click one to inspect its attention above.</p>
        <ViTSamples handle={handle} tick={tick} predict={predictImage} onPick={setSelected} selected={selected} />
      </section>
    </div>
  );
}
