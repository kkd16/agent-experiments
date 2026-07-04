import { useState, type Dispatch, type SetStateAction } from 'react';
import type { SnnUIConfig, SnnMetrics, TrainMode } from '../../hooks/useSnnTrainer';
import { SNN_PRESETS } from '../../hooks/useSnnTrainer';
import { SURROGATES, ENCODINGS, type SurrogateKind, type EncodingKind } from '../../engine/snn';
import type { VisionDatasetKind } from '../../engine/images';
import type { GradCheckResult } from '../../engine/gradcheck';
import SelfTestPanel from '../SelfTestPanel';

interface Props {
  config: SnnUIConfig;
  setConfig: Dispatch<SetStateAction<SnnUIConfig>>;
  running: boolean;
  onStart: () => void;
  onPause: () => void;
  onReset: () => void;
  onStep: () => void;
  onGradCheck: () => void;
  gradResult: GradCheckResult | null;
  metrics: SnnMetrics;
  paramCount: number;
  spotlightCount: number;
  slots: string[];
  onSave: (name: string) => void;
  onLoadSlot: (name: string) => void;
  onDeleteSlot: (name: string) => void;
  onShare: () => void;
  shareMsg: string | null;
}

const IMG_SIZES = [10, 12, 14];
const SAMPLES = [200, 400, 800];
const TS = [10, 15, 20, 30];
const BETAS = [0.8, 0.9, 0.95];
const KAPPAS = [0.7, 0.85, 0.95];
const THRESHOLDS = [0.5, 1, 1.5];
const SLOPES = [2, 5, 10, 20];
const SCALES = [0.5, 1, 1.5, 2];
const RATE_REGS = [0, 0.001, 0.01, 0.05];
const LRS = [0.0005, 0.001, 0.002, 0.005];
const BATCHES = [16, 32, 48];
const CLIPS = [0, 2, 5, 10];
const NOISES = [0.03, 0.06, 0.1];
const JITTERS = [0.05, 0.12, 0.2];

