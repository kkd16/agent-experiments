import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { TrainerConfig, TrainerMetrics } from '../hooks/useTrainer';
import type { Activation, NormKind } from '../engine/nn';
import type { GradCheckResult } from '../engine/gradcheck';
import { CLASS_DATASETS, REGRESSION_DATASETS } from '../engine/data';
import type { OptimizerKind } from '../engine/optim';
import type { RegLoss } from '../engine/losses';
import type { ScheduleKind } from '../engine/schedule';
import { previewSchedule } from '../engine/schedule';
import SelfTestPanel from './SelfTestPanel';

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
  // persistence
  slots: string[];
  onSave: (name: string) => void;
  onLoadSlot: (name: string) => void;
  onDeleteSlot: (name: string) => void;
  onShare: () => void;
  shareMsg: string | null;
}

const ACTS: Activation[] = ['relu', 'leaky_relu', 'elu', 'gelu', 'silu', 'softplus', 'tanh', 'sigmoid'];
const ACT_LABELS: Record<Activation, string> = {
  relu: 'ReLU',
  leaky_relu: 'LeakyReLU',
  elu: 'ELU',
  gelu: 'GELU',
  silu: 'SiLU',
  softplus: 'Softplus',
  tanh: 'tanh',
  sigmoid: 'sigmoid',
  linear: 'linear',
};
const OPTS: OptimizerKind[] = ['sgd', 'momentum', 'nesterov', 'rmsprop', 'adam', 'adamw'];
const NORMS: { id: NormKind; label: string }[] = [
  { id: 'none', label: 'no norm' },
  { id: 'layer', label: 'LayerNorm' },
  { id: 'batch', label: 'BatchNorm' },
];
const DROPS = [0, 0.1, 0.25, 0.5];
const SCHEDULES: { id: ScheduleKind; label: string }[] = [
  { id: 'constant', label: 'constant' },
  { id: 'step', label: 'step decay' },
  { id: 'cosine', label: 'cosine' },
  { id: 'warmup-cosine', label: 'warmup→cosine' },
];
const CLIPS = [0, 1, 2, 5];
const REG_LOSSES: RegLoss[] = ['mse', 'mae', 'huber'];
const LRS = [0.001, 0.003, 0.01, 0.03, 0.1, 0.3];
const WDS = [0, 0.0001, 0.001, 0.01];
const BATCHES = [10, 20, 30, 50, 100];
const SPEEDS = [1, 2, 4, 8];

