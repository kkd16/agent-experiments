import { useState, type Dispatch, type SetStateAction } from 'react';
import type { FlowConfigUI, FlowMetrics } from '../../hooks/useFlowTrainer';
import type { GradCheckResult } from '../../engine/gradcheck';
import type { OptimizerKind } from '../../engine/optim';
import type { ScheduleKind } from '../../engine/schedule';
import type { Activation } from '../../engine/nn';
import { FLOW_DATASETS } from '../../engine/flow-data';
import { FLOW_PRESETS, presetById } from '../../engine/flows';
import SelfTestPanel from '../SelfTestPanel';

interface Props {
  config: FlowConfigUI;
  setConfig: Dispatch<SetStateAction<FlowConfigUI>>;
  running: boolean;
  onStart: () => void;
  onPause: () => void;
  onReset: () => void;
  onStep: () => void;
  onGradCheck: () => void;
  gradResult: GradCheckResult | null;
  metrics: FlowMetrics;
  paramCount: number;
  slots: string[];
  onSave: (name: string) => void;
  onLoadSlot: (name: string) => void;
  onDeleteSlot: (name: string) => void;
  onShare: () => void;
  shareMsg: string | null;
}

const OPTS: OptimizerKind[] = ['adamw', 'adam', 'rmsprop', 'nesterov', 'momentum', 'sgd'];
const SCHEDULES: { id: ScheduleKind; label: string }[] = [
  { id: 'constant', label: 'constant' },
  { id: 'step', label: 'step decay' },
  { id: 'cosine', label: 'cosine' },
  { id: 'warmup-cosine', label: 'warmup→cosine' },
];
const ACTS: Activation[] = ['relu', 'gelu', 'silu', 'tanh', 'softplus', 'leaky_relu'];
const LRS = [0.0005, 0.001, 0.002, 0.005, 0.01];
const WDS = [0, 0.0001, 0.001, 0.01];
const BATCHES = [32, 64, 128, 256];
const SPEEDS = [1, 2, 4, 8];
const CLIPS = [0, 1, 2, 5];
const GRIDS = [48, 64, 80, 100];
const SAMPLES_N = [200, 500, 1000, 2000];

export default function FlowPanel({
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
  const [slotName, setSlotName] = useState('flow-1');
  const set = <K extends keyof FlowConfigUI>(key: K, value: FlowConfigUI[K]) => setConfig((c) => ({ ...c, [key]: value }));
  const showSched = config.scheduleKind !== 'constant';
  const preset = presetById(config.presetId);

  return (
    <aside className="panel">
      <section className="group">
        <h3>Target density</h3>
        <label className="field">
          <span>Distribution</span>
          <select value={config.dataset} onChange={(e) => set('dataset', e.target.value as FlowConfigUI['dataset'])}>
            {FLOW_DATASETS.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Samples · {config.samples}</span>
          <input type="range" min={500} max={6000} step={250} value={config.samples} onChange={(e) => set('samples', Number(e.target.value))} />
        </label>
        <label className="field">
          <span>Noise · {config.noise.toFixed(2)}</span>
          <input type="range" min={0} max={0.3} step={0.02} value={config.noise} onChange={(e) => set('noise', Number(e.target.value))} />
        </label>
        <label className="field">
          <span>Validation split · {(config.valFraction * 100).toFixed(0)}%</span>
          <input type="range" min={0} max={0.5} step={0.05} value={config.valFraction} onChange={(e) => set('valFraction', Number(e.target.value))} />
        </label>
        <button className="ghost wide" onClick={() => set('seed', (config.seed + 1) % 100000)}>
          ⟳ Resample data &amp; weights
        </button>
      </section>

      <section className="group">
        <h3>
          RealNVP <span className="muted small">· {paramCount} params</span>
        </h3>
        <label className="field">
          <span>Architecture</span>
          <select value={config.presetId} onChange={(e) => set('presetId', e.target.value)}>
            {FLOW_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Coupling-net activation</span>
          <select value={config.activation} onChange={(e) => set('activation', e.target.value as Activation)}>
            {ACTS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <p className="muted small arch-desc">
          {preset.layers} affine coupling layers (alternating mask), each a [{preset.hidden.join(', ')}] conditioner → bounded
          log-scale s &amp; shift t. Exact log-density via change of variables.
        </p>
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
        {showSched && (
          <div className="two">
            <label className="field">
              <span>Period · {config.schedulePeriod}</span>
              <input type="range" min={100} max={2000} step={50} value={config.schedulePeriod} onChange={(e) => set('schedulePeriod', Number(e.target.value))} />
            </label>
            <label className="field">
              <span>Warmup · {config.scheduleWarmup}</span>
              <input
                type="range"
                min={0}
                max={400}
                step={25}
                value={config.scheduleWarmup}
                onChange={(e) => set('scheduleWarmup', Number(e.target.value))}
                disabled={config.scheduleKind !== 'warmup-cosine'}
              />
            </label>
          </div>
        )}
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
      </section>

      <section className="group">
        <h3>Views</h3>
        <div className="two">
          <label className="field">
            <span>Density grid</span>
            <select value={config.gridRes} onChange={(e) => set('gridRes', Number(e.target.value))}>
              {GRIDS.map((v) => (
                <option key={v} value={v}>
                  {v}×{v}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Samples drawn</span>
            <select value={config.sampleCount} onChange={(e) => set('sampleCount', Number(e.target.value))}>
              {SAMPLES_N.map((v) => (
                <option key={v} value={v}>
                  {v}
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
            <span className="muted small">NLL (nats)</span>
            <b>{Number.isFinite(metrics.nll) ? metrics.nll.toFixed(3) : '—'}</b>
          </div>
          <div className="stat">
            <span className="muted small">bits / dim</span>
            <b>{Number.isFinite(metrics.bpd) ? metrics.bpd.toFixed(3) : '—'}</b>
          </div>
          <div className="stat">
            <span className="muted small">‖grad‖</span>
            <b>{Number.isFinite(metrics.gradNorm) ? metrics.gradNorm.toFixed(2) : '—'}</b>
          </div>
        </div>
      </section>

      <section className="group">
        <h3>Gradient check</h3>
        <p className="muted small">Finite differences vs. the analytic backward pass through the whole flow (exact change-of-variables NLL).</p>
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
            <div className="muted small">{gradResult.maxRelError < 1e-3 ? '✓ couplings + log-det verified' : '⚠ check setup'}</div>
          </div>
        )}
      </section>

      <section className="group">
        <h3>Engine self-test</h3>
        <p className="muted small">Gradcheck every op — now including a whole RealNVP, its invertibility &amp; the log-det identity.</p>
        <SelfTestPanel />
      </section>

      <section className="group">
        <h3>Save &amp; share</h3>
        <div className="save-row">
          <input className="slot-input" value={slotName} onChange={(e) => setSlotName(e.target.value)} placeholder="slot name" />
          <button className="ghost" onClick={() => onSave(slotName.trim() || 'flow')}>
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
