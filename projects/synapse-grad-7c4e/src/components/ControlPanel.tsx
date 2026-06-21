import type { Dispatch, SetStateAction } from 'react';
import type { TrainerConfig, TrainerMetrics } from '../hooks/useTrainer';
import type { Activation } from '../engine/nn';
import type { GradCheckResult } from '../engine/gradcheck';
import { CLASS_DATASETS, REGRESSION_DATASETS } from '../engine/data';
import type { OptimizerKind } from '../engine/optim';

interface Props {
  config: TrainerConfig;
  setConfig: Dispatch<SetStateAction<TrainerConfig>>;
  running: boolean;
  onStart: () => void;
  onPause: () => void;
  onReset: () => void;
  onStep: () => void;
  onGradCheck: () => void;
  gradResult: GradCheckResult | null;
  metrics: TrainerMetrics;
  paramCount: number;
}

const ACTS: Activation[] = ['relu', 'tanh', 'sigmoid'];
const OPTS: OptimizerKind[] = ['sgd', 'momentum', 'rmsprop', 'adam'];
const LRS = [0.001, 0.003, 0.01, 0.03, 0.1, 0.3];
const WDS = [0, 0.0001, 0.001, 0.01];
const BATCHES = [10, 20, 30, 50, 100];
const SPEEDS = [1, 2, 4, 8];

export default function ControlPanel({
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
}: Props) {
  const set = <K extends keyof TrainerConfig>(key: K, value: TrainerConfig[K]) =>
    setConfig((c) => ({ ...c, [key]: value }));

  const setLayer = (i: number, patch: Partial<{ units: number; activation: Activation }>) =>
    setConfig((c) => ({
      ...c,
      hidden: c.hidden.map((l, j) => (j === i ? { ...l, ...patch } : l)),
    }));

  const addLayer = () =>
    setConfig((c) => (c.hidden.length >= 4 ? c : { ...c, hidden: [...c.hidden, { units: 6, activation: 'tanh' }] }));

  const removeLayer = (i: number) =>
    setConfig((c) => (c.hidden.length <= 1 ? c : { ...c, hidden: c.hidden.filter((_, j) => j !== i) }));

  const datasets = config.mode === 'classification' ? CLASS_DATASETS : REGRESSION_DATASETS;

  return (
    <aside className="panel">
      <section className="group">
        <h3>Task</h3>
        <div className="seg">
          <button className={config.mode === 'classification' ? 'on' : ''} onClick={() => set('mode', 'classification')}>
            Classification
          </button>
          <button className={config.mode === 'regression' ? 'on' : ''} onClick={() => set('mode', 'regression')}>
            Regression
          </button>
        </div>
        <label className="field">
          <span>Dataset</span>
          <select
            value={config.mode === 'classification' ? config.classKind : config.regKind}
            onChange={(e) =>
              config.mode === 'classification'
                ? set('classKind', e.target.value as TrainerConfig['classKind'])
                : set('regKind', e.target.value as TrainerConfig['regKind'])
            }
          >
            {datasets.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Samples · {config.samples}</span>
          <input
            type="range"
            min={60}
            max={600}
            step={20}
            value={config.samples}
            onChange={(e) => set('samples', Number(e.target.value))}
          />
        </label>
        <label className="field">
          <span>Noise · {config.noise.toFixed(2)}</span>
          <input
            type="range"
            min={0}
            max={0.5}
            step={0.02}
            value={config.noise}
            onChange={(e) => set('noise', Number(e.target.value))}
          />
        </label>
        <button className="ghost wide" onClick={() => set('seed', (config.seed + 1) % 100000)}>
          ⟳ Resample data &amp; weights
        </button>
      </section>

      <section className="group">
        <h3>
          Network <span className="muted small">· {paramCount} params</span>
        </h3>
        {config.hidden.map((layer, i) => (
          <div className="layer-row" key={i}>
            <div className="layer-head">
              <span className="muted small">Layer {i + 1}</span>
              <button className="x" onClick={() => removeLayer(i)} disabled={config.hidden.length <= 1} title="Remove layer">
                ×
              </button>
            </div>
            <div className="layer-ctrls">
              <div className="stepper">
                <button onClick={() => setLayer(i, { units: Math.max(1, layer.units - 1) })}>−</button>
                <span>{layer.units}</span>
                <button onClick={() => setLayer(i, { units: Math.min(16, layer.units + 1) })}>+</button>
              </div>
              <select value={layer.activation} onChange={(e) => setLayer(i, { activation: e.target.value as Activation })}>
                {ACTS.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </div>
          </div>
        ))}
        <button className="ghost wide" onClick={addLayer} disabled={config.hidden.length >= 4}>
          + Add hidden layer
        </button>
      </section>

      <section className="group">
        <h3>Optimizer</h3>
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
        <label className="field">
          <span>L2 weight decay</span>
          <select value={config.weightDecay} onChange={(e) => set('weightDecay', Number(e.target.value))}>
            {WDS.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <div className="two">
          <label className="field">
            <span>Batch</span>
            <select value={config.batchSize} onChange={(e) => set('batchSize', Number(e.target.value))}>
              {BATCHES.map((v) => (
                <option key={v} value={v}>
                  {v}
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
            <b>{Number.isFinite(metrics.loss) ? metrics.loss.toFixed(4) : '—'}</b>
          </div>
          <div className="stat">
            <span className="muted small">{config.mode === 'classification' ? 'acc' : 'R²'}</span>
            <b>
              {Number.isFinite(metrics.acc)
                ? config.mode === 'classification'
                  ? `${(metrics.acc * 100).toFixed(1)}%`
                  : metrics.acc.toFixed(3)
                : '—'}
            </b>
          </div>
        </div>
      </section>

      <section className="group">
        <h3>Gradient check</h3>
        <p className="muted small">
          Finite differences vs. the analytic backward pass — the engine&apos;s self-test.
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
            <div className="muted small">
              {gradResult.maxRelError < 1e-3 ? '✓ gradients verified' : '⚠ check ReLU kinks / lr'}
            </div>
          </div>
        )}
      </section>
    </aside>
  );
}
