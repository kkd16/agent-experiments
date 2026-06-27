import { useState, type Dispatch, type SetStateAction } from 'react';
import type { ContrastiveConfig, ContrastiveMetrics } from '../../hooks/useContrastiveTrainer';
import type { GradCheckResult } from '../../engine/gradcheck';
import type { OptimizerKind } from '../../engine/optim';
import type { ScheduleKind } from '../../engine/schedule';
import { VISION_DATASETS } from '../../engine/images';
import { ENCODER_PRESETS } from '../../engine/contrastive';
import SelfTestPanel from '../SelfTestPanel';

interface Props {
  config: ContrastiveConfig;
  setConfig: Dispatch<SetStateAction<ContrastiveConfig>>;
  running: boolean;
  onStart: () => void;
  onPause: () => void;
  onReset: () => void;
  onStep: () => void;
  onGradCheck: () => void;
  gradResult: GradCheckResult | null;
  metrics: ContrastiveMetrics;
  paramCount: number;
  slots: string[];
  onSave: (name: string) => void;
  onLoadSlot: (name: string) => void;
  onDeleteSlot: (name: string) => void;
  onShare: () => void;
  shareMsg: string | null;
}

const OPTS: OptimizerKind[] = ['adamw', 'adam', 'rmsprop', 'momentum', 'nesterov', 'sgd'];
const SCHEDULES: { id: ScheduleKind; label: string }[] = [
  { id: 'constant', label: 'constant' },
  { id: 'step', label: 'step decay' },
  { id: 'cosine', label: 'cosine' },
  { id: 'warmup-cosine', label: 'warmup→cosine' },
];
const TEMPS = [0.07, 0.1, 0.2, 0.3, 0.5];
const PAIRS = [12, 16, 24, 32, 48];
const LRS = [0.001, 0.002, 0.003, 0.005, 0.01];
const WDS = [0, 0.0001, 0.001];
const SPEEDS = [1, 2, 3, 4];
const CLIPS = [0, 1, 2, 5];
const CUTOUTS = [0, 0.25, 0.5];

