import { useState, type Dispatch, type SetStateAction } from 'react';
import type { RLConfig, RLMetrics } from '../../hooks/useRLTrainer';
import type { GradCheckResult } from '../../engine/gradcheck';
import type { Activation } from '../../engine/nn';
import { RL_ALGOS, RL_PRESETS, type RLAlgo } from '../../engine/policy';
import { GRID_LAYOUTS, type EnvKind } from '../../engine/rl-env';
import SelfTestPanel from '../SelfTestPanel';

interface Props {
  config: RLConfig;
  setConfig: Dispatch<SetStateAction<RLConfig>>;
  running: boolean;
  onStart: () => void;
  onPause: () => void;
  onReset: () => void;
  onStep: () => void;
  onResetDemo: () => void;
  onGradCheck: () => void;
  gradResult: GradCheckResult | null;
  metrics: RLMetrics;
  paramCount: number;
  slots: string[];
  onSave: (name: string) => void;
  onLoadSlot: (name: string) => void;
  onDeleteSlot: (name: string) => void;
  onShare: () => void;
  shareMsg: string | null;
}

const ACTS: Activation[] = ['tanh', 'relu', 'gelu', 'silu', 'leaky_relu'];
const PLRS = [0.001, 0.002, 0.004, 0.008, 0.015];
const VLRS = [0.002, 0.004, 0.008, 0.015, 0.03];
const GAMMAS = [0.9, 0.95, 0.97, 0.99, 0.995];
const LAMBDAS = [0.8, 0.9, 0.95, 0.97, 1];
const ENTS = [0, 0.005, 0.01, 0.02, 0.05];
const BATCHES = [500, 1000, 1500, 2500, 4000];
const CLIPS = [0, 0.5, 1, 2, 5];
const SPEEDS = [1, 2, 3, 4];
const DEMO_SPEEDS = [1, 2, 4, 8];

export default function RLPanel({
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
}: Props) {
  const [slotName, setSlotName] = useState('agent-1');
  const set = <K extends keyof RLConfig>(key: K, value: RLConfig[K]) => setConfig((c) => ({ ...c, [key]: value }));
  const usesCritic = RL_ALGOS.find((a) => a.id === config.algo)!.usesCritic;
  const isGrid = config.envKind === 'gridworld';

  return (
    <aside className="panel">
      <section className="group">
        <h3>Environment</h3>
        <div className="seg">
          <button className={config.envKind === 'cartpole' ? 'on' : ''} onClick={() => set('envKind', 'cartpole' as EnvKind)}>
            CartPole
          </button>
          <button className={isGrid ? 'on' : ''} onClick={() => set('envKind', 'gridworld' as EnvKind)}>
            GridWorld
          </button>
        </div>
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
        <p className="muted small task-blurb">
          {isGrid
            ? 'Navigate a maze to the ★ goal, avoiding ✖ pits. Reward −0.005 per move, +1 goal, −1 pit.'
            : 'Balance a pole on a cart by pushing left/right. +1 per step; the episode caps at 500.'}
        </p>
        <div className="two">
          <label className="field">
            <span>Demo</span>
            <select value={config.greedyDemo ? 'greedy' : 'sample'} onChange={(e) => set('greedyDemo', e.target.value === 'greedy')}>
              <option value="sample">sampling</option>
              <option value="greedy">greedy</option>
            </select>
          </label>
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
        </div>
        <button className="ghost wide" onClick={() => set('seed', (config.seed + 1) % 100000)}>
          ⟳ New seed &amp; weights
        </button>
      </section>

      <section className="group">
        <h3>
          Algorithm <span className="muted small">· {paramCount} params</span>
        </h3>
        <label className="field">
          <span>Method</span>
          <select value={config.algo} onChange={(e) => set('algo', e.target.value as RLAlgo)}>
            {RL_ALGOS.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </label>
        <div className="two">
          <label className="field">
            <span>Network</span>
            <select value={config.presetId} onChange={(e) => set('presetId', e.target.value)}>
              {RL_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
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
        <div className="two">
          <label className="field">
            <span>Discount γ · {config.gamma}</span>
            <select value={config.gamma} onChange={(e) => set('gamma', Number(e.target.value))}>
              {GAMMAS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>GAE λ · {config.lambda}</span>
            <select value={config.lambda} onChange={(e) => set('lambda', Number(e.target.value))} disabled={config.algo !== 'a2c'}>
              {LAMBDAS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="field">
          <span>Entropy bonus · {config.entCoef}</span>
          <select value={config.entCoef} onChange={(e) => set('entCoef', Number(e.target.value))}>
            {ENTS.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <button
          className={`chip wide${config.normAdv ? ' on' : ''}`}
          onClick={() => set('normAdv', !config.normAdv)}
          style={{ width: '100%' }}
        >
          {config.normAdv ? '✓ ' : ''}Normalize advantages
        </button>
      </section>

      <section className="group">
        <h3>Training</h3>
        <div className="two">
          <label className="field">
            <span>Policy lr</span>
            <select value={config.policyLr} onChange={(e) => set('policyLr', Number(e.target.value))}>
              {PLRS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Value lr</span>
            <select value={config.valueLr} onChange={(e) => set('valueLr', Number(e.target.value))} disabled={!usesCritic}>
              {VLRS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="field">
          <span>Batch · {config.batchSteps} env steps</span>
          <select value={config.batchSteps} onChange={(e) => set('batchSteps', Number(e.target.value))}>
            {BATCHES.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
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
            <span>Updates / frame</span>
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
        <button className="ghost wide" onClick={onResetDemo} style={{ marginBottom: 12 }}>
          ↻ Restart demo episode
        </button>
        <div className="stat-row">
          <div className="stat">
            <span className="muted small">updates</span>
            <b>{metrics.iter}</b>
          </div>
          <div className="stat">
            <span className="muted small">env steps</span>
            <b>{fmtK(metrics.envSteps)}</b>
          </div>
          <div className="stat">
            <span className="muted small">return</span>
            <b>{Number.isFinite(metrics.smoothReturn) ? metrics.smoothReturn.toFixed(1) : '—'}</b>
          </div>
          <div className="stat">
            <span className="muted small">best</span>
            <b>{Number.isFinite(metrics.bestReturn) ? metrics.bestReturn.toFixed(1) : '—'}</b>
          </div>
        </div>
      </section>

      <section className="group">
        <h3>Gradient check</h3>
        <p className="muted small">Finite differences vs. the analytic backward through the whole policy (REINFORCE objective).</p>
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
            <div className="muted small">{gradResult.maxRelError < 1e-3 ? '✓ policy gradient verified' : '⚠ check setup'}</div>
          </div>
        )}
      </section>

      <section className="group">
        <h3>Engine self-test</h3>
        <p className="muted small">Gradcheck every op — now including logSoftmax, gatherCols &amp; a whole policy network.</p>
        <SelfTestPanel />
      </section>

      <section className="group">
        <h3>Save &amp; share</h3>
        <div className="save-row">
          <input className="slot-input" value={slotName} onChange={(e) => setSlotName(e.target.value)} placeholder="slot name" />
          <button className="ghost" onClick={() => onSave(slotName.trim() || 'agent')}>
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
