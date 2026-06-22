import { useEffect, useState } from 'react';
import { useFlowTrainer, type FlowConfigUI } from '../../hooks/useFlowTrainer';
import { FLOW_PRESETS } from '../../engine/flows';
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
  FLOW_SLOT_PREFIX,
} from '../../engine/serialize';
import FlowPanel from './FlowPanel';
import DensityField from './DensityField';
import LatentView from './LatentView';
import SampleCloud from './SampleCloud';
import FlowChart from './FlowChart';

const HASH_KEY = 'f';

const FLOW_INITIAL: FlowConfigUI = {
  dataset: 'moons',
  samples: 3000,
  noise: 0.06,
  seed: 1,
  presetId: 'standard',
  activation: 'relu',
  optimizer: 'adamw',
  lr: 0.002,
  weightDecay: 0,
  batchSize: 128,
  stepsPerFrame: 2,
  valFraction: 0.15,
  scheduleKind: 'constant',
  schedulePeriod: 800,
  scheduleWarmup: 100,
  clipNorm: 5,
  gridRes: 64,
  sampleCount: 1000,
  loadId: 0,
};

function sanitize(raw: unknown): FlowConfigUI {
  const c = (raw ?? {}) as Partial<FlowConfigUI>;
  const presetId = FLOW_PRESETS.some((p) => p.id === c.presetId) ? (c.presetId as string) : FLOW_INITIAL.presetId;
  const dataset = FLOW_DATASETS.some((d) => d.id === c.dataset) ? (c.dataset as FlowConfigUI['dataset']) : FLOW_INITIAL.dataset;
  return {
    ...FLOW_INITIAL,
    ...c,
    dataset,
    presetId,
    samples: Math.max(500, Math.min(6000, Math.round(Number(c.samples) || FLOW_INITIAL.samples))),
    valFraction: Math.max(0, Math.min(0.5, Number.isFinite(Number(c.valFraction)) ? Number(c.valFraction) : FLOW_INITIAL.valFraction)),
    gridRes: [48, 64, 80, 100].includes(Number(c.gridRes)) ? Number(c.gridRes) : FLOW_INITIAL.gridRes,
    sampleCount: [200, 500, 1000, 2000].includes(Number(c.sampleCount)) ? Number(c.sampleCount) : FLOW_INITIAL.sampleCount,
  };
}

export default function FlowLab() {
  const [config, setConfig] = useState<FlowConfigUI>(FLOW_INITIAL);
  const [gradResult, setGradResult] = useState<GradCheckResult | null>(null);
  const [slots, setSlots] = useState<string[]>(() => listSlots(FLOW_SLOT_PREFIX));
  const [shareMsg, setShareMsg] = useState<string | null>(null);
  const [sampleSeed, setSampleSeed] = useState(7);
  const [showPoints, setShowPoints] = useState(true);
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
    densityGrid,
    dataPoints,
    latentScatter,
    modelSamples,
    warpLines,
  } = useFlowTrainer(config);

  // Restore a shared flow from the URL hash (#f=…) on first load.
  useEffect(() => {
    const st = readHashState<FlowConfigUI>(HASH_KEY);
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
    if (saveSlot(name, makeState(config, weights, step), FLOW_SLOT_PREFIX)) setSlots(listSlots(FLOW_SLOT_PREFIX));
  };
  const onLoadSlot = (name: string) => {
    const st = loadSlot<FlowConfigUI>(name, FLOW_SLOT_PREFIX);
    if (!st) return;
    prepareLoad(st.weights, st.step ?? 0);
    setConfig((c) => ({ ...sanitize(st.config), loadId: c.loadId + 1 }));
  };
  const onDeleteSlot = (name: string) => {
    deleteSlot(name, FLOW_SLOT_PREFIX);
    setSlots(listSlots(FLOW_SLOT_PREFIX));
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

  return (
    <div className="lab">
      <FlowPanel
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
            Exact model density&nbsp;<span className="muted small">— p(x) = p_z(f(x))·|det ∂f/∂x|, painted live as the flow learns</span>
            <span className="flow-toggles">
              <label className="toggle">
                <input type="checkbox" checked={showPoints} onChange={(e) => setShowPoints(e.target.checked)} /> data
              </label>
              <label className="toggle">
                <input type="checkbox" checked={showWarp} onChange={(e) => setShowWarp(e.target.checked)} /> warp
              </label>
            </span>
          </div>
          <DensityField
            view={handle.view}
            res={config.gridRes}
            tick={tick}
            showPoints={showPoints}
            showWarp={showWarp}
            densityGrid={densityGrid}
            dataPoints={dataPoints}
            warpLines={warpLines}
          />
        </div>

        <div className="stage-row">
          <div className="card flow-side-card">
            <div className="card-title">
              Latent pushforward z = f(x)
              <span className="muted small"> — data mapped to the base Gaussian (1σ/2σ rings)</span>
            </div>
            <LatentView view={handle.view} tick={tick} latentScatter={latentScatter} />
          </div>
          <div className="card flow-side-card">
            <div className="card-title">
              Samples x = f⁻¹(z)
              <button className="link interp-new" onClick={() => setSampleSeed((s) => s + 1)}>
                ↻ new sample
              </button>
            </div>
            <SampleCloud
              view={handle.view}
              tick={tick}
              seed={sampleSeed}
              count={config.sampleCount}
              dataPoints={dataPoints}
              modelSamples={modelSamples}
            />
          </div>
        </div>

        <div className="card chart-card">
          <div className="card-title">Training curve · exact negative log-likelihood</div>
          <FlowChart nll={metrics.nllHistory} valNll={metrics.valNllHistory} width={320} height={150} />
        </div>
      </main>
    </div>
  );
}
