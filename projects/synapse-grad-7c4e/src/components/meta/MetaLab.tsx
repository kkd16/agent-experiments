import { useEffect, useRef, useState } from 'react';
import { useMetaTrainer, type MetaConfigUI, type MetaMode } from '../../hooks/useMetaTrainer';
import type { GradCheckResult } from '../../engine/gradcheck';
import type { MetaAlgo, TaskFamily } from '../../engine/meta';
import {
  listSlots,
  loadSlot,
  saveSlot,
  deleteSlot,
  makeState,
  shareUrl,
  writeHashState,
  readHashState,
  META_SLOT_PREFIX,
} from '../../engine/serialize';
import MetaControls from './MetaControls';
import AdaptationPanel from './AdaptationPanel';
import DecisionBoundaryPanel from './DecisionBoundaryPanel';
import { CLASS_COLORS } from './palette';
import FewShotChart from './FewShotChart';
import MetaLossChart from './MetaLossChart';
import TaskGallery from './TaskGallery';

const HASH_KEY = 'l';

const META_INITIAL: MetaConfigUI = {
  mode: 'regression',
  family: 'sine',
  nClasses: 3,
  std: 0.25,
  algo: 'reptile',
  hidden: 40,
  depth: 2,
  kShot: 10,
  querySize: 10,
  innerSteps: 5,
  innerLr: 0.01,
  metaLr: 0.5,
  metaBatch: 8,
  noise: 0,
  seed: 7,
  metaStepsPerFrame: 4,
  loadId: 0,
};

// Good starting points per algorithm (Reptile needs a big interpolation ε and ≥2 inner steps;
// FOMAML/joint drive an Adam outer loop with a small LR). Regression and classification want
// different inner LRs, so the presets are per (mode, algo).
const ALGO_PRESET: Record<MetaMode, Record<MetaAlgo, Partial<MetaConfigUI>>> = {
  regression: {
    reptile: { innerSteps: 5, innerLr: 0.01, metaLr: 0.5 },
    fomaml: { innerSteps: 3, innerLr: 0.02, metaLr: 0.004 },
    baseline: { innerSteps: 5, innerLr: 0.01, metaLr: 0.004 },
  },
  classification: {
    reptile: { innerSteps: 5, innerLr: 0.05, metaLr: 0.3 },
    fomaml: { innerSteps: 3, innerLr: 0.05, metaLr: 0.005 },
    baseline: { innerSteps: 5, innerLr: 0.05, metaLr: 0.005 },
  },
};

// Defaults applied when switching problem mode (K-shot conventions differ).
const MODE_PRESET: Record<MetaMode, Partial<MetaConfigUI>> = {
  regression: { kShot: 10, querySize: 10, innerSteps: 5, innerLr: 0.01, metaLr: 0.5 },
  classification: { kShot: 5, querySize: 10, innerSteps: 5, innerLr: 0.05, metaLr: 0.3 },
};

const FAMILIES: TaskFamily[] = ['sine', 'sine-freq', 'line'];
const ALGOS: MetaAlgo[] = ['reptile', 'fomaml', 'baseline'];

