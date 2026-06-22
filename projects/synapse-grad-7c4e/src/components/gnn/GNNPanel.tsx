import { useState, type Dispatch, type SetStateAction } from 'react';
import type { GNNConfigUI, GNNMetrics } from '../../hooks/useGNNTrainer';
import type { GradCheckResult } from '../../engine/gradcheck';
import type { OptimizerKind } from '../../engine/optim';
import type { ConvKind } from '../../engine/gnn';
import type { Activation } from '../../engine/nn';
import { GRAPH_DATASETS } from '../../engine/graph-data';
import SelfTestPanel from '../SelfTestPanel';

interface Props {
  config: GNNConfigUI;
  setConfig: Dispatch<SetStateAction<GNNConfigUI>>;
  running: boolean;
  onStart: () => void;
  onPause: () => void;
  onReset: () => void;
  onStep: () => void;
  onGradCheck: () => void;
  gradResult: GradCheckResult | null;
  metrics: GNNMetrics;
  paramCount: number;
  slots: string[];
  onSave: (name: string) => void;
  onLoadSlot: (name: string) => void;
  onDeleteSlot: (name: string) => void;
  onShare: () => void;
  shareMsg: string | null;
}

const CONVS: { id: ConvKind; label: string }[] = [
  { id: 'gcn', label: 'GCN' },
  { id: 'sage', label: 'SAGE' },
  { id: 'gat', label: 'GAT' },
];
const OPTS: OptimizerKind[] = ['adam', 'adamw', 'rmsprop', 'nesterov', 'momentum', 'sgd'];
const ACTS: Activation[] = ['relu', 'elu', 'gelu', 'silu', 'tanh', 'leaky_relu'];
const LRS = [0.002, 0.005, 0.01, 0.02, 0.05];
const WDS = [0, 0.0005, 0.001, 0.005];
const DIMS = [4, 8, 16, 24, 32];
const HEADS = [1, 2, 4, 8];
const SPEEDS = [1, 2, 4, 8];
const CLIPS = [0, 1, 2, 5];

