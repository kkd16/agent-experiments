import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTrainer, type TrainerConfig } from './hooks/useTrainer';
import ControlPanel from './components/ControlPanel';
import DecisionBoundary from './components/DecisionBoundary';
import RegressionPlot from './components/RegressionPlot';
import NeuronGrid from './components/NeuronGrid';
import LossChart from './components/LossChart';
import GraphView from './components/GraphView';
import WeightStats from './components/WeightStats';
import type { GradCheckResult } from './engine/gradcheck';
import {
  listSlots,
  loadSlot,
  saveSlot,
  deleteSlot,
  makeState,
  shareUrl,
  writeHashState,
  readHashState,
} from './engine/serialize';
import './App.css';

const INITIAL: TrainerConfig = {
  mode: 'classification',
  classKind: 'spiral',
  regKind: 'sine',
  samples: 240,
  noise: 0.08,
  seed: 1,
  hidden: [
    { units: 8, activation: 'tanh', norm: 'none', dropout: 0, residual: false },
    { units: 6, activation: 'tanh', norm: 'none', dropout: 0, residual: false },
  ],
  optimizer: 'adam',
  lr: 0.03,
  weightDecay: 0,
  batchSize: 30,
  stepsPerFrame: 2,
  regLoss: 'mse',
  valFraction: 0.2,
  scheduleKind: 'constant',
  schedulePeriod: 400,
  scheduleWarmup: 100,
  clipNorm: 0,
  loadId: 0,
};

// Coerce a (possibly old or untrusted) saved/shared config into a valid one by layering it
// over the defaults — so schema additions and bad input never crash the lab.
function sanitizeConfig(raw: unknown): TrainerConfig {
  const c = (raw ?? {}) as Partial<TrainerConfig>;
  const hidden = Array.isArray(c.hidden) && c.hidden.length
    ? c.hidden.slice(0, 5).map((l) => ({
        units: Math.max(1, Math.min(24, Math.round(Number(l?.units) || 6))),
        activation: l?.activation ?? 'tanh',
        norm: l?.norm ?? 'none',
        dropout: Number(l?.dropout) || 0,
        residual: Boolean(l?.residual),
      }))
    : INITIAL.hidden;
  return {
    ...INITIAL,
    ...c,
    samples: Math.max(60, Math.min(600, Math.round(Number(c.samples) || INITIAL.samples))),
    valFraction: Math.max(
      0,
      Math.min(0.5, Number.isFinite(Number(c.valFraction)) ? Number(c.valFraction) : INITIAL.valFraction),
    ),
    hidden,
  };
}

export default function App() {
  const [config, setConfig] = useState<TrainerConfig>(INITIAL);
  const [selected, setSelected] = useState<[number, number] | null>([0.3, 0.3]);
  const [gradResult, setGradResult] = useState<GradCheckResult | null>(null);
  const [slots, setSlots] = useState<string[]>(() => listSlots());
  const [shareMsg, setShareMsg] = useState<string | null>(null);
  const { running, tick, metrics, start, pause, reset, stepOnce, runGradCheck, handle, snapshot, prepareLoad } =
    useTrainer(config);

  // measure the stage to size the square board responsively
  const stageRef = useRef<HTMLDivElement>(null);
  const [board, setBoard] = useState(440);
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0].contentRect.width;
      setBoard(Math.max(260, Math.min(560, Math.floor(w))));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Restore a shared experiment from the URL hash on first load.
  useEffect(() => {
    const st = readHashState<TrainerConfig>();
    if (st && Array.isArray(st.weights)) {
      prepareLoad(st.weights, st.step ?? 0);
      // One-time restore from the shared URL — an intentional sync, not a render loop.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setConfig({ ...sanitizeConfig(st.config), loadId: 1 });
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
    if (saveSlot(name, makeState(config, weights, step))) setSlots(listSlots());
  };
  const onLoadSlot = (name: string) => {
    const st = loadSlot<TrainerConfig>(name);
    if (!st) return;
    prepareLoad(st.weights, st.step ?? 0);
    setConfig((c) => ({ ...sanitizeConfig(st.config), loadId: c.loadId + 1 }));
  };
  const onDeleteSlot = (name: string) => {
    deleteSlot(name);
    setSlots(listSlots());
  };
  const onShare = () => {
    const { weights, step } = snapshot();
    const state = makeState(config, weights, step);
    const url = shareUrl(state);
    writeHashState(state);
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url).then(
        () => flashShare('Link copied to clipboard ✓'),
        () => flashShare('Link is in the address bar'),
      );
    } else {
      flashShare('Link is in the address bar');
    }
  };

  // keyboard shortcuts
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
      else if (e.key === 'g') doGradCheck();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, start, pause, reset, stepOnce]);

  const paramCount = handle.model ? handle.model.paramCount() : 0;

  return (
    <div className="app">
      <header className="masthead">
        <div className="brand">
          <span className="logo">∇</span>
          <div>
            <h1>Synapse</h1>
            <p>A deep-learning framework from scratch — reverse-mode tensor autograd, live in your browser.</p>
          </div>
        </div>
        <div className="kbd-hint">
          <kbd>space</kbd> train · <kbd>s</kbd> step · <kbd>r</kbd> reset · <kbd>g</kbd> gradcheck
        </div>
      </header>

      <div className="lab">
        <ControlPanel
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
          <div className="board-card" ref={stageRef}>
            <div className="card-title">
              {config.mode === 'classification' ? 'Decision boundary' : 'Function fit'}
              <span className="muted small">
                {config.mode === 'classification'
                  ? ' — click to move the autograd probe'
                  : ' — model output vs. samples'}
              </span>
            </div>
            {config.mode === 'classification' ? (
              <DecisionBoundary handle={handle} tick={tick} selected={selected} onSelect={setSelected} size={board} />
            ) : (
              <RegressionPlot handle={handle} tick={tick} size={board} />
            )}
          </div>

          <div className="stage-row">
            <div className="card chart-card">
              <div className="card-title">Training curves</div>
              <LossChart
                loss={metrics.lossHistory}
                acc={metrics.accHistory}
                valLoss={metrics.valLossHistory}
                valAcc={metrics.valAccHistory}
                accLabel={config.mode === 'classification' ? 'accuracy' : 'R²'}
                width={300}
                height={150}
              />
            </div>
            <div className="card graph-card">
              <div className="card-title">Computation graph</div>
              <GraphView handle={handle} tick={tick} selected={selected} />
            </div>
          </div>

          <div className="card wstats-card">
            <div className="card-title">
              Weights &amp; gradients
              <span className="muted small"> — per-layer ‖W‖ and ‖∂W‖, with a live grad-norm trace</span>
            </div>
            <WeightStats handle={handle} metrics={metrics} tick={tick} />
          </div>
        </main>

        <section className="neurons card">
          <div className="card-title">Neuron feature maps</div>
          <p className="muted small">
            Each tile shows one hidden unit&apos;s activation across the input plane — the features the network learns.
          </p>
          <div className="neuron-scroll">
            <NeuronGrid handle={handle} tick={tick} />
          </div>
        </section>
      </div>

      <footer className="foot">
        <span>
          No ML libraries — the tensor autograd, normalization layers, optimizers, schedules, losses and datasets are
          all hand-written. Open <code>src/engine/</code> to read the gradients, or hit{' '}
          <b>Run engine self-test</b> to watch every one of them get gradchecked.
        </span>
      </footer>
    </div>
  );
}
