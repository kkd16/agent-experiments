import type { Dispatch, SetStateAction } from 'react';
import type { NtmTrainerConfig, NtmMetrics } from '../../hooks/useNtmTrainer';
import type { GradCheckResult } from '../../engine/gradcheck';
import type { OptimizerKind } from '../../engine/optim';
import type { ControllerKind } from '../../engine/ntm';
import { NTM_TASKS } from '../../engine/ntmtasks';
import SelfTestPanel from '../SelfTestPanel';

interface Props {
  config: NtmTrainerConfig;
  setConfig: Dispatch<SetStateAction<NtmTrainerConfig>>;
  running: boolean;
  onStart: () => void;
  onPause: () => void;
  onReset: () => void;
  onStep: () => void;
  onGradCheck: () => void;
  gradResult: GradCheckResult | null;
  metrics: NtmMetrics;
  paramCount: number;
}

const OPTS: OptimizerKind[] = ['rmsprop', 'adam', 'adamw', 'momentum', 'nesterov', 'sgd'];
const CONTROLLERS: { id: ControllerKind; label: string }[] = [
  { id: 'lstm', label: 'LSTM' },
  { id: 'feedforward', label: 'Feed-fwd' },
];
const SIZES = [48, 64, 80, 100, 128];
const NLOCS = [16, 32, 48, 64];
const MWIDTHS = [8, 10, 12, 16];
const HEADS = [1, 2];
const SHIFTS = [1, 2];
const LRS = [0.0005, 0.001, 0.002, 0.003, 0.005];
const BATCHES = [1, 2, 4, 8];
const CLIPS = [0, 5, 10, 20];
const SPEEDS = [1, 2, 4, 8];

const pct = (v: number) => (Number.isFinite(v) ? `${(v * 100).toFixed(0)}%` : '—');

