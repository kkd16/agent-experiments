import { useState, type Dispatch, type SetStateAction } from 'react';
import type { VisionConfig } from '../../hooks/useVisionTrainer';
import type { TrainerMetrics } from '../../hooks/useTrainer';
import type { GradCheckResult } from '../../engine/gradcheck';
import type { OptimizerKind } from '../../engine/optim';
import type { ScheduleKind } from '../../engine/schedule';
import { VISION_DATASETS } from '../../engine/images';
import { ARCH_PRESETS } from '../../engine/vision-nn';
import SelfTestPanel from '../SelfTestPanel';

interface Props {
  config: VisionConfig;
  setConfig: Dispatch<SetStateAction<VisionConfig>>;
  running: boolean;
  onStart: () => void;
  onPause: () => void;
  onReset: () => void;
  onStep: () => void;
  onGradCheck: () => void;
  gradResult: GradCheckResult | null;
  metrics: TrainerMetrics;
  paramCount: number;
  slots: string[];
  onSave: (name: string) => void;
  onLoadSlot: (name: string) => void;
  onDeleteSlot: (name: string) => void;
  onShare: () => void;
  shareMsg: string | null;
}

const OPTS: OptimizerKind[] = ['sgd', 'momentum', 'nesterov', 'rmsprop', 'adam', 'adamw'];
const SCHEDULES: { id: ScheduleKind; label: string }[] = [
  { id: 'constant', label: 'constant' },
  { id: 'step', label: 'step decay' },
  { id: 'cosine', label: 'cosine' },
  { id: 'warmup-cosine', label: 'warmup→cosine' },
];
const LRS = [0.001, 0.003, 0.01, 0.02, 0.05, 0.1];
const WDS = [0, 0.0001, 0.001, 0.01];
const BATCHES = [16, 24, 32, 48, 64];
const SPEEDS = [1, 2, 3, 4];
const CLIPS = [0, 1, 2, 5];

export default function VisionPanel({
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
  const [slotName, setSlotName] = useState('cnn-1');
  const set = <K extends keyof VisionConfig>(key: K, value: VisionConfig[K]) => setConfig((c) => ({ ...c, [key]: value }));
  const gap = Number.isFinite(metrics.acc) && Number.isFinite(metrics.valAcc) ? metrics.acc - metrics.valAcc : NaN;
  const showSched = config.scheduleKind !== 'constant';

  return (
    <aside className="panel">
      <section className="group">
        <h3>Image task</h3>
        <label className="field">
          <span>Dataset</span>
          <select value={config.dataset} onChange={(e) => set('dataset', e.target.value as VisionConfig['dataset'])}>
            {VISION_DATASETS.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Samples · {config.samples}</span>
          <input type="range" min={120} max={1200} step={40} value={config.samples} onChange={(e) => set('samples', Number(e.target.value))} />
        </label>
        <div className="two">
          <label className="field">
            <span>Noise · {config.noise.toFixed(2)}</span>
            <input type="range" min={0} max={0.3} step={0.02} value={config.noise} onChange={(e) => set('noise', Number(e.target.value))} />
          </label>
          <label className="field">
            <span>Augment · {config.jitter.toFixed(1)}</span>
            <input type="range" min={0} max={1.5} step={0.1} value={config.jitter} onChange={(e) => set('jitter', Number(e.target.value))} />
          </label>
        </div>
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
          ConvNet <span className="muted small">· {paramCount} params</span>
        </h3>
        <label className="field">
          <span>Architecture</span>
          <select value={config.archId} onChange={(e) => set('archId', e.target.value)}>
            {ARCH_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <p className="muted small arch-desc">
          {ARCH_PRESETS.find((p) => p.id === config.archId)?.blocks.map((b, i) => (
            <span key={i}>
              conv {b.filters}×{b.kernel}×{b.kernel}
              {b.pool > 1 ? ` → ⬇${b.pool}` : ''} ·{' '}
            </span>
          ))}
          dense [{ARCH_PRESETS.find((p) => p.id === config.archId)?.dense.join(', ')}] → softmax
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
              <input type="range" min={100} max={1500} step={50} value={config.schedulePeriod} onChange={(e) => set('schedulePeriod', Number(e.target.value))} />
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
            <span className="muted small">acc</span>
            <b>{Number.isFinite(metrics.acc) ? `${(metrics.acc * 100).toFixed(1)}%` : '—'}</b>
          </div>
          <div className="stat">
            <span className="muted small">val</span>
            <b>{Number.isFinite(metrics.valAcc) ? `${(metrics.valAcc * 100).toFixed(1)}%` : '—'}</b>
          </div>
        </div>
        {config.valFraction > 0 && Number.isFinite(gap) && (
          <div className={`gap ${gap > 0.12 ? 'warn' : 'ok'}`}>
            generalization gap (train − val): <b>{(gap * 100).toFixed(1)}%</b>
            {gap > 0.12 ? ' · overfitting — add augment / weight decay' : ''}
          </div>
        )}
      </section>

      <section className="group">
        <h3>Gradient check</h3>
        <p className="muted small">Finite differences vs. the analytic backward pass through the whole CNN.</p>
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
            <div className="muted small">{gradResult.maxRelError < 1e-3 ? '✓ conv/pool gradients verified' : '⚠ check setup'}</div>
          </div>
        )}
      </section>

      <section className="group">
        <h3>Engine self-test</h3>
        <p className="muted small">Gradcheck every op — including conv2d, maxPool2d &amp; avgPool2d.</p>
        <SelfTestPanel />
      </section>

      <section className="group">
        <h3>Save &amp; share</h3>
        <div className="save-row">
          <input className="slot-input" value={slotName} onChange={(e) => setSlotName(e.target.value)} placeholder="slot name" />
          <button className="ghost" onClick={() => onSave(slotName.trim() || 'cnn')}>
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
