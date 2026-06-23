import { useEffect, useMemo, useState } from 'react';
import { useKANTrainer, type KANConfigUI } from '../../hooks/useKANTrainer';
import { CLASS_DATASETS, REGRESSION_DATASETS } from '../../engine/data';
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
  KAN_SLOT_PREFIX,
} from '../../engine/serialize';
import { CLASS_COLORS, rgbCss } from '../../lib/colors';
import LossChart from '../LossChart';
import KANPanel from './KANPanel';
import KANDiagram from './KANDiagram';
import KANBoundary from './KANBoundary';
import KANFunctionFit from './KANFunctionFit';
import EdgeInspector from './EdgeInspector';

const HASH_KEY = 'k';

const KAN_INITIAL: KANConfigUI = {
  task: 'regress',
  classDataset: 'two-spirals',
  regDataset: 'step',
  n: 220,
  noise: 0.06,
  seed: 1,
  hiddenLayers: 1,
  hiddenDim: 4,
  gridSize: 6,
  degree: 3,
  domain: 1.2,
  valFraction: 0.2,
  optimizer: 'adam',
  lr: 0.05,
  weightDecay: 0,
  clipNorm: 2,
  stepsPerFrame: 4,
  loadId: 0,
};

function sanitize(raw: unknown): KANConfigUI {
  const c = (raw ?? {}) as Partial<KANConfigUI>;
  return {
    ...KAN_INITIAL,
    ...c,
    task: c.task === 'classify' ? 'classify' : 'regress',
    classDataset: CLASS_DATASETS.some((d) => d.id === c.classDataset) ? (c.classDataset as KANConfigUI['classDataset']) : KAN_INITIAL.classDataset,
    regDataset: REGRESSION_DATASETS.some((d) => d.id === c.regDataset) ? (c.regDataset as KANConfigUI['regDataset']) : KAN_INITIAL.regDataset,
    n: Math.max(60, Math.min(600, Math.round(Number(c.n) || KAN_INITIAL.n))),
    hiddenLayers: Math.max(0, Math.min(3, Math.round(Number(c.hiddenLayers ?? KAN_INITIAL.hiddenLayers)))),
    gridSize: Math.max(3, Math.min(20, Math.round(Number(c.gridSize) || KAN_INITIAL.gridSize))),
    degree: Math.max(1, Math.min(3, Math.round(Number(c.degree) || KAN_INITIAL.degree))),
  };
}

