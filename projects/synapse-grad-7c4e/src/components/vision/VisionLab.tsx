import { useEffect, useState } from 'react';
import { useVisionTrainer, type VisionConfig } from '../../hooks/useVisionTrainer';
import { ARCH_PRESETS } from '../../engine/vision-nn';
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
  VISION_SLOT_PREFIX,
} from '../../engine/serialize';
import VisionPanel from './VisionPanel';
import DrawPad from './DrawPad';
import ImageSamples from './ImageSamples';
import FilterGrid from './FilterGrid';
import FeatureMaps from './FeatureMaps';
import ConfusionMatrix from './ConfusionMatrix';
import LossChart from '../LossChart';

const HASH_KEY = 'v';

const VISION_INITIAL: VisionConfig = {
  dataset: 'digits',
  imgSize: 16,
  samples: 720,
  noise: 0.06,
  jitter: 0.8,
  seed: 1,
  archId: 'standard',
  optimizer: 'adam',
  lr: 0.01,
  weightDecay: 0,
  batchSize: 32,
  stepsPerFrame: 2,
  valFraction: 0.2,
  scheduleKind: 'constant',
  schedulePeriod: 600,
  scheduleWarmup: 100,
  clipNorm: 0,
  loadId: 0,
};

function sanitizeVisionConfig(raw: unknown): VisionConfig {
  const c = (raw ?? {}) as Partial<VisionConfig>;
  const archId = ARCH_PRESETS.some((p) => p.id === c.archId) ? (c.archId as string) : VISION_INITIAL.archId;
  const dataset = c.dataset === 'shapes' || c.dataset === 'digits' ? c.dataset : VISION_INITIAL.dataset;
  return {
    ...VISION_INITIAL,
    ...c,
    dataset,
    archId,
    imgSize: 16,
    samples: Math.max(120, Math.min(1200, Math.round(Number(c.samples) || VISION_INITIAL.samples))),
    valFraction: Math.max(0, Math.min(0.5, Number.isFinite(Number(c.valFraction)) ? Number(c.valFraction) : VISION_INITIAL.valFraction)),
  };
}

export default function VisionLab() {
  const [config, setConfig] = useState<VisionConfig>(VISION_INITIAL);
  const [selected, setSelected] = useState(0);
  const [gradResult, setGradResult] = useState<GradCheckResult | null>(null);
  const [slots, setSlots] = useState<string[]>(() => listSlots(VISION_SLOT_PREFIX));
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
    featureMapsFor,
  } = useVisionTrainer(config);

  // Restore a shared CNN experiment from the URL hash (#v=…) on first load.
  useEffect(() => {
    const st = readHashState<VisionConfig>(HASH_KEY);
    if (st && Array.isArray(st.weights)) {
      prepareLoad(st.weights, st.step ?? 0);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setConfig({ ...sanitizeVisionConfig(st.config), loadId: 1 });
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
    if (saveSlot(name, makeState(config, weights, step), VISION_SLOT_PREFIX)) setSlots(listSlots(VISION_SLOT_PREFIX));
  };
  const onLoadSlot = (name: string) => {
    const st = loadSlot<VisionConfig>(name, VISION_SLOT_PREFIX);
    if (!st) return;
    prepareLoad(st.weights, st.step ?? 0);
    setConfig((c) => ({ ...sanitizeVisionConfig(st.config), loadId: c.loadId + 1 }));
  };
  const onDeleteSlot = (name: string) => {
    deleteSlot(name, VISION_SLOT_PREFIX);
    setSlots(listSlots(VISION_SLOT_PREFIX));
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

  // keyboard shortcuts (mirrors the playground)
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

  return (
    <div className="lab">
      <VisionPanel
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
        <div className="card draw-card">
          <div className="card-title">
            Draw &amp; classify
            <span className="muted small"> — sketch a {config.dataset === 'digits' ? 'digit' : 'shape'}; the trained CNN reads it live</span>
          </div>
          <DrawPad handle={handle} tick={tick} predict={predictImage} />
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

        <div className="card feat-card">
          <div className="card-title">
            Feature maps
            <span className="muted small"> — what the convolutions see for the selected sample (click a thumbnail)</span>
          </div>
          <FeatureMaps handle={handle} tick={tick} sampleIdx={selected} featureMapsFor={featureMapsFor} />
        </div>
      </main>

      <section className="neurons card">
        <div className="card-title">Samples &amp; filters</div>
        <p className="muted small">Live predictions on dataset samples — green = correct, pink = wrong. Click one to inspect it.</p>
        <ImageSamples handle={handle} tick={tick} predict={predictImage} onPick={setSelected} selected={selected} />
        <div className="filters-title card-title">Learned conv-1 filters</div>
        <FilterGrid handle={handle} tick={tick} />
      </section>
    </div>
  );
}
