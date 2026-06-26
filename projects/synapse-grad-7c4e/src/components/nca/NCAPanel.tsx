import { useState, type Dispatch, type SetStateAction } from 'react';
import type { NCAConfigUI, NCAMetrics, NCAMode } from '../../hooks/useNCATrainer';
import type { GradCheckResult } from '../../engine/gradcheck';
import type { OptimizerKind } from '../../engine/optim';
import TargetPicker from './TargetPicker';
import SelfTestPanel from '../SelfTestPanel';

interface Props {
  config: NCAConfigUI;
  setConfig: Dispatch<SetStateAction<NCAConfigUI>>;
  running: boolean;
  onStart: () => void;
  onPause: () => void;
  onReset: () => void;
  onStep: () => void;
  onGradCheck: () => void;
  gradResult: GradCheckResult | null;
  metrics: NCAMetrics;
  paramCount: number;
  slots: string[];
  onSave: (name: string) => void;
  onLoadSlot: (name: string) => void;
  onDeleteSlot: (name: string) => void;
  onShare: () => void;
  shareMsg: string | null;
}

const MODES: { id: NCAMode; label: string; hint: string }[] = [
  { id: 'grow', label: 'Grow', hint: 'loss at exactly T steps from the seed — learns to grow, then drifts apart' },
  { id: 'persist', label: 'Persist', hint: 'a sample pool ⇒ a stable fixed point that holds its shape' },
  { id: 'regenerate', label: 'Regenerate', hint: 'pool + damage ⇒ the rule learns to regrow what you cut off' },
];
const OPTS: OptimizerKind[] = ['adam', 'adamw', 'rmsprop'];
const GRIDS = [16, 20, 24, 28, 32];
const CHANNELS = [8, 12, 16];
const HIDDENS = [48, 64, 96, 128];
const BATCHES = [2, 4, 6, 8];
const STEPCHOICES = [12, 16, 20, 24, 32, 48, 64];
const LRS = [0.0005, 0.001, 0.002, 0.005];
const CLIPS = [0, 1, 2, 5];
const SCALES = [1, 2];

