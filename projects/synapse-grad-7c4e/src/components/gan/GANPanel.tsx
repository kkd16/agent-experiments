import { useState, type Dispatch, type SetStateAction } from 'react';
import type { GANConfigUI, GANMetrics } from '../../hooks/useGANTrainer';
import type { GradCheckResult } from '../../engine/gradcheck';
import type { OptimizerKind } from '../../engine/optim';
import type { Activation } from '../../engine/nn';
import { FLOW_DATASETS } from '../../engine/flow-data';
import { GAN_PRESETS, GAN_OBJECTIVES, ganPresetById, type GANObjective } from '../../engine/gan';
import SelfTestPanel from '../SelfTestPanel';

interface Props {
  config: GANConfigUI;
  setConfig: Dispatch<SetStateAction<GANConfigUI>>;
  running: boolean;
  onStart: () => void;
  onPause: () => void;
  onReset: () => void;
  onStep: () => void;
  onGradCheck: () => void;
  gradResult: GradCheckResult | null;
  metrics: GANMetrics;
  paramCount: number;
  slots: string[];
  onSave: (name: string) => void;
  onLoadSlot: (name: string) => void;
  onDeleteSlot: (name: string) => void;
  onShare: () => void;
  shareMsg: string | null;
}

const OPTS: OptimizerKind[] = ['adam', 'adamw', 'rmsprop', 'nesterov', 'momentum', 'sgd'];
const ACTS: Activation[] = ['leaky_relu', 'relu', 'gelu', 'silu', 'tanh', 'elu'];
const ZDIMS = [2, 4, 8, 16];
const LRS = [0.0002, 0.0005, 0.001, 0.002, 0.005];
const WDS = [0, 0.0001, 0.001];
const BATCHES = [32, 64, 128, 256];
const DSTEPS = [1, 2, 3, 5];
const CLIP_C = [0.01, 0.05, 0.1, 0.2];
const SPEEDS = [1, 2, 4, 8];
const CLIPS = [0, 1, 2, 5];
const GRIDS = [48, 64, 80, 100];
const SAMPLES_N = [200, 500, 1000, 2000];

