import { useState, type Dispatch, type SetStateAction } from 'react';
import type { DQNUIConfig, DQNMetrics, DQNEnvKind } from '../../hooks/useDQNTrainer';
import { DQN_PRESETS } from '../../hooks/useDQNTrainer';
import type { GradCheckResult } from '../../engine/gradcheck';
import type { Activation } from '../../engine/nn';
import { GRID_LAYOUTS } from '../../engine/rl-env';
import SelfTestPanel from '../SelfTestPanel';

interface Props {
  config: DQNUIConfig;
  setConfig: Dispatch<SetStateAction<DQNUIConfig>>;
  running: boolean;
  onStart: () => void;
  onPause: () => void;
  onReset: () => void;
  onStep: () => void;
  onResetDemo: () => void;
  onGradCheck: () => void;
  gradResult: GradCheckResult | null;
  metrics: DQNMetrics;
  paramCount: number;
  slots: string[];
  onSave: (name: string) => void;
  onLoadSlot: (name: string) => void;
  onDeleteSlot: (name: string) => void;
  onShare: () => void;
  shareMsg: string | null;
}

const ACTS: Activation[] = ['relu', 'tanh', 'gelu', 'silu', 'leaky_relu'];
const LRS = [0.0003, 0.0005, 0.001, 0.002, 0.005];
const GAMMAS = [0.9, 0.95, 0.97, 0.99, 0.995];
const NSTEPS = [1, 2, 3, 5, 10];
const HUBERS = [0.5, 1, 2, 5];
const CLIPS = [0, 1, 5, 10];
const BUFFERS = [2000, 5000, 10000, 20000, 50000];
const BATCHES = [32, 64, 128, 256];
const WARMUPS = [200, 500, 1000, 2000];
const EPS_START = [1, 0.8, 0.5];
const EPS_END = [0.2, 0.1, 0.05, 0.01];
const EPS_DECAY = [2000, 5000, 10000, 20000, 40000];
const TARGET_PERIODS = [200, 500, 1000, 2000];
const TAUS = [0.001, 0.005, 0.01, 0.02];
const LEARN_PER = [1, 2, 3];
const STEPS_FRAME = [2, 4, 8, 16];
const DEMO_SPEEDS = [1, 2, 4, 8];

const ENV_LIST: { id: DQNEnvKind; label: string }[] = [
  { id: 'gridworld', label: 'GridWorld · discrete' },
  { id: 'cartpole', label: 'CartPole' },
  { id: 'mountaincar', label: 'MountainCar' },
];

const ENV_BLURB: Record<DQNEnvKind, string> = {
  gridworld:
    'Navigate a maze to the ★ goal, avoiding ✖ pits. One-hot states, a finite deterministic MDP — so we can compare the learned Q against the EXACT optimal Q* from value iteration.',
  cartpole: 'Balance a pole on a cart by pushing left/right (2 actions). +1 per step; the episode caps at 500.',
  mountaincar:
    'Rock an underpowered car up a hill it can’t climb directly (3 actions). −1 per step with shaping; reach the flag at x = 0.5.',
};

