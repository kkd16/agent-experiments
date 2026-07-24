import { useState, type Dispatch, type SetStateAction } from 'react';
import type { GrokTrainerConfig, GrokMetrics } from '../../hooks/useGrokTrainer';
import type { GradCheckResult } from '../../engine/gradcheck';
import { GROK_OPS } from '../../engine/grok';
import SelfTestPanel from '../SelfTestPanel';

interface Props {
  config: GrokTrainerConfig;
  setConfig: Dispatch<SetStateAction<GrokTrainerConfig>>;
  running: boolean;
  onStart: () => void;
  onPause: () => void;
  onReset: () => void;
  onStep: () => void;
  onGradCheck: () => void;
  gradResult: GradCheckResult | null;
  metrics: GrokMetrics;
  paramCount: number;
  slots: string[];
  onSave: (name: string) => void;
  onLoadSlot: (name: string) => void;
  onDeleteSlot: (name: string) => void;
  onShare: () => void;
  shareMsg: string | null;
}

const PRIMES = [7, 11, 13, 17, 23, 29];
const DMODELS = [16, 24, 32, 48];
const HEADS = [1, 2, 4];
const DFFS = [32, 64, 96, 128];
const LRS = [0.0005, 0.001, 0.002, 0.003];
const WDS = [0, 0.5, 1, 2, 2.5, 3, 5];
const FRACS = [0.3, 0.4, 0.5, 0.6, 0.7];
const BATCHES = [0, 32, 64, 128];
const SPEEDS = [1, 2, 4];

const pct = (v: number) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '—');

export default function GrokPanel({
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
  const [slotName, setSlotName] = useState('grok-1');
  const set = <K extends keyof GrokTrainerConfig>(key: K, value: GrokTrainerConfig[K]) =>
    setConfig((c) => ({ ...c, [key]: value }));

  const opInfo = GROK_OPS.find((o) => o.kind === config.op);
  const nTrain = Math.round(config.p * config.p * config.trainFrac);

  return (
    <aside className="panel">
      <section className="group">
        <h3>Task · modular arithmetic</h3>
        <div className="seg" style={{ gridTemplateColumns: 'repeat(2,1fr)' }}>
          {GROK_OPS.map((o) => (
            <button key={o.kind} className={config.op === o.kind ? 'on' : ''} onClick={() => set('op', o.kind)}>
              {o.label}
            </button>
          ))}
        </div>
        <p className="muted small task-blurb">
          learn <code>{opInfo?.formula}</code> — {opInfo?.blurb}
        </p>
        <label className="field">
          <span>modulus p</span>
          <select value={config.p} onChange={(e) => set('p', Number(e.target.value))}>
            {PRIMES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>
            train fraction <b>{(config.trainFrac * 100).toFixed(0)}%</b> · {nTrain} of {config.p * config.p} pairs
          </span>
          <div className="seg" style={{ gridTemplateColumns: 'repeat(5,1fr)' }}>
            {FRACS.map((f) => (
              <button key={f} className={config.trainFrac === f ? 'on' : ''} onClick={() => set('trainFrac', f)}>
                {(f * 100).toFixed(0)}
              </button>
            ))}
          </div>
        </label>
      </section>

      <section className="group">
        <h3>Model · {paramCount.toLocaleString()} params</h3>
        <p className="muted small task-blurb">A 1-layer decoder Transformer reads “a b =” and predicts the answer.</p>
        <div className="two">
          <label className="field">
            <span>d_model</span>
            <select value={config.dModel} onChange={(e) => set('dModel', Number(e.target.value))}>
              {DMODELS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>heads</span>
            <select value={config.nHeads} onChange={(e) => set('nHeads', Number(e.target.value))}>
              {HEADS.map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>d_ff</span>
            <select value={config.dFF} onChange={(e) => set('dFF', Number(e.target.value))}>
              {DFFS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>seed</span>
            <select value={config.seed} onChange={(e) => set('seed', Number(e.target.value))}>
              {[1, 2, 3, 4, 5].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      <section className="group">
        <h3>Optimization · AdamW</h3>
        <p className="muted small task-blurb">
          Weight decay is the ingredient that makes grokking happen — set it to 0 and the network memorizes forever.
        </p>
        <div className="two">
          <label className="field">
            <span>learning rate</span>
            <select value={config.lr} onChange={(e) => set('lr', Number(e.target.value))}>
              {LRS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>weight decay</span>
            <select value={config.weightDecay} onChange={(e) => set('weightDecay', Number(e.target.value))}>
              {WDS.map((w) => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>batch</span>
            <select value={config.batchSize} onChange={(e) => set('batchSize', Number(e.target.value))}>
              {BATCHES.map((b) => (
                <option key={b} value={b}>
                  {b === 0 ? 'full' : b}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>
              steps/frame <b>{config.stepsPerFrame}×</b>
            </span>
            <div className="seg" style={{ gridTemplateColumns: 'repeat(3,1fr)' }}>
              {SPEEDS.map((s) => (
                <button key={s} className={config.stepsPerFrame === s ? 'on' : ''} onClick={() => set('stepsPerFrame', s)}>
                  {s}×
                </button>
              ))}
            </div>
          </label>
        </div>
      </section>

      <section className="group">
        <div className="run-row">
          <button className="primary" onClick={running ? onPause : onStart}>
            {running ? '❚❚ Pause' : '▶ Train'}
          </button>
          <button className="ghost" onClick={onStep} disabled={running}>
            Step
          </button>
          <button className="ghost" onClick={onReset}>
            Reset
          </button>
        </div>
        <div className="stat-row">
          <div className="stat">
            <span className="muted small">step</span>
            <b>{metrics.step}</b>
          </div>
          <div className="stat">
            <span className="muted small">train acc</span>
            <b>{pct(metrics.trainAcc)}</b>
          </div>
          <div className="stat">
            <span className="muted small">held-out</span>
            <b>{pct(metrics.testAcc)}</b>
          </div>
          <div className="stat">
            <span className="muted small">grok step</span>
            <b>{metrics.grokStep > 0 ? metrics.grokStep : '—'}</b>
          </div>
          <div className="stat">
            <span className="muted small">‖weights‖</span>
            <b>{Number.isFinite(metrics.weightNorm) ? metrics.weightNorm.toFixed(1) : '—'}</b>
          </div>
          <div className="stat">
            <span className="muted small">DFT sparsity</span>
            <b>{metrics.spectrum ? metrics.spectrum.sparsity.toFixed(3) : '—'}</b>
          </div>
        </div>
      </section>

      <section className="group">
        <button className="ghost wide" onClick={onGradCheck}>
          ∇ Gradient-check this model
        </button>
        {gradResult && (
          <div className={`gradres ${gradResult.maxRelError < 1e-3 ? 'ok' : 'warn'}`}>
            <div>
              max rel err <b>{gradResult.maxRelError.toExponential(2)}</b>
            </div>
            <div>
              mean <b>{gradResult.meanRelError.toExponential(2)}</b> over {gradResult.checked} entries
            </div>
            <div className="muted small">
              {gradResult.maxRelError < 1e-3 ? '✓ every weight’s gradient verified' : '⚠ unexpected disagreement'}
            </div>
          </div>
        )}
        <SelfTestPanel />
      </section>

      <section className="group">
        <h3>Save &amp; share</h3>
        <div className="save-row">
          <input
            className="slot-input"
            value={slotName}
            onChange={(e) => setSlotName(e.target.value)}
            placeholder="slot name"
          />
          <button className="ghost" onClick={() => onSave(slotName.trim() || 'grok')}>
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
