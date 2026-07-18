import { useState, type Dispatch, type SetStateAction } from 'react';
import type { MetaConfigUI, MetaMetrics } from '../../hooks/useMetaTrainer';
import type { GradCheckResult } from '../../engine/gradcheck';
import type { MetaAlgo, TaskFamily } from '../../engine/meta';
import SelfTestPanel from '../SelfTestPanel';

interface Props {
  config: MetaConfigUI;
  setConfig: Dispatch<SetStateAction<MetaConfigUI>>;
  onAlgoChange: (algo: MetaAlgo) => void;
  running: boolean;
  onStart: () => void;
  onPause: () => void;
  onReset: () => void;
  onStep: () => void;
  metrics: MetaMetrics;
  paramCount: number;
  onGradCheck: () => void;
  gradResult: GradCheckResult | null;
  slots: string[];
  onSave: (name: string) => void;
  onLoadSlot: (name: string) => void;
  onDeleteSlot: (name: string) => void;
  onShare: () => void;
  shareMsg: string | null;
}

const ALGOS: { id: MetaAlgo; label: string }[] = [
  { id: 'reptile', label: 'Reptile' },
  { id: 'fomaml', label: 'FOMAML' },
  { id: 'baseline', label: 'Joint (baseline)' },
];
const FAMILIES: { id: TaskFamily; label: string }[] = [
  { id: 'sine', label: 'sine A·sin(x+φ)' },
  { id: 'sine-freq', label: 'sine +freq' },
  { id: 'line', label: 'line ax+b' },
];
const KSHOTS = [5, 10, 20, 40];
const INNER_STEPS = [1, 2, 3, 5, 8];
const INNER_LRS = [0.005, 0.01, 0.02, 0.05];
const META_LRS = [0.001, 0.004, 0.01, 0.1, 0.3, 0.5, 1.0];
const META_BATCHES = [4, 8, 16, 25];
const HIDDENS = [20, 40, 64];
const DEPTHS = [1, 2, 3];
const SPEEDS = [1, 2, 4, 8];
const NOISES = [0, 0.05, 0.1, 0.2];

const ALGO_BLURB: Record<MetaAlgo, string> = {
  reptile:
    'Adapt on the task, then nudge θ toward the adapted weights: θ ← θ + ε(φ−θ). No query gradient at all — the interpolation alone approximates the MAML update (needs ≥2 inner steps to beat joint training).',
  fomaml:
    'First-order MAML: adapt on the support set, then take the query-loss gradient at the adapted weights φ as the meta-gradient for θ. Drops the Hessian term full MAML keeps — exact on this first-order engine.',
  baseline:
    'The control: train θ on the pooled data of every task with no inner adaptation. It can only learn the mean function, so it few-shot-adapts poorly — the bar the meta-learners clear.',
};