export default function DQNPanel(props: Props) {
  const {
    config,
    setConfig,
    running,
    onStart,
    onPause,
    onReset,
    onStep,
    onResetDemo,
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
  } = props;
  const [slotName, setSlotName] = useState('dqn-1');
  const set = <K extends keyof DQNUIConfig>(key: K, value: DQNUIConfig[K]) => setConfig((c) => ({ ...c, [key]: value }));
  const isGrid = config.envKind === 'gridworld';
  const isSoft = config.targetMode === 'soft';

  return (
    <aside className="panel">
      <section className="group">
        <h3>Environment</h3>
        <label className="field">
          <span>Task</span>
          <select value={config.envKind} onChange={(e) => set('envKind', e.target.value as DQNEnvKind)}>
            {ENV_LIST.map((env) => (
              <option key={env.id} value={env.id}>
                {env.label}
              </option>
            ))}
          </select>
        </label>
        {isGrid && (
          <label className="field">
            <span>Maze</span>
            <select value={config.gridLayoutId} onChange={(e) => set('gridLayoutId', e.target.value)}>
              {GRID_LAYOUTS.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <p className="muted small task-blurb">{ENV_BLURB[config.envKind]}</p>
        <label className="field">
          <span>Demo speed</span>
          <select value={config.demoSpeed} onChange={(e) => set('demoSpeed', Number(e.target.value))}>
            {DEMO_SPEEDS.map((v) => (
              <option key={v} value={v}>
                {v}×
              </option>
            ))}
          </select>
        </label>
        <button className="ghost wide" onClick={() => set('seed', (config.seed + 1) % 100000)}>
          ⟳ New seed &amp; weights
        </button>
      </section>

      <section className="group">
        <h3>
          Architecture <span className="muted small">· {paramCount} params</span>
        </h3>
        <div className="two">
          <label className="field">
            <span>Value head</span>
            <select value={config.arch} onChange={(e) => set('arch', e.target.value as 'plain' | 'dueling')}>
              <option value="plain">plain Q</option>
              <option value="dueling">dueling V+A</option>
            </select>
          </label>
          <label className="field">
            <span>Network</span>
            <select value={config.presetId} onChange={(e) => set('presetId', e.target.value)}>
              {DQN_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
        </div>
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
        <div className="two">
          <button className={`chip${config.double ? ' on' : ''}`} onClick={() => set('double', !config.double)} style={{ width: '100%' }}>
            {config.double ? '✓ ' : ''}Double DQN
          </button>
          <button className={`chip${config.per ? ' on' : ''}`} onClick={() => set('per', !config.per)} style={{ width: '100%' }}>
            {config.per ? '✓ ' : ''}Prioritized replay
          </button>
        </div>
        <p className="muted small task-blurb">
          Double DQN decouples action selection (online net) from evaluation (target net) to kill the max-bias; the
          dueling head learns V(s) and A(s,a) separately; PER samples surprising transitions more often.
        </p>
      </section>

      <section className="group">
        <h3>Value learning</h3>
        <div className="two">
          <label className="field">
            <span>Discount γ</span>
            <select value={config.gamma} onChange={(e) => set('gamma', Number(e.target.value))}>
              {GAMMAS.map((v) => (
                <option key={v} value={v}>
                  {v}
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
        </div>
        <div className="two">
          <label className="field">
            <span>n-step return</span>
            <select value={config.nStep} onChange={(e) => set('nStep', Number(e.target.value))}>
              {NSTEPS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Huber δ</span>
            <select value={config.huberDelta} onChange={(e) => set('huberDelta', Number(e.target.value))}>
              {HUBERS.map((v) => (
                <option key={v} value={v}>
                  {v}
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
        <h3>Exploration · ε-greedy</h3>
        <div className="two">
          <label className="field">
            <span>ε start</span>
            <select value={config.epsStart} onChange={(e) => set('epsStart', Number(e.target.value))}>
              {EPS_START.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>ε end</span>
            <select value={config.epsEnd} onChange={(e) => set('epsEnd', Number(e.target.value))}>
              {EPS_END.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="field">
          <span>ε decay · {config.epsDecaySteps} steps</span>
          <select value={config.epsDecaySteps} onChange={(e) => set('epsDecaySteps', Number(e.target.value))}>
            {EPS_DECAY.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className="group">
        <h3>Replay &amp; target net</h3>
        <div className="two">
          <label className="field">
            <span>Buffer size</span>
            <select value={config.bufferSize} onChange={(e) => set('bufferSize', Number(e.target.value))}>
              {BUFFERS.map((v) => (
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
            <span>Warmup</span>
            <select value={config.warmup} onChange={(e) => set('warmup', Number(e.target.value))}>
              {WARMUPS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Target sync</span>
            <select value={config.targetMode} onChange={(e) => set('targetMode', e.target.value as 'hard' | 'soft')}>
              <option value="hard">hard copy</option>
              <option value="soft">Polyak</option>
            </select>
          </label>
        </div>
        {isSoft ? (
          <label className="field">
            <span>τ (Polyak)</span>
            <select value={config.tau} onChange={(e) => set('tau', Number(e.target.value))}>
              {TAUS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label className="field">
            <span>Sync every · {config.targetPeriod} steps</span>
            <select value={config.targetPeriod} onChange={(e) => set('targetPeriod', Number(e.target.value))}>
              {TARGET_PERIODS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="two">
          <label className="field">
            <span>Grad steps / env step</span>
            <select value={config.learnPerStep} onChange={(e) => set('learnPerStep', Number(e.target.value))}>
              {LEARN_PER.map((v) => (
                <option key={v} value={v}>
                  {v}×
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Env steps / frame</span>
            <select value={config.stepsPerFrame} onChange={(e) => set('stepsPerFrame', Number(e.target.value))}>
              {STEPS_FRAME.map((v) => (
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
          <button className="ghost" onClick={onStep}>
            Step
          </button>
          <button className="ghost" onClick={onReset}>
            Reset
          </button>
        </div>
        <button className="ghost wide" onClick={onResetDemo} style={{ marginBottom: 12 }}>
          ↻ Restart demo episode
        </button>
        <div className="stat-row">
          <div className="stat">
            <span className="muted small">env steps</span>
            <b>{fmtK(metrics.envSteps)}</b>
          </div>
          <div className="stat">
            <span className="muted small">grad steps</span>
            <b>{fmtK(metrics.learnSteps)}</b>
          </div>
          <div className="stat">
            <span className="muted small">ε</span>
            <b>{Number.isFinite(metrics.epsilon) ? metrics.epsilon.toFixed(2) : '—'}</b>
          </div>
          <div className="stat">
            <span className="muted small">buffer</span>
            <b>{(metrics.bufferFill * 100).toFixed(0)}%</b>
          </div>
        </div>
        <div className="stat-row">
          <div className="stat">
            <span className="muted small">return</span>
            <b>{Number.isFinite(metrics.smoothReturn) ? metrics.smoothReturn.toFixed(1) : '—'}</b>
          </div>
          <div className="stat">
            <span className="muted small">best</span>
            <b>{Number.isFinite(metrics.bestReturn) ? metrics.bestReturn.toFixed(1) : '—'}</b>
          </div>
          <div className="stat">
            <span className="muted small">TD loss</span>
            <b>{Number.isFinite(metrics.tdLoss) ? metrics.tdLoss.toFixed(3) : '—'}</b>
          </div>
          <div className="stat">
            <span className="muted small">mean Q</span>
            <b>{Number.isFinite(metrics.meanQ) ? metrics.meanQ.toFixed(2) : '—'}</b>
          </div>
        </div>
        {isGrid && (
          <div className="stat-row">
            <div className="stat">
              <span className="muted small">mean |Q−Q*|</span>
              <b>{Number.isFinite(metrics.qStarErr) ? metrics.qStarErr.toFixed(3) : '—'}</b>
            </div>
            <div className="stat">
              <span className="muted small">policy match</span>
              <b>{Number.isFinite(metrics.policyMatch) ? (metrics.policyMatch * 100).toFixed(0) + '%' : '—'}</b>
            </div>
          </div>
        )}
      </section>

      <section className="group">
        <h3>Gradient check</h3>
        <p className="muted small">
          Finite differences vs. the analytic backward through the whole online Q-net and its importance-weighted Huber
          TD loss.
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
            <div className="muted small">{gradResult.maxRelError < 1e-3 ? '✓ TD gradient verified' : '⚠ check setup'}</div>
          </div>
        )}
      </section>

      <section className="group">
        <h3>Engine self-test</h3>
        <p className="muted small">
          Gradcheck every op — now including the Dueling Q-net, the weighted-Huber TD loss, and a DQN that converges to
          the value-iteration optimum.
        </p>
        <SelfTestPanel />
      </section>

      <section className="group">
        <h3>Save &amp; share</h3>
        <div className="save-row">
          <input className="slot-input" value={slotName} onChange={(e) => setSlotName(e.target.value)} placeholder="slot name" />
          <button className="ghost" onClick={() => onSave(slotName.trim() || 'dqn')}>
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

function fmtK(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1e6) return (n / 1000).toFixed(n < 1e4 ? 1 : 0) + 'k';
  return (n / 1e6).toFixed(2) + 'M';
}
