import { useEffect, useRef, useState } from 'react';
import { useNodeTrainer, type NodeConfigUI } from '../../hooks/useNodeTrainer';
import { NODE_DATASETS } from '../../engine/node-ode';
import type { GradCheckResult } from '../../engine/gradcheck';
import type { AdjointReport } from '../../hooks/useNodeTrainer';
import {
  listSlots,
  loadSlot,
  saveSlot,
  deleteSlot,
  makeState,
  shareUrl,
  writeHashState,
  readHashState,
  NODE_SLOT_PREFIX,
} from '../../engine/serialize';
import NodePanel from './NodePanel';
import FlowField from './FlowField';
import LiftView from './LiftView';
import NodeChart from './NodeChart';

const HASH_KEY = 'o';

const NODE_INITIAL: NodeConfigUI = {
  dataset: 'circles',
  samples: 1200,
  noise: 0.05,
  seed: 1,
  augDim: 1,
  hidden: 32,
  depth: 1,
  activation: 'tanh',
  solver: 'rk4',
  steps: 12,
  optimizer: 'adamw',
  lr: 0.01,
  weightDecay: 0,
  batchSize: 128,
  stepsPerFrame: 2,
  scheduleKind: 'constant',
  schedulePeriod: 800,
  scheduleWarmup: 100,
  clipNorm: 5,
  valFraction: 0.15,
  gridRes: 56,
  trajCount: 150,
  loadId: 0,
};

function sanitize(raw: unknown): NodeConfigUI {
  const c = (raw ?? {}) as Partial<NodeConfigUI>;
  const dataset = NODE_DATASETS.some((d) => d.id === c.dataset) ? (c.dataset as NodeConfigUI['dataset']) : NODE_INITIAL.dataset;
  return {
    ...NODE_INITIAL,
    ...c,
    dataset,
    samples: Math.max(300, Math.min(3000, Math.round(Number(c.samples) || NODE_INITIAL.samples))),
    augDim: [0, 1, 2, 3].includes(Number(c.augDim)) ? Number(c.augDim) : NODE_INITIAL.augDim,
    valFraction: Math.max(0, Math.min(0.5, Number.isFinite(Number(c.valFraction)) ? Number(c.valFraction) : NODE_INITIAL.valFraction)),
    gridRes: [40, 56, 72, 88].includes(Number(c.gridRes)) ? Number(c.gridRes) : NODE_INITIAL.gridRes,
    trajCount: [80, 150, 250, 400].includes(Number(c.trajCount)) ? Number(c.trajCount) : NODE_INITIAL.trajCount,
  };
}