function sanitize(raw: unknown): MetaConfigUI {
  const c = (raw ?? {}) as Partial<MetaConfigUI>;
  const clampInt = (v: unknown, lo: number, hi: number, def: number) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def;
  };
  return {
    ...META_INITIAL,
    ...c,
    mode: c.mode === 'classification' ? 'classification' : 'regression',
    family: FAMILIES.includes(c.family as TaskFamily) ? (c.family as TaskFamily) : META_INITIAL.family,
    algo: ALGOS.includes(c.algo as MetaAlgo) ? (c.algo as MetaAlgo) : META_INITIAL.algo,
    nClasses: clampInt(c.nClasses, 2, 5, META_INITIAL.nClasses),
    hidden: clampInt(c.hidden, 4, 256, META_INITIAL.hidden),
    depth: clampInt(c.depth, 1, 4, META_INITIAL.depth),
    kShot: clampInt(c.kShot, 2, 100, META_INITIAL.kShot),
    querySize: clampInt(c.querySize, 2, 100, META_INITIAL.querySize),
    innerSteps: clampInt(c.innerSteps, 1, 20, META_INITIAL.innerSteps),
    metaBatch: clampInt(c.metaBatch, 1, 64, META_INITIAL.metaBatch),
    metaStepsPerFrame: clampInt(c.metaStepsPerFrame, 1, 16, META_INITIAL.metaStepsPerFrame),
    seed: clampInt(c.seed, 0, 99999, META_INITIAL.seed),
    innerLr: Number.isFinite(Number(c.innerLr)) ? Number(c.innerLr) : META_INITIAL.innerLr,
    metaLr: Number.isFinite(Number(c.metaLr)) ? Number(c.metaLr) : META_INITIAL.metaLr,
    std: Number.isFinite(Number(c.std)) ? Number(c.std) : META_INITIAL.std,
    noise: Number.isFinite(Number(c.noise)) ? Number(c.noise) : META_INITIAL.noise,
  };
}