export default function NCAPanel({
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
  const [slotName, setSlotName] = useState('nca-1');
  const set = <K extends keyof NCAConfigUI>(key: K, value: NCAConfigUI[K]) => setConfig((c) => ({ ...c, [key]: value }));
  const modeHint = MODES.find((m) => m.id === config.mode)?.hint ?? '';

  return (
    <aside className="panel">
      <section className="group">
        <h3>Target organism</h3>
        <TargetPicker targetId={config.target} onPick={(id) => set('target', id)} />
        <p className="muted small">Every glyph is SDF-rendered procedurally — no bundled images.</p>
      </section>

      <section className="group">
        <h3>Training recipe</h3>
        <div className="seg three">
          {MODES.map((m) => (
            <button key={m.id} className={config.mode === m.id ? 'on' : ''} onClick={() => set('mode', m.id)}>
              {m.label}
            </button>
          ))}
        </div>
        <p className="muted small">{modeHint}</p>
        {config.mode === 'regenerate' && (
          <label className="field">
            <span>Damage radius · {(config.damageRadius * 100).toFixed(0)}% of grid</span>
            <input type="range" min={0.1} max={0.4} step={0.02} value={config.damageRadius} onChange={(e) => set('damageRadius', Number(e.target.value))} />
          </label>
        )}
      </section>

      <section className="group">
        <h3>
          CA rule <span className="muted small">· {paramCount.toLocaleString()} params</span>
        </h3>
        <div className="two">
          <label className="field">
            <span>Grid</span>
            <select value={config.grid} onChange={(e) => set('grid', Number(e.target.value))}>
              {GRIDS.map((v) => (
                <option key={v} value={v}>
                  {v}×{v}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Channels</span>
            <select value={config.channels} onChange={(e) => set('channels', Number(e.target.value))}>
              {CHANNELS.map((v) => (
                <option key={v} value={v}>
                  {v} (RGBA+{v - 4})
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="two">
          <label className="field">
            <span>Hidden</span>
            <select value={config.hidden} onChange={(e) => set('hidden', Number(e.target.value))}>
              {HIDDENS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Demo grid</span>
            <select value={config.demoScale} onChange={(e) => set('demoScale', Number(e.target.value))}>
              {SCALES.map((v) => (
                <option key={v} value={v}>
                  {v}× ({config.grid * v}²)
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="field">
          <span>Fire rate · {config.fireRate.toFixed(2)} (async update)</span>
          <input type="range" min={0.3} max={1} step={0.05} value={config.fireRate} onChange={(e) => set('fireRate', Number(e.target.value))} />
        </label>
        <button className="ghost wide" onClick={() => set('seed', (config.seed + 1) % 100000)}>
          ⟳ New random rule (seed {config.seed})
        </button>
      </section>

      <section className="group">
        <h3>Optimisation</h3>
        <div className="two">
          <label className="field">
            <span>Optimizer</span>
            <select value={config.optimizer} onChange={(e) => set('optimizer', e.target.value as OptimizerKind)}>
              {OPTS.map((o) => (
                <option key={o} value={o}>
                  {o}
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
        <div className="two">
          <label className="field">
            <span>Rollout min</span>
            <select value={config.stepsMin} onChange={(e) => set('stepsMin', Math.min(Number(e.target.value), config.stepsMax))}>
              {STEPCHOICES.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Rollout max</span>
            <select value={config.stepsMax} onChange={(e) => set('stepsMax', Math.max(Number(e.target.value), config.stepsMin))}>
              {STEPCHOICES.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="muted small">Each batch back-propagates through a random {config.stepsMin}–{config.stepsMax}-step rollout (BPTT).</p>
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
            <span className="muted small">MSE</span>
            <b>{Number.isFinite(metrics.loss) ? metrics.loss.toExponential(2) : '—'}</b>
          </div>
          <div className="stat">
            <span className="muted small">|grad|</span>
            <b>{Number.isFinite(metrics.gradNorm) ? metrics.gradNorm.toFixed(2) : '—'}</b>
          </div>
          <div className="stat">
            <span className="muted small">ms/step</span>
            <b>{Number.isFinite(metrics.msPerStep) ? metrics.msPerStep.toFixed(0) : '—'}</b>
          </div>
        </div>
      </section>

      <section className="group">
        <h3>Gradient check</h3>
        <p className="muted small">Finite differences vs. back-prop through a whole multi-step rollout (the tape flows through the simulation).</p>
        <button className="ghost wide" onClick={onGradCheck}>
          Check gradients (BPTT)
        </button>
        {gradResult && (
          <div className={`gradres ${gradResult.maxRelError < 1e-3 ? 'ok' : 'warn'}`}>
            <div>
              max rel err <b>{gradResult.maxRelError.toExponential(2)}</b>
            </div>
            <div>
              mean <b>{gradResult.meanRelError.toExponential(2)}</b> over {gradResult.checked} entries
            </div>
            <div className="muted small">{gradResult.maxRelError < 1e-3 ? '✓ BPTT through the CA verified' : '⚠ check setup'}</div>
          </div>
        )}
      </section>

      <section className="group">
        <h3>Engine self-test</h3>
        <p className="muted small">Gradcheck every op — now including the perceive filter bank &amp; a whole CA rollout end-to-end.</p>
        <SelfTestPanel />
      </section>

      <section className="group">
        <h3>Save &amp; share</h3>
        <div className="save-row">
          <input className="slot-input" value={slotName} onChange={(e) => setSlotName(e.target.value)} placeholder="slot name" />
          <button className="ghost" onClick={() => onSave(slotName.trim() || 'nca')}>
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
                    ✕
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
        <button className="ghost wide" onClick={onShare} style={{ marginTop: 8 }}>
          🔗 Copy share link
        </button>
        {shareMsg && <p className="muted small">{shareMsg}</p>}
      </section>
    </aside>
  );
}
