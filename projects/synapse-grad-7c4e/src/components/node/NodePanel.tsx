import { useState, type Dispatch, type SetStateAction } from 'react';
import type { NodeConfigUI, NodeMetrics, AdjointReport } from '../../hooks/useNodeTrainer';
import type { GradCheckResult } from '../../engine/gradcheck';
import type { OptimizerKind } from '../../engine/optim';
import type { ScheduleKind } from '../../engine/schedule';
import type { Activation } from '../../engine/nn';
import { NODE_DATASETS, SOLVERS, type Solver } from '../../engine/node-ode';
import SelfTestPanel from '../SelfTestPanel';

interface Props {
  config: NodeConfigUI;
  setConfig: Dispatch<SetStateAction<NodeConfigUI>>;
  running: boolean;
  onStart: () => void;
  onPause: () => void;
  onReset: () => void;
  onStep: () => void;
  onGradCheck: () => void;
  gradResult: GradCheckResult | null;
  onAdjointCheck: () => void;
  adjointResult: AdjointReport | null;
  metrics: NodeMetrics;
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
const ACTS: Activation[] = ['tanh', 'silu', 'gelu', 'softplus', 'relu'];
const AUGS = [0, 1, 2, 3];
const HIDDENS = [8, 16, 24, 32, 48, 64];
const DEPTHS = [1, 2, 3];
const STEPS = [4, 8, 12, 16, 24, 32];
const LRS = [0.002, 0.005, 0.01, 0.02, 0.05];
const WDS = [0, 0.0001, 0.001, 0.01];
const BATCHES = [32, 64, 128, 256];
const SPEEDS = [1, 2, 4, 8];
const CLIPS = [0, 1, 2, 5];
const GRIDS = [40, 56, 72, 88];
const TRAJS = [80, 150, 250, 400];

export default function NodePanel({
  config,
  setConfig,
  running,
  onStart,
  onPause,
  onReset,
  onStep,
  onGradCheck,
  gradResult,
  onAdjointCheck,
  adjointResult,
  metrics,
  paramCount,
  slots,
  onSave,
  onLoadSlot,
  onDeleteSlot,
  onShare,
  shareMsg,
}: Props) {
  const [slotName, setSlotName] = useState('node-1');
  const set = <K extends keyof NodeConfigUI>(key: K, value: NodeConfigUI[K]) => setConfig((c) => ({ ...c, [key]: value }));
  const showSched = config.scheduleKind !== 'constant';
  const solver = SOLVERS.find((s) => s.id === config.solver) ?? SOLVERS[2];
  const nfe = config.steps * solver.nfe;

  return (
    <aside className="panel">
      <section className="group">
        <h3>Dataset</h3>
        <label className="field">
          <span>Shape</span>
          <select value={config.dataset} onChange={(e) => set('dataset', e.target.value as NodeConfigUI['dataset'])}>
            {NODE_DATASETS.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Samples · {config.samples}</span>
          <input type="range" min={300} max={3000} step={100} value={config.samples} onChange={(e) => set('samples', Number(e.target.value))} />
        </label>
        <label className="field">
          <span>Noise · {config.noise.toFixed(2)}</span>
          <input type="range" min={0} max={0.3} step={0.01} value={config.noise} onChange={(e) => set('noise', Number(e.target.value))} />
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
          Continuous-depth net <span className="muted small">· {paramCount} params</span>
        </h3>
        <label className="field">
          <span>
            Augment dim · {config.augDim} <span className="muted small">(state R^{2 + config.augDim})</span>
          </span>
          <div className="seg">
            {AUGS.map((a) => (
              <button key={a} className={config.augDim === a ? 'on' : ''} onClick={() => set('augDim', a)}>
                {a}
              </button>
            ))}
          </div>
        </label>
        <div className="two">
          <label className="field">
            <span>Field width</span>
            <select value={config.hidden} onChange={(e) => set('hidden', Number(e.target.value))}>
              {HIDDENS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Field depth</span>
            <select value={config.depth} onChange={(e) => set('depth', Number(e.target.value))}>
              {DEPTHS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="field">
          <span>Field activation</span>
          <select value={config.activation} onChange={(e) => set('activation', e.target.value as Activation)}>
            {ACTS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <p className="muted small arch-desc">
          dz/dt = f_θ(z, t); prediction = head(z(1)). Augment dim 0 confines the flow to the plane — a homeomorphism that
          can’t separate nested rings. Raise it to lift points into extra channels.
        </p>
      </section>

      <section className="group">
        <h3>
          ODE solver <span className="muted small">· {nfe} fn-evals</span>
        </h3>
        <label className="field">
          <span>Integrator</span>
          <div className="seg">
            {SOLVERS.map((s) => (
              <button key={s.id} className={config.solver === s.id ? 'on' : ''} onClick={() => set('solver', s.id as Solver)}>
                {s.id === 'euler' ? 'Euler' : s.id === 'midpoint' ? 'RK2' : 'RK4'}
              </button>
            ))}
          </div>
        </label>
        <label className="field">
          <span>Steps · {config.steps}</span>
          <div className="seg">
            {STEPS.map((v) => (
              <button key={v} className={config.steps === v ? 'on' : ''} onClick={() => set('steps', v)}>
                {v}
              </button>
            ))}
          </div>
        </label>
        <p className="muted small arch-desc">
          {solver.label} · order {solver.order}. "Depth" is integration time t∈[0,1] sliced into {config.steps} steps ({nfe} field
          evaluations). Back-prop runs straight through every step.
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
            <span>Trajectories</span>
            <select value={config.trajCount} onChange={(e) => set('trajCount', Number(e.target.value))}>
              {TRAJS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="field">
          <span>Decision grid</span>
          <select value={config.gridRes} onChange={(e) => set('gridRes', Number(e.target.value))}>
            {GRIDS.map((v) => (
              <option key={v} value={v}>
                {v}×{v}
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
            <span className="muted small">train acc</span>
            <b>{Number.isFinite(metrics.trainAcc) ? `${(metrics.trainAcc * 100).toFixed(1)}%` : '—'}</b>
          </div>
          <div className="stat">
            <span className="muted small">val acc</span>
            <b>{Number.isFinite(metrics.valAcc) ? `${(metrics.valAcc * 100).toFixed(1)}%` : '—'}</b>
          </div>
        </div>
      </section>

      <section className="group">
        <h3>Gradient check</h3>
        <p className="muted small">Finite differences vs. back-prop through the whole solver (every RK step on the tape).</p>
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
            <div className="muted small">{gradResult.maxRelError < 1e-3 ? '✓ dynamics + head verified' : '⚠ check setup'}</div>
          </div>
        )}
      </section>

      <section className="group">
        <h3>Adjoint method</h3>
        <p className="muted small">
          The O(1)-memory gradient: a second ODE integrated backwards in time. Compares it to back-prop-through-the-solver on a
          live batch — they should agree to the solver’s truncation error.
        </p>
        <button className="ghost wide" onClick={onAdjointCheck}>
          Run adjoint vs back-prop
        </button>
        {adjointResult && (
          <div className={`gradres ${adjointResult.relL2 < 1e-3 ? 'ok' : 'warn'}`}>
            <div>
              rel. L2 gap <b>{adjointResult.relL2.toExponential(2)}</b>
            </div>
            <div>
              max rel <b>{adjointResult.maxRel.toExponential(2)}</b> · cos <b>{adjointResult.cosine.toFixed(6)}</b>
            </div>
            <div className="muted small">
              {adjointResult.paramCount} dynamics grads · {adjointResult.steps} steps
              {adjointResult.relL2 < 1e-3 ? ' · ✓ adjoint matches back-prop' : ' · raise steps to tighten'}
            </div>
          </div>
        )}
      </section>

      <section className="group">
        <h3>Engine self-test</h3>
        <p className="muted small">Gradcheck every op — now including a whole Neural ODE, RK4 exactness &amp; the adjoint identity.</p>
        <SelfTestPanel />
      </section>

      <section className="group">
        <h3>Save &amp; share</h3>
        <div className="save-row">
          <input className="slot-input" value={slotName} onChange={(e) => setSlotName(e.target.value)} placeholder="slot name" />
          <button className="ghost" onClick={() => onSave(slotName.trim() || 'node')}>
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