export default function SnnPanel(props: Props) {
  const {
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
    spotlightCount,
    slots,
    onSave,
    onLoadSlot,
    onDeleteSlot,
    onShare,
    shareMsg,
  } = props;
  const [slotName, setSlotName] = useState('snn-1');
  const set = <K extends keyof SnnUIConfig>(key: K, value: SnnUIConfig[K]) => setConfig((c) => ({ ...c, [key]: value }));
  const pc = (v: number) => (Number.isFinite(v) ? (v * 100).toFixed(0) + '%' : '—');

  return (
    <aside className="panel">
      <section className="group">
        <h3>Dataset</h3>
        <label className="field">
          <span>Glyphs</span>
          <select value={config.dataset} onChange={(e) => set('dataset', e.target.value as VisionDatasetKind)}>
            <option value="digits">digits 0–9</option>
            <option value="shapes">shapes</option>
          </select>
        </label>
        <div className="two">
          <label className="field">
            <span>Grid</span>
            <select value={config.imgSize} onChange={(e) => set('imgSize', Number(e.target.value))}>
              {IMG_SIZES.map((v) => (
                <option key={v} value={v}>
                  {v}×{v}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Samples</span>
            <select value={config.samples} onChange={(e) => set('samples', Number(e.target.value))}>
              {SAMPLES.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="two">
          <label className="field">
            <span>Noise</span>
            <select value={config.noise} onChange={(e) => set('noise', Number(e.target.value))}>
              {NOISES.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Jitter</span>
            <select value={config.jitter} onChange={(e) => set('jitter', Number(e.target.value))}>
              {JITTERS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="muted small task-blurb">
          Procedural handwritten-style glyphs — no MNIST, no bundled data. Each is encoded into a spike train the net
          classifies; a held-out 20% split gives the honest test accuracy.
        </p>
      </section>

      <section className="group">
        <h3>
          Architecture <span className="muted small">· {paramCount.toLocaleString()} params</span>
        </h3>
        <label className="field">
          <span>Hidden layers</span>
          <select value={config.presetId} onChange={(e) => set('presetId', e.target.value)}>
            {SNN_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <button
          className={`chip${config.recurrent ? ' on' : ''}`}
          onClick={() => set('recurrent', !config.recurrent)}
          style={{ width: '100%' }}
        >
          {config.recurrent ? '✓ ' : ''}Recurrent (spike→spike within layer)
        </button>
        <p className="muted small task-blurb">
          LIF hidden layers feeding a non-spiking leaky-integrator readout. The recurrent weight lets a layer's spikes
          re-enter itself, giving the network working memory across time.
        </p>
      </section>

      <section className="group">
        <h3>Neuron dynamics</h3>
        <div className="two">
          <label className="field">
            <span>Timesteps T</span>
            <select value={config.T} onChange={(e) => set('T', Number(e.target.value))}>
              {TS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Threshold θ</span>
            <select value={config.threshold} onChange={(e) => set('threshold', Number(e.target.value))}>
              {THRESHOLDS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="two">
          <label className="field">
            <span>Mem decay β</span>
            <select value={config.beta} onChange={(e) => set('beta', Number(e.target.value))}>
              {BETAS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Readout κ</span>
            <select value={config.kappa} onChange={(e) => set('kappa', Number(e.target.value))}>
              {KAPPAS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      <section className="group">
        <h3>Surrogate gradient</h3>
        <label className="field">
          <span>Function</span>
          <select value={config.surrogate} onChange={(e) => set('surrogate', e.target.value as SurrogateKind)}>
            {SURROGATES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Steepness k · {config.slope}</span>
          <select value={config.slope} onChange={(e) => set('slope', Number(e.target.value))}>
            {SLOPES.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <p className="muted small task-blurb">{SURROGATES.find((s) => s.id === config.surrogate)?.note}</p>
      </section>

      <section className="group">
        <h3>Input encoding</h3>
        <label className="field">
          <span>Scheme</span>
          <select value={config.encoding} onChange={(e) => set('encoding', e.target.value as EncodingKind)}>
            {ENCODINGS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Drive scale · {config.currentScale}</span>
          <select value={config.currentScale} onChange={(e) => set('currentScale', Number(e.target.value))}>
            {SCALES.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <p className="muted small task-blurb">{ENCODINGS.find((s) => s.id === config.encoding)?.note}</p>
      </section>

      <section className="group">
        <h3>Training</h3>
        <label className="field">
          <span>Spike on backward</span>
          <select value={config.trainMode} onChange={(e) => set('trainMode', e.target.value as TrainMode)}>
            <option value="hard">hard spike (true surrogate)</option>
            <option value="soft">soft relaxation</option>
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
            <span>Batch</span>
            <select value={config.batch} onChange={(e) => set('batch', Number(e.target.value))}>
              {BATCHES.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="two">
          <label className="field">
            <span>Rate penalty</span>
            <select value={config.rateReg} onChange={(e) => set('rateReg', Number(e.target.value))}>
              {RATE_REGS.map((v) => (
                <option key={v} value={v}>
                  {v === 0 ? 'off' : v}
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
        <button className="ghost wide" onClick={() => set('seed', (config.seed + 1) % 100000)}>
          ⟳ New seed &amp; weights
        </button>
      </section>

      <section className="group">
        <h3>
          Spotlight <span className="muted small">· sample {spotlightCount ? (config.spotlight % spotlightCount) + 1 : 0}/{spotlightCount}</span>
        </h3>
        <div className="run-row">
          <button className="ghost" onClick={() => set('spotlight', config.spotlight - 1)}>
            ‹ prev
          </button>
          <button className="ghost" onClick={() => set('spotlight', config.spotlight + 1)}>
            next ›
          </button>
        </div>
        <p className="muted small">The held-out glyph the raster, membrane traces and readout race all visualize.</p>
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
          <button className="ghost" onClick={onStep}>
            Step
          </button>
          <button className="ghost" onClick={onReset}>
            Reset
          </button>
        </div>
        <div className="stat-row">
          <div className="stat">
            <span className="muted small">test acc</span>
            <b>{pc(metrics.testAcc)}</b>
          </div>
          <div className="stat">
            <span className="muted small">train acc</span>
            <b>{pc(metrics.trainAcc)}</b>
          </div>
          <div className="stat">
            <span className="muted small">loss</span>
            <b>{Number.isFinite(metrics.trainLoss) ? metrics.trainLoss.toFixed(3) : '—'}</b>
          </div>
          <div className="stat">
            <span className="muted small">iters</span>
            <b>{metrics.iter}</b>
          </div>
        </div>
        <div className="stat-row">
          <div className="stat">
            <span className="muted small">sparsity</span>
            <b>{pc(metrics.sparsity)}</b>
          </div>
          <div className="stat">
            <span className="muted small">spikes/inf</span>
            <b>{Number.isFinite(metrics.spikesPerInfer) ? Math.round(metrics.spikesPerInfer) : '—'}</b>
          </div>
          <div className="stat">
            <span className="muted small">grad‖·‖</span>
            <b>{Number.isFinite(metrics.gradNorm) ? metrics.gradNorm.toFixed(2) : '—'}</b>
          </div>
          <div className="stat">
            <span className="muted small">examples</span>
            <b>{metrics.examples}</b>
          </div>
        </div>
      </section>

      <section className="group">
        <h3>Gradient check</h3>
        <p className="muted small">
          The Heaviside spike has a zero gradient, so we finite-difference the smooth twin
          (<code>softSpike</code>) through the whole unrolled BPTT — the surrogate, proven exact.
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
            <div className="muted small">{gradResult.maxRelError < 1e-3 ? '✓ surrogate BPTT verified' : '⚠ check setup'}</div>
          </div>
        )}
      </section>

      <section className="group">
        <h3>Engine self-test</h3>
        <p className="muted small">
          Gradcheck every op — now including the four surrogate gradients, the hard≡soft backward identity, the LIF
          subtractive reset, and a whole spiking net through BPTT.
        </p>
        <SelfTestPanel />
      </section>

      <section className="group">
        <h3>Save &amp; share</h3>
        <div className="save-row">
          <input className="slot-input" value={slotName} onChange={(e) => setSlotName(e.target.value)} placeholder="slot name" />
          <button className="ghost" onClick={() => onSave(slotName.trim() || 'snn')}>
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
