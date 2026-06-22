import { useEffect, useMemo, useState } from 'react';
import { useGNNTrainer, type GNNConfigUI } from '../../hooks/useGNNTrainer';
import { GRAPH_DATASETS } from '../../engine/graph-data';
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
  GNN_SLOT_PREFIX,
} from '../../engine/serialize';
import { GRAPH_CLASS_COLORS, rgbCss } from '../../lib/colors';
import GNNPanel from './GNNPanel';
import GraphView from './GraphView';
import EmbeddingView from './EmbeddingView';
import MetricsChart from './MetricsChart';

const HASH_KEY = 'n';

const GNN_INITIAL: GNNConfigUI = {
  dataset: 'sbm',
  nodes: 90,
  communities: 3,
  pIn: 0.22,
  pOut: 0.02,
  knnK: 6,
  featDim: 8,
  signal: 0.35,
  noise: 1.0,
  seed: 1,
  conv: 'gcn',
  hiddenDim: 16,
  hiddenLayers: 1,
  heads: 4,
  activation: 'relu',
  dropout: 0.3,
  labelsPerClass: 4,
  valFraction: 0.2,
  useGraph: true,
  optimizer: 'adam',
  lr: 0.01,
  weightDecay: 0.0005,
  clipNorm: 2,
  stepsPerFrame: 2,
  loadId: 0,
};

function sanitize(raw: unknown): GNNConfigUI {
  const c = (raw ?? {}) as Partial<GNNConfigUI>;
  const dataset = GRAPH_DATASETS.some((d) => d.id === c.dataset) ? (c.dataset as GNNConfigUI['dataset']) : GNN_INITIAL.dataset;
  return {
    ...GNN_INITIAL,
    ...c,
    dataset,
    conv: c.conv === 'sage' || c.conv === 'gat' ? c.conv : 'gcn',
    nodes: Math.max(24, Math.min(200, Math.round(Number(c.nodes) || GNN_INITIAL.nodes))),
    communities: Math.max(2, Math.min(6, Math.round(Number(c.communities) || GNN_INITIAL.communities))),
    labelsPerClass: Math.max(1, Math.min(20, Math.round(Number(c.labelsPerClass) || GNN_INITIAL.labelsPerClass))),
  };
}