export default function GNNPanel({
  config,
  setConfig,
  running,
  onStart,
  onPause,
  onReset,
  onStep,
  onGradCheck,
  gradResult,
  metrics,
  paramCount,
  slots,
  onSave,
  onLoadSlot,
  onDeleteSlot,
  onShare,
  shareMsg,
}: Props) {
  const [slotName, setSlotName] = useState('graph-1');
  const set = <K extends keyof GNNConfigUI>(key: K, value: GNNConfigUI[K]) => setConfig((c) => ({ ...c, [key]: value }));
  const isSBM = config.dataset === 'sbm';
  const isKarate = config.dataset === 'karate';
  const isKnn = config.dataset.startsWith('knn');
  const multiClass = isSBM || config.dataset === 'knn-circles' || config.dataset === 'knn-blobs' || config.dataset === 'knn-spirals';

  return (
    <aside className="panel">
      <section className="group">
        <h3>Graph</h3>
        <label className="field">
          <span>Dataset</span>
          <select value={config.dataset} onChange={(e) => set('dataset', e.target.value as GNNConfigUI['dataset'])}>
            {GRAPH_DATASETS.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        {!isKarate && (
          <label className="field">
            <span>Nodes · {config.nodes}</span>
            <input type="range" min={24} max={200} step={4} value={config.nodes} onChange={(e) => set('nodes', Number(e.target.value))} />
          </label>
        )}
        {multiClass && (
          <label className="field">
            <span>Classes · {config.communities}</span>
            <input type="range" min={2} max={6} step={1} value={config.communities} onChange={(e) => set('communities', Number(e.target.value))} />
          </label>
        )}
        {isSBM && (
          <div className="two">
            <label className="field">
              <span>p(in) · {config.pIn.toFixed(2)}</span>
              <input type="range" min={0.05} max={0.5} step={0.01} value={config.pIn} onChange={(e) => set('pIn', Number(e.target.value))} />
            </label>
            <label className="field">
              <span>p(out) · {config.pOut.toFixed(3)}</span>
              <input type="range" min={0} max={0.1} step={0.005} value={config.pOut} onChange={(e) => set('pOut', Number(e.target.value))} />
            </label>
          </div>
        )}
        {isKnn && (
          <label className="field">
            <span>k neighbors · {config.knnK}</span>
            <input type="range" min={2} max={12} step={1} value={config.knnK} onChange={(e) => set('knnK', Number(e.target.value))} />
          </label>
        )}
        <button className="ghost wide" onClick={() => set('seed', (config.seed + 1) % 100000)}>
          ⟳ Resample graph &amp; weights
        </button>
      </section>

      <section className="group">
        <h3>Node features</h3>
        <p className="muted small">
          Features are a weak class signal in noise — too weak to classify alone, so the network must lean on the edges.
        </p>
        <div className="two">
          <label className="field">
            <span>Signal · {config.signal.toFixed(2)}</span>
            <input type="range" min={0} max={1.2} step={0.05} value={config.signal} onChange={(e) => set('signal', Number(e.target.value))} />
          </label>
          <label className="field">
            <span>Noise · {config.noise.toFixed(2)}</span>
            <input type="range" min={0.1} max={2} step={0.1} value={config.noise} onChange={(e) => set('noise', Number(e.target.value))} />
          </label>
        </div>
        <label className="field">
          <span>Feature dim · {config.featDim}</span>
          <input type="range" min={2} max={16} step={1} value={config.featDim} onChange={(e) => set('featDim', Number(e.target.value))} />
        </label>
      </section>

      <section className="group">
        <h3>
          Network <span className="muted small">· {paramCount} params</span>
        </h3>
        <label className="field">
          <span>Convolution</span>
        </label>
        <div className="seg" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
          {CONVS.map((c) => (
            <button key={c.id} className={config.conv === c.id ? 'on' : ''} onClick={() => set('conv', c.id)}>
              {c.label}
            </button>
          ))}
        </div>
        <div className="two">
          <label className="field">
            <span>Hidden dim</span>
            <select value={config.hiddenDim} onChange={(e) => set('hiddenDim', Number(e.target.value))}>
              {DIMS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Conv layers · {config.hiddenLayers + 1}</span>
            <input type="range" min={1} max={4} step={1} value={config.hiddenLayers} onChange={(e) => set('hiddenLayers', Number(e.target.value))} />
          </label>
        </div>
        {config.conv === 'gat' && (
          <label className="field">
            <span>Attention heads</span>
            <select value={config.heads} onChange={(e) => set('heads', Number(e.target.value))}>
              {HEADS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="two">
          <label className="field">
            <span>Activation</span>
            <select value={config.activation} onChange={(e) => set('activation', e.target.value as Activation)}>
              {ACTS.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Dropout · {config.dropout.toFixed(2)}</span>
            <input type="range" min={0} max={0.7} step={0.05} value={config.dropout} onChange={(e) => set('dropout', Number(e.target.value))} />
          </label>
        </div>
        <label className="toggle big-toggle">
          <input type="checkbox" checked={config.useGraph} onChange={(e) => set('useGraph', e.target.checked)} />
          <span>
            Use the graph <span className="muted small">— off ⇒ message passing disabled (a plain per-node MLP baseline)</span>
          </span>
        </label>
      </section>

      <section className="group">
        <h3>Semi-supervised training</h3>
        <div className="two">
          <label className="field">
            <span>Labels / class · {config.labelsPerClass}</span>
            <input type="range" min={1} max={20} step={1} value={config.labelsPerClass} onChange={(e) => set('labelsPerClass', Number(e.target.value))} />
          </label>
          <label className="field">
            <span>Val split · {(config.valFraction * 100).toFixed(0)}%</span>
            <input type="range" min={0} max={0.4} step={0.05} value={config.valFraction} onChange={(e) => set('valFraction', Number(e.target.value))} />
          </label>
        </div>
        <label className="field">
          <span>Optimizer</span>
          <select value={config.optimizer} onChange={(e) => set('optimizer', e.target.value as OptimizerKind)}>
            {OPTS.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </label>
        <div className="two">
          <label className="field">
            <span>Learning rate</span>
            <select value={config.lr} onChange={(e) => set('lr', Number(e.target.value))}>
              {LRS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Weight decay</span>
            <select value={config.weightDecay} onChange={(e) => set('weightDecay', Number(e.target.value))}>
              {WDS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="two">
          <label className="field">
            <span>Grad clip</span>
            <select value={config.clipNorm} onChange={(e) => set('clipNorm', Number(e.target.value))}>
              {CLIPS.map((v) => (
                <option key={v} value={v}>
                  {v === 0 ? 'off' : v}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Speed</span>
            <select value={config.stepsPerFrame} onChange={(e) => set('stepsPerFrame', Number(e.target.value))}>
              {SPEEDS.map((v) => (
                <option key={v} value={v}>
                  {v}×
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      <section className="group">
        <h3>Run</h3>
        <div className="run-row">
          {running ? (
            <button className="primary" onClick={onPause}>
              ❚❚ Pause
            </button>
          ) : (
            <button className="primary" onClick={onStart}>
              ▶ Train
            </button>
          )}
          <button className="ghost" onClick={onStep} disabled={running}>
            Step
          </button>
          <button className="ghost" onClick={onReset}>
            Reset
          </button>
        </div>
        <div className="stat-row">
          <div className="stat">
            <span className="muted small">steps</span>
            <b>{metrics.step}</b>
          </div>
          <div className="stat">
            <span className="muted small">loss</span>
            <b>{Number.isFinite(metrics.loss) ? metrics.loss.toFixed(3) : '—'}</b>
          </div>
          <div className="stat">
            <span className="muted small">test acc</span>
            <b>{Number.isFinite(metrics.testAcc) ? `${(metrics.testAcc * 100).toFixed(1)}%` : '—'}</b>
          </div>
          <div className="stat">
            <span className="muted small">‖grad‖</span>
            <b>{Number.isFinite(metrics.gradNorm) ? metrics.gradNorm.toFixed(2) : '—'}</b>
          </div>
        </div>
      </section>

      <section className="group">
        <h3>Gradient check</h3>
        <p className="muted small">Finite differences vs. the analytic backward through the whole GNN (masked cross-entropy).</p>
        <button className="ghost wide" onClick={onGradCheck}>
          Check gradients
        </button>
        {gradResult && (
          <div className={`gradres ${gradResult.maxRelError < 1e-3 ? 'ok' : 'warn'}`}>
            <div>
              max rel err <b>{gradResult.maxRelError.toExponential(2)}</b>
            </div>
            <div>
              mean <b>{gradResult.meanRelError.toExponential(2)}</b> over {gradResult.checked} entries
            </div>
            <div className="muted small">{gradResult.maxRelError < 1e-3 ? '✓ message passing verified' : '⚠ check setup'}</div>
          </div>
        )}
      </section>

      <section className="group">
        <h3>Engine self-test</h3>
        <p className="muted small">Gradcheck every op — now including a whole GCN, SAGE and multi-head GAT end-to-end.</p>
        <SelfTestPanel />
      </section>

      <section className="group">
        <h3>Save &amp; share</h3>
        <div className="save-row">
          <input className="slot-input" value={slotName} onChange={(e) => setSlotName(e.target.value)} placeholder="slot name" />
          <button className="ghost" onClick={() => onSave(slotName.trim() || 'graph')}>
            Save
          </button>
        </div>
        {slots.length > 0 && (
          <div className="slots">
            {slots.map((name) => (
              <div className="slot" key={name}>
                <span className="slot-name">{name}</span>
                <span className="slot-actions">
                  <button className="link" onClick={() => onLoadSlot(name)}>
                    load
                  </button>
                  <button className="link danger" onClick={() => onDeleteSlot(name)}>
                    delete
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
        <button className="ghost wide" onClick={onShare}>
          🔗 Copy shareable link
        </button>
        {shareMsg && <div className="share-msg">{shareMsg}</div>}
      </section>
    </aside>
  );
}