export default function NodeLab() {
  const [config, setConfig] = useState<NodeConfigUI>(NODE_INITIAL);
  const [gradResult, setGradResult] = useState<GradCheckResult | null>(null);
  const [adjointResult, setAdjointResult] = useState<AdjointReport | null>(null);
  const [slots, setSlots] = useState<string[]>(() => listSlots(NODE_SLOT_PREFIX));
  const [shareMsg, setShareMsg] = useState<string | null>(null);
  const [t, setT] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [showField, setShowField] = useState(true);
  const [showVectors, setShowVectors] = useState(true);
  const [showTraj, setShowTraj] = useState(true);
  const playRef = useRef<number | null>(null);

  const {
    running,
    tick,
    metrics,
    start,
    pause,
    reset,
    stepOnce,
    runGradCheck,
    runAdjointCheck,
    handle,
    snapshot,
    prepareLoad,
    decisionField,
    sampleTrajectories,
    vectorField,
    dataPoints,
  } = useNodeTrainer(config);

  useEffect(() => {
    const st = readHashState<NodeConfigUI>(HASH_KEY);
    if (st && Array.isArray(st.weights)) {
      prepareLoad(st.weights, st.step ?? 0);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setConfig({ ...sanitize(st.config), loadId: 1 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // play loop for the time scrubber: sweep t 0→1 and loop.
  useEffect(() => {
    if (!playing) return;
    let alive = true;
    let last = performance.now();
    const frame = (now: number) => {
      if (!alive) return;
      const dt = (now - last) / 1000;
      last = now;
      setT((prev) => {
        const next = prev + dt * 0.6;
        return next > 1 ? 0 : next;
      });
      playRef.current = requestAnimationFrame(frame);
    };
    playRef.current = requestAnimationFrame(frame);
    return () => {
      alive = false;
      if (playRef.current !== null) cancelAnimationFrame(playRef.current);
    };
  }, [playing]);

  const doGradCheck = () => setGradResult(runGradCheck());
  const doAdjointCheck = () => setAdjointResult(runAdjointCheck());
  const flashShare = (msg: string) => {
    setShareMsg(msg);
    window.setTimeout(() => setShareMsg(null), 2200);
  };
  const onSave = (name: string) => {
    const { weights, step } = snapshot();
    if (saveSlot(name, makeState(config, weights, step), NODE_SLOT_PREFIX)) setSlots(listSlots(NODE_SLOT_PREFIX));
  };
  const onLoadSlot = (name: string) => {
    const st = loadSlot<NodeConfigUI>(name, NODE_SLOT_PREFIX);
    if (!st) return;
    prepareLoad(st.weights, st.step ?? 0);
    setConfig((c) => ({ ...sanitize(st.config), loadId: c.loadId + 1 }));
  };
  const onDeleteSlot = (name: string) => {
    deleteSlot(name, NODE_SLOT_PREFIX);
    setSlots(listSlots(NODE_SLOT_PREFIX));
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

  return (
    <div className="lab">
      <NodePanel
        config={config}
        setConfig={setConfig}
        running={running}
        onStart={start}
        onPause={pause}
        onReset={reset}
        onStep={stepOnce}
        onGradCheck={doGradCheck}
        gradResult={gradResult}
        onAdjointCheck={doAdjointCheck}
        adjointResult={adjointResult}
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
            Continuous flow&nbsp;<span className="muted small">— input plane flowing along dz/dt = f_θ(z, t); regions = head(z(1))</span>
            <span className="flow-toggles">
              <label className="toggle">
                <input type="checkbox" checked={showField} onChange={(e) => setShowField(e.target.checked)} /> regions
              </label>
              <label className="toggle">
                <input type="checkbox" checked={showVectors} onChange={(e) => setShowVectors(e.target.checked)} /> field
              </label>
              <label className="toggle">
                <input type="checkbox" checked={showTraj} onChange={(e) => setShowTraj(e.target.checked)} /> trails
              </label>
            </span>
          </div>
          <FlowField
            view={handle.view}
            classes={handle.classes}
            res={config.gridRes}
            trajCount={config.trajCount}
            tick={tick}
            t={t}
            showField={showField}
            showVectors={showVectors}
            showTraj={showTraj}
            decisionField={decisionField}
            sampleTrajectories={sampleTrajectories}
            vectorField={vectorField}
            dataPoints={dataPoints}
          />
          <div className="scrub-row">
            <button className="ghost mini" onClick={() => setPlaying((p) => !p)}>
              {playing ? '❚❚' : '▶'} time
            </button>
            <input
              className="scrub"
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={t}
              onChange={(e) => {
                setPlaying(false);
                setT(Number(e.target.value));
              }}
            />
            <span className="muted small mono">t = {t.toFixed(2)}</span>
          </div>
        </div>

        <div className="stage-row">
          <div className="card flow-side-card">
            <div className="card-title">
              Lift into the augmented axis
              <span className="muted small"> — (x, a₀); points rise off the plane to avoid crossing</span>
            </div>
            <LiftView
              view={handle.view}
              tick={tick}
              t={t}
              trajCount={config.trajCount}
              augDim={config.augDim}
              sampleTrajectories={sampleTrajectories}
            />
          </div>
          <div className="card flow-side-card">
            <div className="card-title">Training curve · accuracy &amp; loss</div>
            <NodeChart trainAcc={metrics.trainAccHistory} valAcc={metrics.valAccHistory} loss={metrics.lossHistory} width={320} height={170} />
          </div>
        </div>
      </main>
    </div>
  );
}