export default function GNNLab() {
  const [config, setConfig] = useState<GNNConfigUI>(GNN_INITIAL);
  const [gradResult, setGradResult] = useState<GradCheckResult | null>(null);
  const [slots, setSlots] = useState<string[]>(() => listSlots(GNN_SLOT_PREFIX));
  const [shareMsg, setShareMsg] = useState<string | null>(null);
  const [showAttention, setShowAttention] = useState(true);

  const {
    running,
    tick,
    metrics,
    handle,
    start,
    pause,
    reset,
    stepOnce,
    runGradCheck,
    nodeView,
    snapshot,
    prepareLoad,
  } = useGNNTrainer(config);

  // Restore a shared experiment from the URL hash (#n=…) on first load.
  useEffect(() => {
    const st = readHashState<GNNConfigUI>(HASH_KEY);
    if (st && Array.isArray(st.weights)) {
      prepareLoad(st.weights, st.step ?? 0);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setConfig({ ...sanitize(st.config), loadId: 1 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Recompute the node view each tick (a fresh eval-mode forward); `tick` is the intended trigger.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const view = useMemo(() => nodeView(), [nodeView, tick]);

  const doGradCheck = () => setGradResult(runGradCheck());
  const flashShare = (msg: string) => {
    setShareMsg(msg);
    window.setTimeout(() => setShareMsg(null), 2200);
  };
  const onSave = (name: string) => {
    const { weights, step } = snapshot();
    if (saveSlot(name, makeState(config, weights, step), GNN_SLOT_PREFIX)) setSlots(listSlots(GNN_SLOT_PREFIX));
  };
  const onLoadSlot = (name: string) => {
    const st = loadSlot<GNNConfigUI>(name, GNN_SLOT_PREFIX);
    if (!st) return;
    prepareLoad(st.weights, st.step ?? 0);
    setConfig((c) => ({ ...sanitize(st.config), loadId: c.loadId + 1 }));
  };
  const onDeleteSlot = (name: string) => {
    deleteSlot(name, GNN_SLOT_PREFIX);
    setSlots(listSlots(GNN_SLOT_PREFIX));
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
  const ds = handle.data;

  return (
    <div className="lab">
      <GNNPanel
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
        <div className="card graph-card">
          <div className="card-title">
            Node classification on the graph
            <span className="muted small"> — fill = predicted class, ring = true class; haloed nodes are the few labeled ones</span>
            {config.conv === 'gat' && (
              <span className="flow-toggles">
                <label className="toggle">
                  <input type="checkbox" checked={showAttention} onChange={(e) => setShowAttention(e.target.checked)} /> attention
                </label>
              </span>
            )}
          </div>
          <div className="graph-hero">
            <GraphView view={view} tick={tick} size={460} showAttention={showAttention} />
          </div>
          {ds && (
            <div className="legend-row">
              {ds.classNames.map((nm, c) => (
                <span className="legend-item" key={c}>
                  <span className="swatch" style={{ background: rgbCss(GRAPH_CLASS_COLORS[c % GRAPH_CLASS_COLORS.length]) }} /> {nm}
                </span>
              ))}
              <span className="legend-item muted small">
                {ds.n} nodes · {ds.edges.length} edges · {view ? `${(view.density * 100).toFixed(1)}%` : '—'} density
              </span>
            </div>
          )}
        </div>

        <div className="stage-row">
          <div className="card flow-side-card">
            <div className="card-title">
              Learned embeddings (PCA)
              <span className="muted small"> — the penultimate layer untangling the classes</span>
            </div>
            <EmbeddingView view={view} tick={tick} size={300} />
          </div>
          <div className="card flow-side-card">
            <div className="card-title">
              Accuracy <span className="muted small">— train / val / held-out test nodes</span>
            </div>
            <MetricsChart
              train={metrics.trainAccHistory}
              val={metrics.valAccHistory}
              test={metrics.testAccHistory}
              width={300}
              height={210}
            />
            <div className="acc-readout">
              <div>
                <span className="muted small">train</span>
                <b>{Number.isFinite(metrics.trainAcc) ? `${(metrics.trainAcc * 100).toFixed(1)}%` : '—'}</b>
              </div>
              <div>
                <span className="muted small">val</span>
                <b>{Number.isFinite(metrics.valAcc) ? `${(metrics.valAcc * 100).toFixed(1)}%` : '—'}</b>
              </div>
              <div>
                <span className="muted small">test</span>
                <b className="accent">{Number.isFinite(metrics.testAcc) ? `${(metrics.testAcc * 100).toFixed(1)}%` : '—'}</b>
              </div>
            </div>
          </div>
        </div>

        <div className="card explain-card">
          <div className="card-title">What you're looking at</div>
          <p className="muted small">
            A from-scratch graph neural network does <b>semi-supervised node classification</b>: only a handful of nodes per class are
            labeled (the haloed ones), yet the network labels the whole graph by passing messages along edges — each layer mixes every
            node's vector with its neighbors' (<b>GCN</b> uses the symmetric-normalized adjacency Â=D̃<sup>-½</sup>(A+I)D̃<sup>-½</sup>,
            <b> SAGE</b> a mean aggregator, <b>GAT</b> learned multi-head attention). Because the features are deliberately a weak signal,
            turning <b>“Use the graph” off</b> collapses the model to a per-node MLP that flounders near chance — the gap to the test
            accuracy with it on is exactly the structure the graph contributes. Every gradient is hand-derived and gradchecked in the
            engine self-test.
          </p>
        </div>
      </main>
    </div>
  );
}