// Tiny sparkline used for the schedule shape preview.
function MiniSpark({ data, color }: { data: number[]; color: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    if (data.length < 2) return;
    const max = Math.max(...data, 1e-9);
    const min = Math.min(...data);
    const span = Math.max(max - min, 1e-9);
    ctx.beginPath();
    for (let i = 0; i < data.length; i++) {
      const x = (i / (data.length - 1)) * c.width;
      const y = c.height - ((data[i] - min) / span) * (c.height - 4) - 2;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }, [data, color]);
  return <canvas ref={ref} width={150} height={30} className="mini-spark" />;
}

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
  slots,
  onSave,
  onLoadSlot,
  onDeleteSlot,
  onShare,
  shareMsg,
}: Props) {
  const [slotName, setSlotName] = useState('exp-1');

  const set = <K extends keyof TrainerConfig>(key: K, value: TrainerConfig[K]) =>
    setConfig((c) => ({ ...c, [key]: value }));

  const setLayer = (i: number, patch: Partial<TrainerConfig['hidden'][number]>) =>
    setConfig((c) => ({
      ...c,
      hidden: c.hidden.map((l, j) => (j === i ? { ...l, ...patch } : l)),
    }));

  const addLayer = () =>
    setConfig((c) =>
      c.hidden.length >= 5
        ? c
        : { ...c, hidden: [...c.hidden, { units: 6, activation: 'tanh', norm: 'none', dropout: 0, residual: false }] },
    );

  const removeLayer = (i: number) =>
    setConfig((c) => (c.hidden.length <= 1 ? c : { ...c, hidden: c.hidden.filter((_, j) => j !== i) }));

  const datasets = config.mode === 'classification' ? CLASS_DATASETS : REGRESSION_DATASETS;
  const showScheduleParams = config.scheduleKind !== 'constant';
  const gap = Number.isFinite(metrics.acc) && Number.isFinite(metrics.valAcc) ? metrics.acc - metrics.valAcc : NaN;

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
        <label className="field">
          <span>Validation split · {(config.valFraction * 100).toFixed(0)}%</span>
          <input
            type="range"
            min={0}
            max={0.5}
            step={0.05}
            value={config.valFraction}
            onChange={(e) => set('valFraction', Number(e.target.value))}
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
                <button onClick={() => setLayer(i, { units: Math.min(24, layer.units + 1) })}>+</button>
              </div>
              <select value={layer.activation} onChange={(e) => setLayer(i, { activation: e.target.value as Activation })}>
                {ACTS.map((a) => (
                  <option key={a} value={a}>
                    {ACT_LABELS[a]}
                  </option>
                ))}
              </select>
            </div>
            <div className="layer-ctrls">
              <select
                value={layer.norm ?? 'none'}
                title="Normalization"
                onChange={(e) => setLayer(i, { norm: e.target.value as NormKind })}
              >
                {NORMS.map((nrm) => (
                  <option key={nrm.id} value={nrm.id}>
                    {nrm.label}
                  </option>
                ))}
              </select>
              <select
                value={layer.dropout ?? 0}
                title="Dropout rate"
                onChange={(e) => setLayer(i, { dropout: Number(e.target.value) })}
              >
                {DROPS.map((d) => (
                  <option key={d} value={d}>
                    {d === 0 ? 'no drop' : `drop ${d}`}
                  </option>
                ))}
              </select>
              <button
                className={`chip ${layer.residual ? 'on' : ''}`}
                title="Residual / skip connection (needs matching width)"
                onClick={() => setLayer(i, { residual: !layer.residual })}
              >
                skip
              </button>
            </div>
          </div>
        ))}
        <button className="ghost wide" onClick={addLayer} disabled={config.hidden.length >= 5}>
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
        <label className="field">
          <span>LR schedule</span>
          <select value={config.scheduleKind} onChange={(e) => set('scheduleKind', e.target.value as ScheduleKind)}>
            {SCHEDULES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        {showScheduleParams && (
          <>
            <div className="two">
              <label className="field">
                <span>Period · {config.schedulePeriod}</span>
                <input
                  type="range"
                  min={50}
                  max={1000}
                  step={50}
                  value={config.schedulePeriod}
                  onChange={(e) => set('schedulePeriod', Number(e.target.value))}
                />
              </label>
              <label className="field">
                <span>Warmup · {config.scheduleWarmup}</span>
                <input
                  type="range"
                  min={0}
                  max={300}
                  step={25}
                  value={config.scheduleWarmup}
                  onChange={(e) => set('scheduleWarmup', Number(e.target.value))}
                  disabled={config.scheduleKind !== 'warmup-cosine'}
                />
              </label>
            </div>
            <div className="sched-preview">
              <span className="muted small">lr over {config.schedulePeriod + config.scheduleWarmup} steps</span>
              <MiniSpark
                data={previewSchedule(
                  { kind: config.scheduleKind, baseLr: config.lr, period: config.schedulePeriod, warmup: config.scheduleWarmup, gamma: 0.5, minFrac: 0.05 },
                  config.schedulePeriod + config.scheduleWarmup,
                )}
                color="#38bdf8"
              />
            </div>
          </>
        )}
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
          {config.mode === 'regression' ? (
            <label className="field">
              <span>Loss</span>
              <select value={config.regLoss} onChange={(e) => set('regLoss', e.target.value as RegLoss)}>
                {REG_LOSSES.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label className="field">
              <span>Loss</span>
              <select value="softmax-CE" disabled>
                <option>softmax-CE</option>
              </select>
            </label>
          )}
        </div>
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
          <div className="stat">
            <span className="muted small">lr</span>
            <b>{Number.isFinite(metrics.lr) ? metrics.lr.toExponential(1) : '—'}</b>
          </div>
        </div>
        {config.valFraction > 0 && Number.isFinite(gap) && (
          <div className={`gap ${gap > 0.12 ? 'warn' : 'ok'}`}>
            generalization gap (train − val): <b>{config.mode === 'classification' ? `${(gap * 100).toFixed(1)}%` : gap.toFixed(3)}</b>
            {gap > 0.12 ? ' · overfitting — try dropout / weight decay' : ''}
          </div>
        )}
      </section>

      <section className="group">
        <h3>Gradient check</h3>
        <p className="muted small">Finite differences vs. the analytic backward pass on the live model.</p>
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

      <section className="group">
        <h3>Engine self-test</h3>
        <p className="muted small">Gradcheck every op in the engine at once — the full honesty proof.</p>
        <SelfTestPanel />
      </section>

      <section className="group">
        <h3>Save &amp; share</h3>
        <div className="save-row">
          <input
            className="slot-input"
            value={slotName}
            onChange={(e) => setSlotName(e.target.value)}
            placeholder="slot name"
          />
          <button className="ghost" onClick={() => onSave(slotName.trim() || 'exp')}>
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
