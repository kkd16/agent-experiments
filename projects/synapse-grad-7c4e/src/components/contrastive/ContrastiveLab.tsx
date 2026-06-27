import { useEffect, useState } from 'react';
import { useContrastiveTrainer, type ContrastiveConfig } from '../../hooks/useContrastiveTrainer';
import { ENCODER_PRESETS } from '../../engine/contrastive';
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
  CONTRASTIVE_SLOT_PREFIX,
} from '../../engine/serialize';
import ContrastivePanel from './ContrastivePanel';
import EmbeddingScatter from './EmbeddingScatter';
import AugmentationView from './AugmentationView';
import SimilarityMatrix from './SimilarityMatrix';
import MetricsChart from './MetricsChart';

const HASH_KEY = 'z';

const INITIAL: ContrastiveConfig = {
  dataset: 'digits',
  imgSize: 16,
  samples: 400,
  seed: 1,
  presetId: 'standard',
  temperature: 0.2,
  batchPairs: 24,
  optimizer: 'adamw',
  lr: 0.003,
  weightDecay: 0.0001,
  stepsPerFrame: 2,
  clipNorm: 5,
  scheduleKind: 'constant',
  schedulePeriod: 1500,
  scheduleWarmup: 200,
  augStrength: 0.8,
  cutout: 0.25,
  loadId: 0,
};

function sanitize(raw: unknown): ContrastiveConfig {
  const c = (raw ?? {}) as Partial<ContrastiveConfig>;
  const presetId = ENCODER_PRESETS.some((p) => p.id === c.presetId) ? (c.presetId as string) : INITIAL.presetId;
  const dataset = c.dataset === 'shapes' || c.dataset === 'digits' ? c.dataset : INITIAL.dataset;
  return {
    ...INITIAL,
    ...c,
    dataset,
    presetId,
    imgSize: 16,
    samples: Math.max(120, Math.min(600, Math.round(Number(c.samples) || INITIAL.samples))),
    batchPairs: [12, 16, 24, 32, 48].includes(Number(c.batchPairs)) ? Number(c.batchPairs) : INITIAL.batchPairs,
    augStrength: Math.max(0.2, Math.min(1.4, Number.isFinite(Number(c.augStrength)) ? Number(c.augStrength) : INITIAL.augStrength)),
  };
}

export default function ContrastiveLab() {
  const [config, setConfig] = useState<ContrastiveConfig>(INITIAL);
  const [gradResult, setGradResult] = useState<GradCheckResult | null>(null);
  const [slots, setSlots] = useState<string[]>(() => listSlots(CONTRASTIVE_SLOT_PREFIX));
  const [shareMsg, setShareMsg] = useState<string | null>(null);

  const {
    running,
    tick,
    metrics,
    views,
    handle,
    start,
    pause,
    reset,
    stepOnce,
    refreshViews,
    runGradCheck,
    snapshot,
    prepareLoad,
  } = useContrastiveTrainer(config);

  // Restore a shared experiment from the URL hash (#z=…) on first load.
  useEffect(() => {
    const st = readHashState<ContrastiveConfig>(HASH_KEY);
    if (st && Array.isArray(st.weights)) {
      prepareLoad(st.weights, st.step ?? 0);
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
    if (saveSlot(name, makeState(config, weights, step), CONTRASTIVE_SLOT_PREFIX)) setSlots(listSlots(CONTRASTIVE_SLOT_PREFIX));
  };
  const onLoadSlot = (name: string) => {
    const st = loadSlot<ContrastiveConfig>(name, CONTRASTIVE_SLOT_PREFIX);
    if (!st) return;
    prepareLoad(st.weights, st.step ?? 0);
    setConfig((c) => ({ ...sanitize(st.config), loadId: c.loadId + 1 }));
  };
  const onDeleteSlot = (name: string) => {
    deleteSlot(name, CONTRASTIVE_SLOT_PREFIX);
    setSlots(listSlots(CONTRASTIVE_SLOT_PREFIX));
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

  // keyboard shortcuts (mirror the other labs)
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

  const paramCount = handle.encoder ? handle.encoder.paramCount() : 0;
  const anchorLabel = views.aug ? handle.labels[views.aug.label] : undefined;

  return (
    <div className="lab">
      <ContrastivePanel
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
        <div className="card scatter-card">
          <div className="card-title">
            Representation space
            <span className="muted small"> — PCA of the backbone, colored by the hidden label (the encoder never saw it)</span>
          </div>
          <EmbeddingScatter scatter={views.scatter} labels={handle.labels} tick={tick} size={360} />
          <p className="muted small">
            Linear-probe accuracy on the frozen representation:{' '}
            <b>{Number.isFinite(metrics.probeAcc) ? `${(metrics.probeAcc * 100).toFixed(0)}%` : '—'}</b> · kNN{' '}
            <b>{Number.isFinite(metrics.knnAcc) ? `${(metrics.knnAcc * 100).toFixed(0)}%` : '—'}</b> · raw-pixel baseline{' '}
            <b>{Number.isFinite(metrics.pixelProbeAcc) ? `${(metrics.pixelProbeAcc * 100).toFixed(0)}%` : '—'}</b>
          </p>
        </div>

        <div className="stage-row">
          <div className="card simmat-card">
            <div className="card-title">
              Similarity matrix
              <button className="link interp-new" onClick={refreshViews}>
                ↻ new views
              </button>
            </div>
            <p className="muted small">One batch's cosine similarities; NT-Xent pulls the boxed positive of each row up and everything else down.</p>
            <SimilarityMatrix sim={views.sim} tick={tick} size={300} />
          </div>
          <div className="card chart-card">
            <div className="card-title">Training &amp; evaluation</div>
            <MetricsChart
              lossHistory={metrics.lossHistory}
              probeHistory={metrics.probeHistory}
              knnHistory={metrics.knnHistory}
              pixelProbeAcc={metrics.pixelProbeAcc}
              width={300}
              height={230}
            />
            <div className="stat-row tight">
              <div className="stat">
                <span className="muted small">alignment ↓</span>
                <b>{Number.isFinite(metrics.alignment) ? metrics.alignment.toFixed(3) : '—'}</b>
              </div>
              <div className="stat">
                <span className="muted small">uniformity ↓</span>
                <b>{Number.isFinite(metrics.uniformity) ? metrics.uniformity.toFixed(2) : '—'}</b>
              </div>
            </div>
          </div>
        </div>

        <div className="card aug-card">
          <div className="card-title">
            Augmented views
            <span className="muted small"> — two random crops of one glyph are a “positive pair”</span>
            <button className="link interp-new" onClick={refreshViews}>
              ↻ resample
            </button>
          </div>
          <AugmentationView aug={views.aug} size={handle.imgSize} label={anchorLabel} />
        </div>
      </main>
    </div>
  );
}
