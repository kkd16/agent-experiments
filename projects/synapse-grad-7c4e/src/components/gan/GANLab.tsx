import { useEffect, useState } from 'react';
import { useGANTrainer, type GANConfigUI } from '../../hooks/useGANTrainer';
import { GAN_PRESETS, GAN_OBJECTIVES } from '../../engine/gan';
import { FLOW_DATASETS } from '../../engine/flow-data';
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
  GAN_SLOT_PREFIX,
} from '../../engine/serialize';
import GANPanel from './GANPanel';
import DiscriminatorField from './DiscriminatorField';
import GANSamples from './GANSamples';
import GANChart from './GANChart';

const HASH_KEY = 'a';

const GAN_INITIAL: GANConfigUI = {
  dataset: 'moons',
  samples: 3000,
  noise: 0.06,
  seed: 1,
  presetId: 'standard',
  zDim: 2,
  gAct: 'leaky_relu',
  dAct: 'leaky_relu',
  objective: 'nonsat',
  optimizer: 'adam',
  lr: 0.001,
  weightDecay: 0,
  batchSize: 128,
  dSteps: 1,
  clipC: 0.05,
  stepsPerFrame: 2,
  clipNorm: 0,
  gridRes: 64,
  sampleCount: 1000,
  loadId: 0,
};

function sanitize(raw: unknown): GANConfigUI {
  const c = (raw ?? {}) as Partial<GANConfigUI>;
  const presetId = GAN_PRESETS.some((p) => p.id === c.presetId) ? (c.presetId as string) : GAN_INITIAL.presetId;
  const dataset = FLOW_DATASETS.some((d) => d.id === c.dataset) ? (c.dataset as GANConfigUI['dataset']) : GAN_INITIAL.dataset;
  const objective = GAN_OBJECTIVES.some((o) => o.id === c.objective) ? (c.objective as GANConfigUI['objective']) : GAN_INITIAL.objective;
  return {
    ...GAN_INITIAL,
    ...c,
    dataset,
    presetId,
    objective,
    samples: Math.max(500, Math.min(6000, Math.round(Number(c.samples) || GAN_INITIAL.samples))),
    zDim: [2, 4, 8, 16].includes(Number(c.zDim)) ? Number(c.zDim) : GAN_INITIAL.zDim,
    dSteps: [1, 2, 3, 5].includes(Number(c.dSteps)) ? Number(c.dSteps) : GAN_INITIAL.dSteps,
    gridRes: [48, 64, 80, 100].includes(Number(c.gridRes)) ? Number(c.gridRes) : GAN_INITIAL.gridRes,
    sampleCount: [200, 500, 1000, 2000].includes(Number(c.sampleCount)) ? Number(c.sampleCount) : GAN_INITIAL.sampleCount,
  };
}

export default function GANLab() {
  const [config, setConfig] = useState<GANConfigUI>(GAN_INITIAL);
  const [gradResult, setGradResult] = useState<GradCheckResult | null>(null);
  const [slots, setSlots] = useState<string[]>(() => listSlots(GAN_SLOT_PREFIX));
  const [shareMsg, setShareMsg] = useState<string | null>(null);
  const [sampleSeed, setSampleSeed] = useState(7);
  const [showReal, setShowReal] = useState(true);
  const [showFake, setShowFake] = useState(true);
  const [showWarp, setShowWarp] = useState(false);

  const {
    running,
    tick,
    metrics,
    start,
    pause,
    reset,
    stepOnce,
    runGradCheck,
    handle,
    snapshot,
    prepareLoad,
    discGrid,
    dataPoints,
    modelSamples,
    generatorWarp,
  } = useGANTrainer(config);

  // Restore a shared GAN from the URL hash (#a=…) on first load.
  useEffect(() => {
    const st = readHashState<GANConfigUI>(HASH_KEY);
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
    if (saveSlot(name, makeState(config, weights, step), GAN_SLOT_PREFIX)) setSlots(listSlots(GAN_SLOT_PREFIX));
  };
  const onLoadSlot = (name: string) => {
    const st = loadSlot<GANConfigUI>(name, GAN_SLOT_PREFIX);
    if (!st) return;
    prepareLoad(st.weights, st.step ?? 0);
    setConfig((c) => ({ ...sanitize(st.config), loadId: c.loadId + 1 }));
  };
  const onDeleteSlot = (name: string) => {
    deleteSlot(name, GAN_SLOT_PREFIX);
    setSlots(listSlots(GAN_SLOT_PREFIX));
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

  const paramCount = handle.model ? handle.model.paramCount() : 0;
  const isWgan = handle.objective === 'wgan';
  const fieldNote = isWgan
    ? 'critic score D(x): blue = low (fake side) · amber = high (real side), boundary at 0'
    : 'σ(D(x)): blue = "fake" · amber = "real", boundary at ½';

  return (
    <div className="lab">
      <GANPanel
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
            Discriminator decision surface&nbsp;<span className="muted small">— {fieldNote}</span>
            <span className="flow-toggles">
              <label className="toggle">
                <input type="checkbox" checked={showReal} onChange={(e) => setShowReal(e.target.checked)} /> real
              </label>
              <label className="toggle">
                <input type="checkbox" checked={showFake} onChange={(e) => setShowFake(e.target.checked)} /> fake
              </label>
              <label className="toggle" title={handle.zDim === 2 ? '' : 'latent must be 2-D'}>
                <input type="checkbox" checked={showWarp} disabled={handle.zDim !== 2} onChange={(e) => setShowWarp(e.target.checked)} /> G warp
              </label>
            </span>
          </div>
          <DiscriminatorField
            view={handle.view}
            res={config.gridRes}
            tick={tick}
            showReal={showReal}
            showFake={showFake}
            showWarp={showWarp}
            discGrid={discGrid}
            dataPoints={dataPoints}
            modelSamples={modelSamples}
            generatorWarp={generatorWarp}
            sampleSeed={sampleSeed}
            sampleCount={config.sampleCount}
          />
        </div>

        <div className="stage-row">
          <div className="card flow-side-card">
            <div className="card-title">
              Generated samples x = G(z)
              <button className="link interp-new" onClick={() => setSampleSeed((s) => s + 1)}>
                ↻ new sample
              </button>
            </div>
            <GANSamples
              view={handle.view}
              tick={tick}
              seed={sampleSeed}
              count={config.sampleCount}
              dataPoints={dataPoints}
              modelSamples={modelSamples}
            />
          </div>
          <div className="card flow-side-card">
            <div className="card-title">
              Training curves
              <span className="muted small"> — {isWgan ? 'critic loss tracks the Wasserstein distance' : 'the two losses chase each other'}</span>
            </div>
            <GANChart
              dLoss={metrics.dLossHistory}
              gLoss={metrics.gLossHistory}
              wDist={metrics.wDistHistory}
              objective={handle.objective}
              width={320}
              height={220}
            />
          </div>
        </div>
      </main>
    </div>
  );
}