export default function KANLab() {
  const [config, setConfig] = useState<KANConfigUI>(KAN_INITIAL);
  const [gradResult, setGradResult] = useState<GradCheckResult | null>(null);
  const [slots, setSlots] = useState<string[]>(() => listSlots(KAN_SLOT_PREFIX));
  const [shareMsg, setShareMsg] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ layer: number; i: number; j: number } | null>({ layer: 0, i: 0, j: 0 });

  const {
    running,
    tick,
    metrics,
    handle,
    start,
    pause,
    reset,
    stepOnce,
    setGridSize,
    fitGridToData,
    runGradCheck,
    boundaryView,
    fitView,
    diagram,
    snapshot,
    prepareLoad,
  } = useKANTrainer(config);

  useEffect(() => {
    const st = readHashState<KANConfigUI>(HASH_KEY);
    if (st && Array.isArray(st.weights)) {
      prepareLoad(st.weights, st.step ?? 0);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setConfig({ ...sanitize(st.config), loadId: 1 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const curves = useMemo(() => diagram(), [diagram, tick]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const bView = useMemo(() => (config.task === 'classify' ? boundaryView() : null), [boundaryView, tick, config.task]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const rView = useMemo(() => (config.task === 'regress' ? fitView() : null), [fitView, tick, config.task]);

  const doGradCheck = () => setGradResult(runGradCheck());
  const onRefineGrid = () => setGridSize(metrics.gridSize * 2);
  const flashShare = (msg: string) => {
    setShareMsg(msg);
    window.setTimeout(() => setShareMsg(null), 2200);
  };
  const onSave = (name: string) => {
    const { weights, step } = snapshot();
    if (saveSlot(name, makeState(config, weights, step), KAN_SLOT_PREFIX)) setSlots(listSlots(KAN_SLOT_PREFIX));
  };
  const onLoadSlot = (name: string) => {
    const st = loadSlot<KANConfigUI>(name, KAN_SLOT_PREFIX);
    if (!st) return;
    prepareLoad(st.weights, st.step ?? 0);
    setConfig((c) => ({ ...sanitize(st.config), loadId: c.loadId + 1 }));
  };
  const onDeleteSlot = (name: string) => {
    deleteSlot(name, KAN_SLOT_PREFIX);
    setSlots(listSlots(KAN_SLOT_PREFIX));
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
  const classify = config.task === 'classify';

  return (
    <div className="lab">
      <KANPanel
        config={config}
        setConfig={setConfig}
        running={running}
        onStart={start}
        onPause={pause}
        onReset={reset}
        onStep={stepOnce}
        onGradCheck={doGradCheck}
        onRefineGrid={onRefineGrid}
        onFitGrid={fitGridToData}
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
            The network is a graph of learned functions
            <span className="muted small"> — each box is one edge's spline φ(x); click it to inspect. Faint edges have been pruned by training.</span>
          </div>
          <KANDiagram layers={curves} tick={tick} selected={selected} onSelect={setSelected} width={620} height={300} />
        </div>

        <div className="stage-row">
          <div className="card flow-side-card">
            <div className="card-title">
              {classify ? 'Decision boundary' : 'Function fit'}
              <span className="muted small"> — {classify ? 'argmax class field behind the data' : 'the learned curve through the noisy samples'}</span>
            </div>
            {classify ? <KANBoundary view={bView} tick={tick} size={300} /> : <KANFunctionFit view={rView} tick={tick} size={300} />}
            {classify && handle.classData && (
              <div className="legend-row">
                {Array.from({ length: handle.classData.classes }, (_, c) => (
                  <span className="legend-item" key={c}>
                    <span className="swatch" style={{ background: rgbCss(CLASS_COLORS[c % CLASS_COLORS.length]) }} /> class {c}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="card flow-side-card">
            <div className="card-title">
              Selected edge <span className="muted small">— φ(x) with its spline knots</span>
            </div>
            <EdgeInspector layers={curves} selected={selected} tick={tick} width={300} height={210} />
            <div className="acc-readout">
              <div>
                <span className="muted small">{classify ? 'train acc' : 'train R²'}</span>
                <b>{Number.isFinite(metrics.trainScore) ? (classify ? `${(metrics.trainScore * 100).toFixed(1)}%` : metrics.trainScore.toFixed(3)) : '—'}</b>
              </div>
              <div>
                <span className="muted small">{classify ? 'val acc' : 'val R²'}</span>
                <b className="accent">
                  {Number.isFinite(metrics.valScore) ? (classify ? `${(metrics.valScore * 100).toFixed(1)}%` : metrics.valScore.toFixed(3)) : '—'}
                </b>
              </div>
              <div>
                <span className="muted small">grid G</span>
                <b>{metrics.gridSize}</b>
              </div>
            </div>
          </div>
        </div>

        <div className="card flow-side-card">
          <div className="card-title">
            Loss &amp; {classify ? 'accuracy' : 'R²'} <span className="muted small">— train (solid) vs. validation (dashed)</span>
          </div>
          <LossChart
            loss={metrics.lossHistory}
            acc={metrics.trainScoreHistory}
            valLoss={metrics.valLossHistory}
            valAcc={metrics.valScoreHistory}
            accLabel={classify ? 'accuracy' : 'R²'}
            width={620}
            height={200}
          />
        </div>

        <div className="card explain-card">
          <div className="card-title">What you're looking at</div>
          <p className="muted small">
            A <b>Kolmogorov–Arnold Network</b> moves the nonlinearity from the nodes to the edges: every
            connection carries a learned 1-D function φ(x) — here a SiLU base plus a <b>B-spline</b> — and a node
            just sums what arrives. The Kolmogorov–Arnold representation theorem says any multivariate continuous
            function is a finite composition of such 1-D functions, so even a tiny KAN is expressive, and you can
            literally read its computation off the diagram. The whole layer is one fused autograd op whose
            backward differentiates the output w.r.t. the base weights, every spline coefficient, <em>and the
            input</em> (the chain rule through B′(x)) — all hand-derived and gradchecked in the engine self-test.
            Because the spline coefficients can be re-solved onto a different knot vector, a trained KAN can be
            <b> refined</b> (×2 grid) or <b>re-centred</b> onto its data without forgetting — try it while it trains.
          </p>
        </div>
      </main>
    </div>
  );
}
