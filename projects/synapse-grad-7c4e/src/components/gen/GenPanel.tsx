import { useState, type Dispatch, type SetStateAction } from 'react';
import type { GenConfig, GenMetrics } from '../../hooks/useGenTrainer';
import type { GradCheckResult } from '../../engine/gradcheck';
import type { OptimizerKind } from '../../engine/optim';
import type { ScheduleKind } from '../../engine/schedule';
import type { Activation } from '../../engine/nn';
import { VISION_DATASETS } from '../../engine/images';
import { VAE_PRESETS } from '../../engine/vae';
import SelfTestPanel from '../SelfTestPanel';

interface Props {
  config: GenConfig;
  setConfig: Dispatch<SetStateAction<GenConfig>>;
  running: boolean;
  onStart: () => void;
  onPause: () => void;
  onReset: () => void;
  onStep: () => void;
  onGradCheck: () => void;
  gradResult: GradCheckResult | null;
  metrics: GenMetrics;
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
const ACTS: Activation[] = ['gelu', 'silu', 'relu', 'tanh', 'softplus', 'leaky_relu'];
const LATENTS = [2, 4, 8, 16];
const LRS = [0.001, 0.003, 0.005, 0.01, 0.02];
const WDS = [0, 0.0001, 0.001, 0.01];
const BETAS = [0, 0.25, 0.5, 1, 2, 4];
const BATCHES = [16, 24, 32, 48, 64];
const SPEEDS = [1, 2, 3, 4];
const CLIPS = [0, 1, 2, 5];

export default function GenPanel({
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
  const [slotName, setSlotName] = useState('vae-1');
  const set = <K extends keyof GenConfig>(key: K, value: GenConfig[K]) => setConfig((c) => ({ ...c, [key]: value }));
  const showSched = config.scheduleKind !== 'constant';

  return (
    <aside className="panel">
      <section className="group">
        <h3>Image data</h3>
        <label className="field">
          <span>Dataset</span>
          <select value={config.dataset} onChange={(e) => set('dataset', e.target.value as GenConfig['dataset'])}>
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
          VAE <span className="muted small">· {paramCount} params</span>
        </h3>
        <label className="field">
          <span>Architecture</span>
          <select value={config.presetId} onChange={(e) => set('presetId', e.target.value)}>
            {VAE_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <div className="two">
          <label className="field">
            <span>Latent dim</span>
            <select value={config.latent} onChange={(e) => set('latent', Number(e.target.value))}>
              {LATENTS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
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
        </div>
        <p className="muted small arch-desc">
          encoder [{VAE_PRESETS.find((p) => p.id === config.presetId)?.hidden.join(', ')}] → μ,&nbsp;logσ²({config.latent}) →
          decoder [{[...(VAE_PRESETS.find((p) => p.id === config.presetId)?.hidden ?? [])].reverse().join(', ')}] → {config.imgSize}×{config.imgSize} logits
        </p>
        <label className="field">
          <span>β · KL weight · {config.beta}</span>
          <select value={config.beta} onChange={(e) => set('beta', Number(e.target.value))}>
            {BETAS.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <p className="muted small">
          β &gt; 1 (β-VAE) presses the code toward the prior — more disentangled, blurrier; β → 0 is a plain autoencoder.
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
        <h3>Latent views</h3>
        <label className="field">
          <span>Manifold grid · {config.manifoldN}×{config.manifoldN}</span>
          <input type="range" min={5} max={15} step={1} value={config.manifoldN} onChange={(e) => set('manifoldN', Number(e.target.value))} />
        </label>
        <label className="field">
          <span>Sweep range · ±{config.manifoldSpan.toFixed(1)}σ</span>
          <input type="range" min={1} max={3} step={0.25} value={config.manifoldSpan} onChange={(e) => set('manifoldSpan', Number(e.target.value))} />
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
            <span className="muted small">−ELBO</span>
            <b>{Number.isFinite(metrics.loss) ? metrics.loss.toFixed(1) : '—'}</b>
          </div>
          <div className="stat">
            <span className="muted small">recon</span>
            <b>{Number.isFinite(metrics.recon) ? metrics.recon.toFixed(1) : '—'}</b>
          </div>
          <div className="stat">
            <span className="muted small">KL</span>
            <b>{Number.isFinite(metrics.kl) ? metrics.kl.toFixed(2) : '—'}</b>
          </div>
        </div>
      </section>

      <section className="group">
        <h3>Gradient check</h3>
        <p className="muted small">Finite differences vs. the analytic backward pass through the whole VAE (reparameterized ELBO).</p>
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
            <div className="muted small">{gradResult.maxRelError < 1e-3 ? '✓ encoder + decoder + KL verified' : '⚠ check setup'}</div>
          </div>
        )}
      </section>

      <section className="group">
        <h3>Engine self-test</h3>
        <p className="muted small">Gradcheck every op — now including bceWithLogits, klDivStdNormal &amp; a whole VAE.</p>
        <SelfTestPanel />
      </section>

      <section className="group">
        <h3>Save &amp; share</h3>
        <div className="save-row">
          <input className="slot-input" value={slotName} onChange={(e) => setSlotName(e.target.value)} placeholder="slot name" />
          <button className="ghost" onClick={() => onSave(slotName.trim() || 'vae')}>
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