export default function MetaControls(props: Props) {
  const {
    config,
    setConfig,
    onAlgoChange,
    running,
    onStart,
    onPause,
    onReset,
    onStep,
    metrics,
    paramCount,
    onGradCheck,
    gradResult,
    slots,
    onSave,
    onLoadSlot,
    onDeleteSlot,
    onShare,
    shareMsg,
  } = props;
  const [slotName, setSlotName] = useState('meta-1');
  const set = <K extends keyof MetaConfigUI>(key: K, value: MetaConfigUI[K]) => setConfig((c) => ({ ...c, [key]: value }));

  return (
    <aside className="panel">
      <section className="group">
        <h3>Meta-algorithm</h3>
        <div className="seg">
          {ALGOS.map((a) => (
            <button key={a.id} className={config.algo === a.id ? 'on' : ''} onClick={() => onAlgoChange(a.id)}>
              {a.label}
            </button>
          ))}
        </div>
        <p className="muted small arch-desc">{ALGO_BLURB[config.algo]}</p>
      </section>

      <section className="group">
        <h3>Task distribution</h3>
        <label className="field">
          <span>Family</span>
          <select value={config.family} onChange={(e) => set('family', e.target.value as TaskFamily)}>
            {FAMILIES.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>
            K-shot support · {config.kShot} <span className="muted small">examples/task</span>
          </span>
          <div className="seg">
            {KSHOTS.map((k) => (
              <button key={k} className={config.kShot === k ? 'on' : ''} onClick={() => set('kShot', k)}>
                {k}
              </button>
            ))}
          </div>
        </label>
        <label className="field">
          <span>Label noise · {config.noise.toFixed(2)}</span>
          <div className="seg">
            {NOISES.map((v) => (
              <button key={v} className={config.noise === v ? 'on' : ''} onClick={() => set('noise', v)}>
                {v}
              </button>
            ))}
          </div>
        </label>
      </section>

      <section className="group">
        <h3>
          Learner net <span className="muted small">· 1→{config.hidden}×{config.depth}→1 · {paramCount} params</span>
        </h3>
        <div className="two">
          <label className="field">
            <span>Width</span>
            <div className="seg">
              {HIDDENS.map((h) => (
                <button key={h} className={config.hidden === h ? 'on' : ''} onClick={() => set('hidden', h)}>
                  {h}
                </button>
              ))}
            </div>
          </label>
          <label className="field">
            <span>Depth</span>
            <div className="seg">
              {DEPTHS.map((d) => (
                <button key={d} className={config.depth === d ? 'on' : ''} onClick={() => set('depth', d)}>
                  {d}
                </button>
              ))}
            </div>
          </label>
        </div>
        <p className="muted small arch-desc">A tanh MLP. Meta-learning tunes not a solution but a starting point.</p>
      </section>

      <section className="group">
        <h3>Inner loop (adaptation)</h3>
        <label className="field">
          <span>Inner steps · {config.innerSteps}</span>
          <div className="seg">
            {INNER_STEPS.map((s) => (
              <button key={s} className={config.innerSteps === s ? 'on' : ''} onClick={() => set('innerSteps', s)}>
                {s}
              </button>
            ))}
          </div>
        </label>
        <label className="field">
          <span>Inner LR · {config.innerLr}</span>
          <div className="seg">
            {INNER_LRS.map((v) => (
              <button key={v} className={config.innerLr === v ? 'on' : ''} onClick={() => set('innerLr', v)}>
                {v}
              </button>
            ))}
          </div>
        </label>
      </section>

      <section className="group">
        <h3>Outer loop (meta)</h3>
        <label className="field">
          <span>
            Meta LR / ε · {config.metaLr} <span className="muted small">{config.algo === 'reptile' ? '(interpolation ε)' : '(Adam LR)'}</span>
          </span>
          <div className="seg wrap">
            {META_LRS.map((v) => (
              <button key={v} className={config.metaLr === v ? 'on' : ''} onClick={() => set('metaLr', v)}>
                {v}
              </button>
            ))}
          </div>
        </label>
        <label className="field">
          <span>Meta-batch · {config.metaBatch} tasks/step</span>
          <div className="seg">
            {META_BATCHES.map((v) => (
              <button key={v} className={config.metaBatch === v ? 'on' : ''} onClick={() => set('metaBatch', v)}>
                {v}
              </button>
            ))}
          </div>
        </label>
        <label className="field">
          <span>Speed · {config.metaStepsPerFrame}× meta-steps/frame</span>
          <div className="seg">
            {SPEEDS.map((v) => (
              <button key={v} className={config.metaStepsPerFrame === v ? 'on' : ''} onClick={() => set('metaStepsPerFrame', v)}>
                {v}
              </button>
            ))}
          </div>
        </label>
        <button className="ghost wide" onClick={() => set('seed', (config.seed + 1) % 100000)}>
          ⟳ New seed (re-init θ)
        </button>
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
              ▶ Meta-train
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
            <span className="muted small">meta-steps</span>
            <b>{metrics.step}</b>
          </div>
          <div className="stat">
            <span className="muted small">pre-adapt</span>
            <b>{Number.isFinite(metrics.preLoss) ? metrics.preLoss.toFixed(3) : '—'}</b>
          </div>
          <div className="stat">
            <span className="muted small">post-adapt</span>
            <b>{Number.isFinite(metrics.postLoss) ? metrics.postLoss.toFixed(3) : '—'}</b>
          </div>
        </div>
      </section>

      <section className="group">
        <h3>Gradient check</h3>
        <p className="muted small">
          Finite differences vs. the hand-derived back-prop of the learner net's inner-loop MSE — the autograd the whole meta-loop
          is built on.
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
            <div className="muted small">{gradResult.maxRelError < 1e-3 ? '✓ learner autograd verified' : '⚠ check setup'}</div>
          </div>
        )}
      </section>

      <section className="group">
        <h3>Engine self-test</h3>
        <p className="muted small">Gradcheck every op the engine ships — the same tape this lab's inner and outer loops run on.</p>
        <SelfTestPanel />
      </section>

      <section className="group">
        <h3>Save &amp; share</h3>
        <div className="save-row">
          <input className="slot-input" value={slotName} onChange={(e) => setSlotName(e.target.value)} placeholder="slot name" />
          <button className="ghost" onClick={() => onSave(slotName.trim() || 'meta')}>
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
                    del
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
        <button className="ghost wide" onClick={onShare}>
          ⇪ Copy share link (weights in URL)
        </button>
        {shareMsg && <p className="muted small">{shareMsg}</p>}
      </section>
    </aside>
  );
}
