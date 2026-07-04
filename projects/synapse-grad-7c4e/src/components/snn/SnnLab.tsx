import { useEffect, useState } from 'react';
import { useSnnTrainer, SNN_PRESETS, type SnnUIConfig, type TrainMode } from '../../hooks/useSnnTrainer';
import { SURROGATES, ENCODINGS, type SurrogateKind, type EncodingKind } from '../../engine/snn';
import type { VisionDatasetKind } from '../../engine/images';
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
  SNN_SLOT_PREFIX,
} from '../../engine/serialize';
import SnnPanel from './SnnPanel';
import SpikeRaster from './SpikeRaster';
import MembraneTraces from './MembraneTraces';
import ReadoutView from './ReadoutView';
import EncodingView from './EncodingView';
import SurrogatePlot from './SurrogatePlot';
import FiringRates from './FiringRates';
import LearningChart from './LearningChart';
import ConfusionMatrix from './ConfusionMatrix';
import SnnDrawPad from './SnnDrawPad';

const HASH_KEY = 'y';

const SNN_INITIAL: SnnUIConfig = {
  dataset: 'digits',
  imgSize: 12,
  samples: 400,
  noise: 0.06,
  jitter: 0.12,
  presetId: 'small',
  recurrent: false,
  T: 20,
  beta: 0.9,
  kappa: 0.85,
  threshold: 1,
  surrogate: 'fast-sigmoid',
  slope: 5,
  encoding: 'current',
  currentScale: 1,
  trainMode: 'hard',
  rateReg: 0.001,
  lr: 0.002,
  batch: 32,
  clipNorm: 5,
  spotlight: 0,
  seed: 1,
  loadId: 0,
};

function sanitize(raw: unknown): SnnUIConfig {
  const c = (raw ?? {}) as Partial<SnnUIConfig>;
  const dataset: VisionDatasetKind = c.dataset === 'shapes' ? 'shapes' : 'digits';
  const presetId = SNN_PRESETS.some((p) => p.id === c.presetId) ? c.presetId! : SNN_INITIAL.presetId;
  const surrogate = SURROGATES.some((s) => s.id === c.surrogate) ? (c.surrogate as SurrogateKind) : SNN_INITIAL.surrogate;
  const encoding = ENCODINGS.some((s) => s.id === c.encoding) ? (c.encoding as EncodingKind) : SNN_INITIAL.encoding;
  const trainMode: TrainMode = c.trainMode === 'soft' ? 'soft' : 'hard';
  return { ...SNN_INITIAL, ...c, dataset, presetId, surrogate, encoding, trainMode, recurrent: c.recurrent === true };
}

export default function SnnLab() {
  const [config, setConfig] = useState<SnnUIConfig>(SNN_INITIAL);
  const [gradResult, setGradResult] = useState<GradCheckResult | null>(null);
  const [slots, setSlots] = useState<string[]>(() => listSlots(SNN_SLOT_PREFIX));
  const [shareMsg, setShareMsg] = useState<string | null>(null);

  const {
    running,
    tick,
    metrics,
    handle,
    start,
    pause,
    reset,
    stepOnce,
    trace,
    spotlightInfo,
    runGradCheck,
    classify,
    snapshot,
    prepareLoad,
  } = useSnnTrainer(config);

  useEffect(() => {
    const st = readHashState<SnnUIConfig>(HASH_KEY);
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
    if (saveSlot(name, makeState(config, weights, step), SNN_SLOT_PREFIX)) setSlots(listSlots(SNN_SLOT_PREFIX));
  };
  const onLoadSlot = (name: string) => {
    const st = loadSlot<SnnUIConfig>(name, SNN_SLOT_PREFIX);
    if (!st) return;
    prepareLoad(st.weights);
    setConfig((c) => ({ ...sanitize(st.config), loadId: c.loadId + 1 }));
  };
  const onDeleteSlot = (name: string) => {
    deleteSlot(name, SNN_SLOT_PREFIX);
    setSlots(listSlots(SNN_SLOT_PREFIX));
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
      else if (e.key === 's') stepOnce();
      else if (e.key === 'g') setGradResult(runGradCheck());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [running, start, pause, reset, stepOnce, runGradCheck]);

  const paramCount = handle.net ? handle.net.parameters().reduce((a, p) => a + p.size, 0) : 0;
  const info = spotlightInfo();
  const tr = trace();
  // reference tick so the views re-read the live trace each frame
  void tick;

  return (
    <div className="lab">
      <SnnPanel
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
        spotlightCount={info.count}
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
            Spike raster
            <span className="muted small">
              {' '}— the whole network firing, neurons × time; the input's encoded spikes on top, each LIF layer below
            </span>
          </div>
          <SpikeRaster trace={tr} />
        </div>

        <div className="stage-row">
          <div className="card">
            <div className="card-title">Membrane potential · LIF layer 1</div>
            <p className="muted small">
              The classic integrate-and-fire trace: potential climbs with input current, fires (dot) at θ, resets by −θ.
            </p>
            <MembraneTraces trace={tr} threshold={config.threshold} />
          </div>
          <div className="card">
            <div className="card-title">Readout race · integrated evidence per class</div>
            <p className="muted small">
              The non-spiking output membrane for each class accumulates over time; the highest at t = T wins. Bold =
              prediction, ◦ marks the true class.
            </p>
            <ReadoutView trace={tr} labels={handle.labels} truth={info.truth} />
          </div>
        </div>
      </main>

      <section className="stage-row">
        <div className="card">
          <div className="card-title">Stimulus &amp; decision</div>
          <p className="muted small">The spotlight glyph, its encoding, and the spiking net's verdict.</p>
          <EncodingView trace={tr} encoding={config.encoding} labels={handle.labels} truth={info.truth} />
        </div>
        <div className="card">
          <div className="card-title">The surrogate gradient</div>
          <p className="muted small">
            Why a network of step functions can learn at all: the backward pass borrows a smooth derivative.
          </p>
          <SurrogatePlot surrogate={config.surrogate} slope={config.slope} />
        </div>
      </section>

      <section className="stage-row">
        <div className="card">
          <div className="card-title">
            Draw &amp; spike
            <span className="muted small"> — your own handwriting, encoded to spikes and classified live</span>
          </div>
          <SnnDrawPad handle={handle} tick={tick} classify={classify} />
        </div>
      </section>

      <section className="stage-row">
        <div className="card chart-card">
          <div className="card-title">Learning curve · loss, accuracy &amp; firing rate</div>
          <LearningChart
            loss={metrics.lossHistory}
            trainAcc={metrics.trainAccHistory}
            testAcc={metrics.testAccHistory}
            rate={metrics.rateHistory}
            width={320}
            height={160}
          />
          <p className="muted small chart-foot">
            Amber is the surrogate-gradient loss (log axis); cyan is held-out accuracy (faint = train); violet is the
            mean spike rate — accuracy climbs while the code stays sparse.
          </p>
        </div>
        <div className="card">
          <div className="card-title">Energy · spikes are the cost</div>
          <FiringRates metrics={metrics} />
        </div>
        <div className="card">
          <div className="card-title">Confusion · held-out</div>
          <ConfusionMatrix confusion={metrics.confusion} labels={handle.labels} />
        </div>
      </section>
    </div>
  );
}