export default function MetaLab() {
  const [config, setConfig] = useState<MetaConfigUI>(META_INITIAL);
  const [gradResult, setGradResult] = useState<GradCheckResult | null>(null);
  const [slots, setSlots] = useState<string[]>(() => listSlots(META_SLOT_PREFIX));
  const [shareMsg, setShareMsg] = useState<string | null>(null);
  const [stepIdx, setStepIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [showRandom, setShowRandom] = useState(true);
  const playRef = useRef<number | null>(null);

  const {
    running,
    metrics,
    handle,
    start,
    pause,
    reset,
    stepOnce,
    adaptationView,
    clfAdaptationView,
    fewShotView,
    taskGallery,
    resampleNovelTask,
    runGradCheck,
    snapshot,
    loadWeights,
  } = useMetaTrainer(config);

  // Load shared state from the URL hash on mount.
  useEffect(() => {
    const st = readHashState<MetaConfigUI>(HASH_KEY);
    if (st && Array.isArray(st.weights)) {
      loadWeights(st.weights, st.step ?? 0);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setConfig({ ...sanitize(st.config), loadId: 1 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Play loop for the adaptation scrubber: sweep 0→innerSteps and hold.
  useEffect(() => {
    if (!playing) return;
    let alive = true;
    let last = performance.now();
    const frame = (now: number) => {
      if (!alive) return;
      if (now - last > 420) {
        last = now;
        setStepIdx((s) => (s >= config.innerSteps ? 0 : s + 1));
      }
      playRef.current = requestAnimationFrame(frame);
    };
    playRef.current = requestAnimationFrame(frame);
    return () => {
      alive = false;
      if (playRef.current !== null) cancelAnimationFrame(playRef.current);
    };
  }, [playing, config.innerSteps]);

  const onAlgoChange = (algo: MetaAlgo) => {
    setConfig((c) => ({ ...c, algo, ...ALGO_PRESET[c.mode][algo] }));
  };
  const onModeChange = (mode: MetaMode) => {
    setConfig((c) => ({ ...c, mode, ...MODE_PRESET[mode], ...ALGO_PRESET[mode][c.algo] }));
    setStepIdx(0);
  };

  const flashShare = (msg: string) => {
    setShareMsg(msg);
    window.setTimeout(() => setShareMsg(null), 2200);
  };
  const onSave = (name: string) => {
    const snap = snapshot();
    if (saveSlot(name, makeState(config, snap.weights, snap.step), META_SLOT_PREFIX)) setSlots(listSlots(META_SLOT_PREFIX));
  };
  const onLoadSlot = (name: string) => {
    const st = loadSlot<MetaConfigUI>(name, META_SLOT_PREFIX);
    if (!st) return;
    loadWeights(st.weights, st.step ?? 0);
    setConfig((c) => ({ ...sanitize(st.config), loadId: c.loadId + 1 }));
  };
  const onDeleteSlot = (name: string) => {
    deleteSlot(name, META_SLOT_PREFIX);
    setSlots(listSlots(META_SLOT_PREFIX));
  };
  const onShare = () => {
    const snap = snapshot();
    const state = makeState(config, snap.weights, snap.step);
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

  const clf = config.mode === 'classification';
  const view = clf ? null : adaptationView();
  const clfView = clf ? clfAdaptationView() : null;
  const few = fewShotView();
  const gallery = taskGallery(14);
  const paramCount = handle.paramCount;

  const clampedStep = Math.min(stepIdx, config.innerSteps);
  const metaLossAt = view ? view.metaSupportLoss[Math.min(clampedStep, view.metaSupportLoss.length - 1)] : NaN;
  const randLossAt = view ? view.randomSupportLoss[Math.min(clampedStep, view.randomSupportLoss.length - 1)] : NaN;
  const metaAccAt = clfView ? clfView.metaSupportAcc[Math.min(clampedStep, clfView.metaSupportAcc.length - 1)] : NaN;
  const randAccAt = clfView ? clfView.randomSupportAcc[Math.min(clampedStep, clfView.randomSupportAcc.length - 1)] : NaN;
  const familyLabel = config.family === 'line' ? 'line' : 'sine';

  return (
    <div className="lab">
      <MetaControls
        config={config}
        setConfig={setConfig}
        onModeChange={onModeChange}
        onAlgoChange={onAlgoChange}
        running={running}
        onStart={start}
        onPause={pause}
        onReset={reset}
        onStep={stepOnce}
        metrics={metrics}
        paramCount={paramCount}
        onGradCheck={() => setGradResult(runGradCheck())}
        gradResult={gradResult}
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
            Few-shot adaptation to a held-out task
            <span className="muted small">
              {clf ? (
                <>
                  &nbsp;— a {config.nClasses}-way arrangement the model has never seen; {config.kShot} points/class; the scrubber runs{' '}
                  {config.innerSteps} inner SGD step{config.innerSteps === 1 ? '' : 's'}
                </>
              ) : (
                <>
                  &nbsp;— a {familyLabel} the model has never seen; {config.kShot} support points; the scrubber runs {config.innerSteps}{' '}
                  inner SGD step{config.innerSteps === 1 ? '' : 's'}
                </>
              )}
            </span>
            <span className="flow-toggles">
              <label className="toggle">
                <input type="checkbox" checked={showRandom} onChange={(e) => setShowRandom(e.target.checked)} /> vs random init
              </label>
              <button className="ghost mini" onClick={resampleNovelTask}>
                ⟳ new task
              </button>
            </span>
          </div>
          {clf ? (
            <DecisionBoundaryPanel view={clfView} stepIdx={clampedStep} showRandom={showRandom} width={640} height={300} />
          ) : (
            <AdaptationPanel view={view} stepIdx={clampedStep} showRandom={showRandom} width={640} height={300} />
          )}
          <div className="scrub-row">
            <button className="ghost mini" onClick={() => setPlaying((p) => !p)}>
              {playing ? '❚❚' : '▶'} adapt
            </button>
            <input
              className="scrub"
              type="range"
              min={0}
              max={config.innerSteps}
              step={1}
              value={clampedStep}
              onChange={(e) => {
                setPlaying(false);
                setStepIdx(Number(e.target.value));
              }}
            />
            <span className="muted small mono">
              step {clampedStep}/{config.innerSteps}
            </span>
          </div>
          {clf ? (
            <div className="legend-row">
              {Array.from({ length: config.nClasses }, (_, i) => (
                <span className="legend-item" key={i}>
                  <i className="swatch" style={{ background: CLASS_COLORS[i % CLASS_COLORS.length] }} /> class {i}
                </span>
              ))}
              <span className="legend-item">
                meta-init acc {Number.isFinite(metaAccAt) ? `${(metaAccAt * 100).toFixed(0)}%` : '—'}
                {showRandom && Number.isFinite(randAccAt) ? ` · random ${(randAccAt * 100).toFixed(0)}%` : ''}
              </span>
            </div>
          ) : (
            <div className="legend-row">
              <span className="legend-item">
                <i className="swatch" style={{ background: 'rgba(226,232,240,0.85)' }} /> true task
              </span>
              <span className="legend-item">
                <i className="swatch" style={{ background: 'rgba(52,211,153,1)' }} /> meta-init
                {Number.isFinite(metaLossAt) ? ` · MSE ${metaLossAt.toFixed(2)}` : ''}
              </span>
              {showRandom && (
                <span className="legend-item">
                  <i className="swatch" style={{ background: 'rgba(251,146,60,0.9)' }} /> random init
                  {Number.isFinite(randLossAt) ? ` · MSE ${randLossAt.toFixed(2)}` : ''}
                </span>
              )}
              <span className="legend-item">
                <i className="swatch" style={{ background: 'rgba(244,114,182,0.95)' }} /> support
              </span>
            </div>
          )}
        </div>

        <div className="stage-row">
          <div className="card flow-side-card">
            <div className="card-title">
              Few-shot curve
              <span className="muted small">
                {' '}
                — {clf ? `${40} novel tasks · query accuracy` : `48 novel tasks · query MSE`} vs adaptation steps{clf ? '' : ' (log)'}
              </span>
            </div>
            <FewShotChart view={few} trainInnerSteps={config.innerSteps} linear={clf} width={340} height={190} />
            <div className="legend-row">
              <span className="legend-item">
                <i className="swatch" style={{ background: 'rgba(52,211,153,1)' }} /> meta-init
              </span>
              <span className="legend-item">
                <i className="swatch" style={{ background: 'rgba(148,163,184,0.85)' }} /> random init
              </span>
            </div>
          </div>
          <div className="card flow-side-card">
            <div className="card-title">
              Meta-training curve
              <span className="muted small"> — query {clf ? 'accuracy' : 'loss (log)'} pre vs post adaptation</span>
            </div>
            {clf ? (
              <MetaLossChart pre={metrics.preAccHistory} post={metrics.postAccHistory} linear width={340} height={190} />
            ) : (
              <MetaLossChart pre={metrics.preHistory} post={metrics.postHistory} width={340} height={190} />
            )}
            <div className="legend-row">
              <span className="legend-item">
                <i className="swatch" style={{ background: 'rgba(251,191,36,0.9)' }} /> pre-adapt
              </span>
              <span className="legend-item">
                <i className="swatch" style={{ background: 'rgba(52,211,153,1)' }} /> post-adapt (meta-objective)
              </span>
            </div>
          </div>
        </div>

        {clf ? (
          <div className="card">
            <div className="card-title">
              How to read it
              <span className="muted small"> — the decision boundary carved from a few points/class</span>
            </div>
            <p className="muted small" style={{ margin: '4px 2px' }}>
              Each task is a fresh arrangement of {config.nClasses} Gaussian blobs. The meta-init is not a classifier for any one
              arrangement — but from it, a couple of gradient steps on {config.kShot} points/class snap the boundary into place, while a
              random init needs many more. Watch the few-shot curve: the meta-init jumps toward 100% in the first step or two.
            </p>
          </div>
        ) : (
          <div className="card">
            <div className="card-title">
              The task distribution
              <span className="muted small">
                {' '}
                — 14 sampled tasks (blue) and their mean (amber) — the flat function joint training collapses to
              </span>
            </div>
            <TaskGallery grid={gallery.grid} curves={gallery.curves} width={640} height={150} />
            <p className="muted small" style={{ marginTop: 8 }}>
              Meta-learning finds an initialization θ that is not good on any one of these tasks, but from which a few gradient steps on a
              handful of points lands on the right one.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
