import { type Dispatch, type SetStateAction } from 'react';
import type { GPConfigUI, GPMetrics } from '../../hooks/useGPTrainer';
import type { GradCheckResult } from '../../engine/gradcheck';
import type { OptimizerKind } from '../../engine/optim';
import { GP_KERNELS, GP_DATASETS, type KernelKind } from '../../engine/gp';
import SelfTestPanel from '../SelfTestPanel';

interface Props {
  config: GPConfigUI;
  setConfig: Dispatch<SetStateAction<GPConfigUI>>;
  metrics: GPMetrics;
  running: boolean;
  pointCount: number;
  onStart: () => void;
  onPause: () => void;
  onReset: () => void;
  onStep: () => void;
  onGradCheck: () => void;
  gradResult: GradCheckResult | null;
  setHyper: (name: 'ell' | 'sf' | 'sn', logVal: number) => void;
  onClearPoints: () => void;
  onResetPoints: () => void;
  onShare: () => void;
  shareMsg: string | null;
}

const OPTS: OptimizerKind[] = ['adam', 'adamw', 'rmsprop', 'nesterov', 'momentum', 'sgd'];
const LRS = [0.01, 0.02, 0.05, 0.1, 0.2];
const SPEEDS = [1, 2, 4, 8];

export default function GPPanel({
  config,
  setConfig,
  metrics,
  running,
  pointCount,
  onStart,
  onPause,
  onReset,
  onStep,
  onGradCheck,
  gradResult,
  setHyper,
  onClearPoints,
  onResetPoints,
  onShare,
  shareMsg,
}: Props) {
  const set = <K extends keyof GPConfigUI>(key: K, value: GPConfigUI[K]) => setConfig((c) => ({ ...c, [key]: value }));
  const kernel = GP_KERNELS.find((k) => k.id === config.kind)!;
  const h = metrics.hyper;

  return (
    <aside className="panel">
      <section className="group">
        <h3>Data</h3>
        <label className="field">
          <span>Dataset</span>
          <select value={config.dataset} onChange={(e) => set('dataset', e.target.value as GPConfigUI['dataset'])}>
            {GP_DATASETS.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        <div className="two">
          <button className="ghost" onClick={onResetPoints}>
            ⟲ Reset points
          </button>
          <button className="ghost" onClick={onClearPoints}>
            Clear ({pointCount})
          </button>
        </div>
        <button className="ghost wide" onClick={() => set('seed', (config.seed + 1) % 100000)}>
          ⟳ Resample dataset
        </button>
        <p className="muted small">Click the plot to add a point, right-click one to remove it.</p>
      </section>

      <section className="group">
        <h3>Kernel</h3>
        <label className="field">
          <span>Covariance function</span>
          <select value={config.kind} onChange={(e) => set('kind', e.target.value as KernelKind)}>
            {GP_KERNELS.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </select>
        </label>
        <p className="muted small arch-desc">{kernel.blurb}</p>
        {kernel.shape === 'alpha' && (
          <label className="field">
            <span>α (scale mixture) · {config.alpha.toFixed(1)}</span>
            <input type="range" min={0.2} max={8} step={0.2} value={config.alpha} onChange={(e) => set('alpha', Number(e.target.value))} />
          </label>
        )}
        {kernel.shape === 'period' && (
          <label className="field">
            <span>period p · {config.period.toFixed(2)}</span>
            <input type="range" min={0.5} max={6} step={0.05} value={config.period} onChange={(e) => set('period', Number(e.target.value))} />
          </label>
        )}
      </section>

      <section className="group">
        <h3>Hyperparameters</h3>
        <p className="muted small">
          Drag to set by hand, or tick <b>learn</b> and hit Train to have them climb the marginal likelihood by
          gradient ascent — straight through the Cholesky.
        </p>
        <HyperSlider
          label="lengthscale ℓ"
          value={h.logEll}
          derived={h.ell}
          min={-3}
          max={3}
          learn={!config.lockEll}
          onLearn={(v) => set('lockEll', !v)}
          onChange={(v) => setHyper('ell', v)}
        />
        <HyperSlider
          label="signal σ_f"
          value={h.logSf}
          derived={h.sf}
          min={-3}
          max={2}
          learn={!config.lockSf}
          onLearn={(v) => set('lockSf', !v)}
          onChange={(v) => setHyper('sf', v)}
        />
        <HyperSlider
          label="noise σ_n"
          value={h.logSn}
          derived={h.sn}
          min={-6}
          max={1}
          learn={!config.lockSn}
          onLearn={(v) => set('lockSn', !v)}
          onChange={(v) => setHyper('sn', v)}
        />
      </section>

      <section className="group">
        <h3>Optimizer (over hyperparameters)</h3>
        <div className="two">
          <label className="field">
            <span>Algorithm</span>
            <select value={config.optimizer} onChange={(e) => set('optimizer', e.target.value as OptimizerKind)}>
              {OPTS.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </label>
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
        </div>
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
      </section>

      <section className="group">
        <h3>Views</h3>
        <label className="checkline">
          <input type="checkbox" checked={config.showSamples} onChange={(e) => set('showSamples', e.target.checked)} /> posterior
          function samples
        </label>
        <label className="checkline">
          <input type="checkbox" checked={config.showPredictive} onChange={(e) => set('showPredictive', e.target.checked)} /> predictive
          band (+ noise)
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
            <button className="primary" onClick={onStart} disabled={pointCount === 0}>
              ▶ Train
            </button>
          )}
          <button className="ghost" onClick={onStep} disabled={running || pointCount === 0}>
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
            <span className="muted small">log ML</span>
            <b>{Number.isFinite(metrics.lml) ? metrics.lml.toFixed(3) : '—'}</b>
          </div>
          <div className="stat">
            <span className="muted small">‖grad‖</span>
            <b>{Number.isFinite(metrics.gradNorm) ? metrics.gradNorm.toFixed(3) : '—'}</b>
          </div>
        </div>
      </section>

      <section className="group">
        <h3>Gradient check</h3>
        <p className="muted small">
          Finite differences vs. the analytic ∂NLL/∂θ back-propagated through the Cholesky (K̄ = ½(K⁻¹ − ααᵀ)),
          evaluated at a fixed off-optimum reference (where the gradient is non-trivial).
        </p>
        <button className="ghost wide" onClick={onGradCheck} disabled={pointCount === 0}>
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
            <div className="muted small">{gradResult.maxRelError < 1e-3 ? '✓ Cholesky VJP verified' : '⚠ check setup'}</div>
          </div>
        )}
      </section>

      <section className="group">
        <h3>Engine self-test</h3>
        <p className="muted small">Gradcheck every op — now including the GP marginal likelihood through the Cholesky factorization.</p>
        <SelfTestPanel />
      </section>

      <section className="group">
        <h3>Share</h3>
        <button className="ghost wide" onClick={onShare}>
          🔗 Copy shareable link
        </button>
        {shareMsg && <div className="share-msg">{shareMsg}</div>}
      </section>
    </aside>
  );
}

function HyperSlider({
  label,
  value,
  derived,
  min,
  max,
  learn,
  onLearn,
  onChange,
}: {
  label: string;
  value: number;
  derived: number;
  min: number;
  max: number;
  learn: boolean;
  onLearn: (v: boolean) => void;
  onChange: (v: number) => void;
}) {
  return (
    <div className="gp-hyper">
      <div className="gp-hyper-head">
        <span>
          {label} <b>{derived < 0.01 || derived >= 100 ? derived.toExponential(1) : derived.toFixed(3)}</b>
        </span>
        <label className="gp-learn">
          <input type="checkbox" checked={learn} onChange={(e) => onLearn(e.target.checked)} /> learn
        </label>
      </div>
      <input type="range" min={min} max={max} step={0.02} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}