export default function ContrastivePanel({
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
  const [slotName, setSlotName] = useState('simclr-1');
  const set = <K extends keyof ContrastiveConfig>(key: K, value: ContrastiveConfig[K]) =>
    setConfig((c) => ({ ...c, [key]: value }));
  const showSched = config.scheduleKind !== 'constant';
  const arch = ENCODER_PRESETS.find((p) => p.id === config.presetId) ?? ENCODER_PRESETS[1];

  return (
    <aside className="panel">
      <section className="group">
        <h3>Image data · unlabeled</h3>
        <label className="field">
          <span>Dataset</span>
          <select value={config.dataset} onChange={(e) => set('dataset', e.target.value as ContrastiveConfig['dataset'])}>
            {VISION_DATASETS.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Base images · {config.samples}</span>
          <input type="range" min={120} max={600} step={40} value={config.samples} onChange={(e) => set('samples', Number(e.target.value))} />
        </label>
        <p className="muted small">Labels are never shown to the encoder — they're only used afterward to color the map and score the probes.</p>
      </section>

      <section className="group">
        <h3>Augmentation</h3>
        <label className="field">
          <span>Strength · {config.augStrength.toFixed(2)}</span>
          <input type="range" min={0.2} max={1.4} step={0.1} value={config.augStrength} onChange={(e) => set('augStrength', Number(e.target.value))} />
        </label>
        <label className="field">
          <span>Cutout prob</span>
          <select value={config.cutout} onChange={(e) => set('cutout', Number(e.target.value))}>
            {CUTOUTS.map((v) => (
              <option key={v} value={v}>
                {v === 0 ? 'off' : v}
              </option>
            ))}
          </select>
        </label>
        <p className="muted small">Each step makes two random views per image (rotate · scale · shift · intensity · noise{config.cutout > 0 ? ' · cutout' : ''}); their match is the only learning signal.</p>
      </section>

      <section className="group">
        <h3>
          Encoder <span className="muted small">· {paramCount} params</span>
        </h3>
        <label className="field">
          <span>Backbone f<sub>θ</sub></span>
          <select value={config.presetId} onChange={(e) => set('presetId', e.target.value)}>
            {ENCODER_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <p className="muted small arch-desc">
          conv {arch.ch1}→{arch.ch2} (stride-2) → rep {arch.repDim} → projection head → z {arch.projDim}
        </p>
        <div className="two">
          <label className="field">
            <span>Temperature τ</span>
            <select value={config.temperature} onChange={(e) => set('temperature', Number(e.target.value))}>
              {TEMPS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Batch pairs N</span>
            <select value={config.batchPairs} onChange={(e) => set('batchPairs', Number(e.target.value))}>
              {PAIRS.map((v) => (
                <option key={v} value={v}>
                  {v} → {2 * v}
                </option>
              ))}
            </select>
          </label>
        </div>
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
              <input type="range" min={200} max={3000} step={100} value={config.schedulePeriod} onChange={(e) => set('schedulePeriod', Number(e.target.value))} />
            </label>
            <label className="field">
              <span>Warmup · {config.scheduleWarmup}</span>
              <input
                type="range"
                min={0}
                max={600}
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
            <span>Speed</span>
            <select value={config.stepsPerFrame} onChange={(e) => set('stepsPerFrame', Number(e.target.value))}>
              {SPEEDS.map((v) => (
                <option key={v} value={v}>
                  {v}×
                </option>
              ))}
            </select>
          </label>
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
            <span className="muted small">NT-Xent</span>
            <b>{Number.isFinite(metrics.loss) ? metrics.loss.toFixed(3) : '—'}</b>
          </div>
          <div className="stat">
            <span className="muted small">batch acc</span>
            <b>{Number.isFinite(metrics.contrastiveAcc) ? `${(metrics.contrastiveAcc * 100).toFixed(0)}%` : '—'}</b>
          </div>
          <div className="stat">
            <span className="muted small">‖g‖</span>
            <b>{Number.isFinite(metrics.gradNorm) ? metrics.gradNorm.toFixed(2) : '—'}</b>
          </div>
        </div>
        <div className="stat-row">
          <div className="stat">
            <span className="muted small">probe</span>
            <b>{Number.isFinite(metrics.probeAcc) ? `${(metrics.probeAcc * 100).toFixed(0)}%` : '—'}</b>
          </div>
          <div className="stat">
            <span className="muted small">kNN</span>
            <b>{Number.isFinite(metrics.knnAcc) ? `${(metrics.knnAcc * 100).toFixed(0)}%` : '—'}</b>
          </div>
          <div className="stat">
            <span className="muted small">vs pixels</span>
            <b>{Number.isFinite(metrics.pixelProbeAcc) ? `${(metrics.pixelProbeAcc * 100).toFixed(0)}%` : '—'}</b>
          </div>
          <div className="stat">
            <span className="muted small">uniform</span>
            <b>{Number.isFinite(metrics.uniformity) ? metrics.uniformity.toFixed(2) : '—'}</b>
          </div>
        </div>
      </section>

      <section className="group">
        <h3>Gradient check</h3>
        <p className="muted small">Finite differences vs. the analytic backward pass through the whole encoder + NT-Xent loss (the new L2-normalize op included).</p>
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
            <div className="muted small">{gradResult.maxRelError < 1e-3 ? '✓ encoder + InfoNCE verified end-to-end' : '⚠ check setup'}</div>
          </div>
        )}
      </section>

      <section className="group">
        <h3>Engine self-test</h3>
        <p className="muted small">Gradcheck every op — now including the row L2-normalize and the contrastive InfoNCE loss identities.</p>
        <SelfTestPanel />
      </section>

      <section className="group">
        <h3>Save &amp; share</h3>
        <div className="save-row">
          <input className="slot-input" value={slotName} onChange={(e) => setSlotName(e.target.value)} placeholder="slot name" />
          <button className="ghost" onClick={() => onSave(slotName.trim() || 'simclr')}>
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