export default function NtmPanel({
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
}: Props) {
  const set = <K extends keyof NtmTrainerConfig>(key: K, value: NtmTrainerConfig[K]) =>
    setConfig((c) => ({ ...c, [key]: value }));

  return (
    <aside className="panel">
      <section className="group">
        <h3>Task</h3>
        <div className="seg three">
          {NTM_TASKS.map((t) => (
            <button key={t.kind} className={config.task === t.kind ? 'on' : ''} onClick={() => set('task', t.kind)}>
              {t.label}
            </button>
          ))}
        </div>
        <p className="muted small task-blurb">{NTM_TASKS.find((t) => t.kind === config.task)?.blurb}</p>
        <div className="two">
          <label className="field">
            <span>
              bit width W = <b>{config.bitWidth}</b>
            </span>
            <input type="range" min={4} max={8} step={1} value={config.bitWidth} onChange={(e) => set('bitWidth', Number(e.target.value))} />
          </label>
          <label className="field">
            <span>
              max length = <b>{config.maxLen}</b>
            </span>
            <input type="range" min={3} max={12} step={1} value={config.maxLen} onChange={(e) => set('maxLen', Number(e.target.value))} />
          </label>
        </div>
        <label className="field">
          <span>
            probe length = <b>{config.probeLen}</b> <span className="muted small">· what the viz renders</span>
          </span>
          <input type="range" min={2} max={10} step={1} value={config.probeLen} onChange={(e) => set('probeLen', Number(e.target.value))} />
        </label>
      </section>

      <section className="group">
        <h3>
          Controller &amp; memory <span className="muted small">· {config.memLocations}×{config.memWidth} tape</span>
        </h3>
        <div className="seg two">
          {CONTROLLERS.map((c) => (
            <button key={c.id} className={config.controller === c.id ? 'on' : ''} onClick={() => set('controller', c.id)}>
              {c.label}
            </button>
          ))}
        </div>
        <div className="two">
          <label className="field">
            <span>controller H</span>
            <select value={config.controllerSize} onChange={(e) => set('controllerSize', Number(e.target.value))}>
              {SIZES.map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>locations N</span>
            <select value={config.memLocations} onChange={(e) => set('memLocations', Number(e.target.value))}>
              {NLOCS.map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>width M</span>
            <select value={config.memWidth} onChange={(e) => set('memWidth', Number(e.target.value))}>
              {MWIDTHS.map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>shift ±</span>
            <select value={config.shiftRange} onChange={(e) => set('shiftRange', Number(e.target.value))}>
              {SHIFTS.map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>read heads</span>
            <select value={config.readHeads} onChange={(e) => set('readHeads', Number(e.target.value))}>
              {HEADS.map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>write heads</span>
            <select value={config.writeHeads} onChange={(e) => set('writeHeads', Number(e.target.value))}>
              {HEADS.map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="moe-sparsity-readout">
          <div className="moe-bigstat">
            <b>{(paramCount / 1000).toFixed(1)}k</b>
            <span className="muted small">parameters</span>
          </div>
          <div className="moe-bigstat">
            <b>{config.memLocations * config.memWidth}</b>
            <span className="muted small">memory cells</span>
          </div>
          <div className="moe-bigstat">
            <b>{metrics.curLen}</b>
            <span className="muted small">curriculum len</span>
          </div>
        </div>
      </section>

      <section className="group">
        <h3>Optimization</h3>
        <label className="field">
          <span>Optimizer</span>
          <select value={config.optimizer} onChange={(e) => set('optimizer', e.target.value as OptimizerKind)}>
            {OPTS.map((o) => (
              <option key={o} value={o}>{o.toUpperCase()}</option>
            ))}
          </select>
        </label>
        <div className="two">
          <label className="field">
            <span>learning rate</span>
            <select value={config.lr} onChange={(e) => set('lr', Number(e.target.value))}>
              {LRS.map((l) => (
                <option key={l} value={l}>{l}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>batch</span>
            <select value={config.batchSize} onChange={(e) => set('batchSize', Number(e.target.value))}>
              {BATCHES.map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>grad clip</span>
            <select value={config.clipNorm} onChange={(e) => set('clipNorm', Number(e.target.value))}>
              {CLIPS.map((c) => (
                <option key={c} value={c}>{c === 0 ? 'off' : c}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>steps / frame</span>
            <select value={config.stepsPerFrame} onChange={(e) => set('stepsPerFrame', Number(e.target.value))}>
              {SPEEDS.map((s) => (
                <option key={s} value={s}>{s}×</option>
              ))}
            </select>
          </label>
        </div>
      </section>

      <section className="group">
        <div className="run-row">
          <button className="primary" onClick={running ? onPause : onStart}>
            {running ? '❚❚ Pause' : '▶ Train'}
          </button>
          <button className="ghost" onClick={onStep} disabled={running}>Step</button>
          <button className="ghost" onClick={onReset}>Reset</button>
        </div>
        <div className="stat-row">
          <div className="stat">
            <span className="muted small">step</span>
            <b>{metrics.step}</b>
          </div>
          <div className="stat">
            <span className="muted small">loss</span>
            <b>{Number.isFinite(metrics.loss) ? metrics.loss.toFixed(3) : '—'}</b>
          </div>
          <div className="stat">
            <span className="muted small">bit acc</span>
            <b>{pct(metrics.bitAcc)}</b>
          </div>
          <div className="stat">
            <span className="muted small">solved</span>
            <b>{pct(metrics.seqAcc)}</b>
          </div>
          <div className="stat">
            <span className="muted small">gen&gt;len</span>
            <b>{pct(metrics.genAcc)}</b>
          </div>
        </div>
      </section>

      <section className="group">
        <button className="ghost wide" onClick={onGradCheck}>
          ∇ Gradient-check this model
        </button>
        {gradResult && (
          <div className={`gradres ${gradResult.maxRelError < 2e-3 ? 'ok' : 'warn'}`}>
            <div>
              max rel err <b>{gradResult.maxRelError.toExponential(2)}</b>
            </div>
            <div>
              mean <b>{gradResult.meanRelError.toExponential(2)}</b> over {gradResult.checked} entries
            </div>
            <div className="muted small">
              {gradResult.maxRelError < 2e-3
                ? '✓ every weight verified — incl. cosine addressing, the shift & sharpening'
                : '⚠ unexpected disagreement'}
            </div>
          </div>
        )}
        <SelfTestPanel />
      </section>
    </aside>
  );
}