export default function GANPanel({
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
  const [slotName, setSlotName] = useState('gan-1');
  const set = <K extends keyof GANConfigUI>(key: K, value: GANConfigUI[K]) => setConfig((c) => ({ ...c, [key]: value }));
  const preset = ganPresetById(config.presetId);
  const isWgan = config.objective === 'wgan';
  const scoreLabel = isWgan ? 'score' : 'σ';

  return (
    <aside className="panel">
      <section className="group">
        <h3>Target distribution</h3>
        <label className="field">
          <span>Distribution</span>
          <select value={config.dataset} onChange={(e) => set('dataset', e.target.value as GANConfigUI['dataset'])}>
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
        <button className="ghost wide" onClick={() => set('seed', (config.seed + 1) % 100000)}>
          ⟳ Resample data &amp; weights
        </button>
      </section>

      <section className="group">
        <h3>
          The game <span className="muted small">· {paramCount} params</span>
        </h3>
        <label className="field">
          <span>Objective</span>
          <select value={config.objective} onChange={(e) => set('objective', e.target.value as GANObjective)}>
            {GAN_OBJECTIVES.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Architecture</span>
          <select value={config.presetId} onChange={(e) => set('presetId', e.target.value)}>
            {GAN_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <div className="two">
          <label className="field">
            <span>Latent dim z</span>
            <select value={config.zDim} onChange={(e) => set('zDim', Number(e.target.value))}>
              {ZDIMS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>G activation</span>
            <select value={config.gAct} onChange={(e) => set('gAct', e.target.value as Activation)}>
              {ACTS.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="field">
          <span>D activation</span>
          <select value={config.dAct} onChange={(e) => set('dAct', e.target.value as Activation)}>
            {ACTS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <p className="muted small arch-desc">
          Generator G[{preset.gHidden.join(', ')}] : z∈ℝ<sup>{config.zDim}</sup> → ℝ². Discriminator D[{preset.dHidden.join(', ')}] → 1.{' '}
          {isWgan
            ? 'WGAN: D is an unbounded critic (weights clipped to ±c); loss = E[D(real)] − E[D(fake)] estimates the Earth-Mover distance.'
            : config.objective === 'minimax'
              ? 'Original saturating minimax — watch G stall while D is winning.'
              : 'Non-saturating: G maximises log D(G(z)) — strong gradients throughout.'}
        </p>
      </section>

      <section className="group">
        <h3>Optimizer</h3>
        <label className="field">
          <span>Algorithm <span className="muted small">{config.optimizer === 'adam' || config.optimizer === 'adamw' ? '(β₁=0.5)' : ''}</span></span>
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
            <span>Critic steps · {config.dSteps}×</span>
            <select value={config.dSteps} onChange={(e) => set('dSteps', Number(e.target.value))}>
              {DSTEPS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          {isWgan ? (
            <label className="field">
              <span>Weight clip ±c</span>
              <select value={config.clipC} onChange={(e) => set('clipC', Number(e.target.value))}>
                {CLIP_C.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
          ) : (
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
          )}
        </div>
        {isWgan && (
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
        <h3>Views</h3>
        <div className="two">
          <label className="field">
            <span>Field grid</span>
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
            <span className="muted small">G steps</span>
            <b>{metrics.step}</b>
          </div>
          <div className="stat">
            <span className="muted small">{isWgan ? 'critic loss' : 'D loss'}</span>
            <b>{Number.isFinite(metrics.dLoss) ? metrics.dLoss.toFixed(3) : '—'}</b>
          </div>
          <div className="stat">
            <span className="muted small">G loss</span>
            <b>{Number.isFinite(metrics.gLoss) ? metrics.gLoss.toFixed(3) : '—'}</b>
          </div>
          <div className="stat">
            <span className="muted small">{isWgan ? 'Ŵ dist' : '‖grad‖'}</span>
            <b>{isWgan ? (Number.isFinite(metrics.wDist) ? metrics.wDist.toFixed(3) : '—') : Number.isFinite(metrics.gradNorm) ? metrics.gradNorm.toFixed(2) : '—'}</b>
          </div>
        </div>
        <div className="stat-row">
          <div className="stat">
            <span className="muted small">D({scoreLabel}) real</span>
            <b>{Number.isFinite(metrics.dReal) ? metrics.dReal.toFixed(3) : '—'}</b>
          </div>
          <div className="stat">
            <span className="muted small">D({scoreLabel}) fake</span>
            <b>{Number.isFinite(metrics.dFake) ? metrics.dFake.toFixed(3) : '—'}</b>
          </div>
        </div>
      </section>

      <section className="group">
        <h3>Gradient check</h3>
        <p className="muted small">
          Finite differences vs. the analytic gradient the discriminator back-propagates into the generator — the exact learning signal that
          trains a GAN.
        </p>
        <button className="ghost wide" onClick={onGradCheck}>
          Check generator gradients
        </button>
        {gradResult && (
          <div className={`gradres ${gradResult.maxRelError < 1e-3 ? 'ok' : 'warn'}`}>
            <div>
              max rel err <b>{gradResult.maxRelError.toExponential(2)}</b>
            </div>
            <div>
              mean <b>{gradResult.meanRelError.toExponential(2)}</b> over {gradResult.checked} entries
            </div>
            <div className="muted small">{gradResult.maxRelError < 1e-3 ? '✓ G ← D gradient verified' : '⚠ check setup'}</div>
          </div>
        )}
      </section>

      <section className="group">
        <h3>Engine self-test</h3>
        <p className="muted small">Gradcheck every op — now including both GAN players and the Wasserstein critic-loss identity.</p>
        <SelfTestPanel />
      </section>

      <section className="group">
        <h3>Save &amp; share</h3>
        <div className="save-row">
          <input className="slot-input" value={slotName} onChange={(e) => setSlotName(e.target.value)} placeholder="slot name" />
          <button className="ghost" onClick={() => onSave(slotName.trim() || 'gan')}>
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
