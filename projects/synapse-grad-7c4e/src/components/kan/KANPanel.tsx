import { useState, type Dispatch, type SetStateAction } from 'react';
import type { KANConfigUI, KANMetrics } from '../../hooks/useKANTrainer';
import type { GradCheckResult } from '../../engine/gradcheck';
import type { OptimizerKind } from '../../engine/optim';
import { CLASS_DATASETS, REGRESSION_DATASETS } from '../../engine/data';
import SelfTestPanel from '../SelfTestPanel';

interface Props {
  config: KANConfigUI;
  setConfig: Dispatch<SetStateAction<KANConfigUI>>;
  running: boolean;
  onStart: () => void;
  onPause: () => void;
  onReset: () => void;
  onStep: () => void;
  onGradCheck: () => void;
  onRefineGrid: () => void;
  onFitGrid: () => void;
  gradResult: GradCheckResult | null;
  metrics: KANMetrics;
  paramCount: number;
  slots: string[];
  onSave: (name: string) => void;
  onLoadSlot: (name: string) => void;
  onDeleteSlot: (name: string) => void;
  onShare: () => void;
  shareMsg: string | null;
}

const OPTS: OptimizerKind[] = ['adam', 'adamw', 'rmsprop', 'nesterov', 'momentum', 'sgd'];
const LRS = [0.005, 0.01, 0.02, 0.05, 0.1];
const WDS = [0, 0.0001, 0.0005, 0.001];
const DIMS = [2, 3, 4, 5, 6, 8];
const SPEEDS = [1, 2, 4, 8];
const CLIPS = [0, 1, 2, 5];
const DEGREES = [
  { v: 1, label: 'linear' },
  { v: 2, label: 'quadratic' },
  { v: 3, label: 'cubic' },
];

export default function KANPanel({
  config,
  setConfig,
  running,
  onStart,
  onPause,
  onReset,
  onStep,
  onGradCheck,
  onRefineGrid,
  onFitGrid,
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
  const [slotName, setSlotName] = useState('kan-1');
  const set = <K extends keyof KANConfigUI>(key: K, value: KANConfigUI[K]) => setConfig((c) => ({ ...c, [key]: value }));
  const classify = config.task === 'classify';

  return (
    <aside className="panel">
      <section className="group">
        <h3>Task</h3>
        <div className="seg" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <button className={classify ? 'on' : ''} onClick={() => set('task', 'classify')}>
            Classify (2-D)
          </button>
          <button className={!classify ? 'on' : ''} onClick={() => set('task', 'regress')}>
            Regress (1-D)
          </button>
        </div>
        <label className="field">
          <span>Dataset</span>
          {classify ? (
            <select value={config.classDataset} onChange={(e) => set('classDataset', e.target.value as KANConfigUI['classDataset'])}>
              {CLASS_DATASETS.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
          ) : (
            <select value={config.regDataset} onChange={(e) => set('regDataset', e.target.value as KANConfigUI['regDataset'])}>
              {REGRESSION_DATASETS.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
          )}
        </label>
        <div className="two">
          <label className="field">
            <span>Samples · {config.n}</span>
            <input type="range" min={60} max={600} step={20} value={config.n} onChange={(e) => set('n', Number(e.target.value))} />
          </label>
          <label className="field">
            <span>Noise · {config.noise.toFixed(2)}</span>
            <input type="range" min={0} max={0.6} step={0.02} value={config.noise} onChange={(e) => set('noise', Number(e.target.value))} />
          </label>
        </div>
        <button className="ghost wide" onClick={() => set('seed', (config.seed + 1) % 100000)}>
          ⟳ Resample data &amp; weights
        </button>
      </section>

      <section className="group">
        <h3>
          KAN architecture <span className="muted small">· {paramCount} params</span>
        </h3>
        <div className="two">
          <label className="field">
            <span>Hidden layers · {config.hiddenLayers}</span>
            <input type="range" min={0} max={3} step={1} value={config.hiddenLayers} onChange={(e) => set('hiddenLayers', Number(e.target.value))} />
          </label>
          <label className="field">
            <span>Hidden width</span>
            <select value={config.hiddenDim} onChange={(e) => set('hiddenDim', Number(e.target.value))}>
              {DIMS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="muted small">
          Each edge is a learned function φ(x) = w·silu(x) + spline(x). Zero hidden layers is a single
          Kolmogorov–Arnold layer — already a universal 1-D function fitter.
        </p>
      </section>

      <section className="group">
        <h3>Spline grid</h3>
        <div className="two">
          <label className="field">
            <span>Initial grid G · {config.gridSize}</span>
            <input type="range" min={3} max={20} step={1} value={config.gridSize} onChange={(e) => set('gridSize', Number(e.target.value))} />
          </label>
          <label className="field">
            <span>Spline order</span>
            <select value={config.degree} onChange={(e) => set('degree', Number(e.target.value))}>
              {DEGREES.map((d) => (
                <option key={d.v} value={d.v}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="field">
          <span>Domain · ±{config.domain.toFixed(1)}</span>
          <input type="range" min={1} max={3} step={0.1} value={config.domain} onChange={(e) => set('domain', Number(e.target.value))} />
        </label>
        <p className="muted small">
          Live grid {metrics.gridSize}. Refine doubles the spline resolution while <b>preserving</b> the
          learned curves (the KAN superpower); fit re-centres each layer's grid onto its real activation range.
        </p>
        <div className="run-row">
          <button className="ghost" onClick={onRefineGrid} title="Re-solve coefficients onto a 2× finer grid, preserving φ">
            ×2 grid (keep φ)
          </button>
          <button className="ghost" onClick={onFitGrid} title="Re-centre each layer's grid onto its activation range">
            fit grid → data
          </button>
        </div>
      </section>

      <section className="group">
        <h3>Training</h3>
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
        <label className="field">
          <span>Val split · {(config.valFraction * 100).toFixed(0)}%</span>
          <input type="range" min={0} max={0.4} step={0.05} value={config.valFraction} onChange={(e) => set('valFraction', Number(e.target.value))} />
        </label>
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
            <span className="muted small">{classify ? 'val acc' : 'val R²'}</span>
            <b>{Number.isFinite(metrics.valScore) ? (classify ? `${(metrics.valScore * 100).toFixed(1)}%` : metrics.valScore.toFixed(3)) : '—'}</b>
          </div>
          <div className="stat">
            <span className="muted small">‖grad‖</span>
            <b>{Number.isFinite(metrics.gradNorm) ? metrics.gradNorm.toFixed(2) : '—'}</b>
          </div>
        </div>
      </section>

      <section className="group">
        <h3>Gradient check</h3>
        <p className="muted small">
          Finite differences vs. the analytic backward through every spline edge — including the chain rule
          through B′(x) that lets layers stack.
        </p>
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
            <div className="muted small">{gradResult.maxRelError < 1e-3 ? '✓ spline gradients verified' : '⚠ check setup'}</div>
          </div>
        )}
      </section>

      <section className="group">
        <h3>Engine self-test</h3>
        <p className="muted small">Gradcheck every op — now including the fused KAN B-spline layer end-to-end.</p>
        <SelfTestPanel />
      </section>

      <section className="group">
        <h3>Save &amp; share</h3>
        <div className="save-row">
          <input className="slot-input" value={slotName} onChange={(e) => setSlotName(e.target.value)} placeholder="slot name" />
          <button className="ghost" onClick={() => onSave(slotName.trim() || 'kan')}>
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
