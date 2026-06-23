import type { Dispatch, SetStateAction } from 'react';
import type { MoETrainerConfig, MoEMetrics } from '../../hooks/useMoETrainer';
import type { GradCheckResult } from '../../engine/gradcheck';
import type { OptimizerKind } from '../../engine/optim';
import { SEQ_TASKS, maxSeqLen } from '../../engine/seqtasks';
import SelfTestPanel from '../SelfTestPanel';

interface Props {
  config: MoETrainerConfig;
  setConfig: Dispatch<SetStateAction<MoETrainerConfig>>;
  running: boolean;
  onStart: () => void;
  onPause: () => void;
  onReset: () => void;
  onStep: () => void;
  onGradCheck: () => void;
  gradResult: GradCheckResult | null;
  metrics: MoEMetrics;
  paramCount: number;
  activeCount: number;
}

const OPTS: OptimizerKind[] = ['sgd', 'momentum', 'nesterov', 'rmsprop', 'adam', 'adamw'];
const DMODELS = [16, 32, 48, 64];
const HEADS = [1, 2, 4];
const LAYERS = [1, 2, 3];
const DFFS = [16, 32, 64];
const EXPERTS = [2, 4, 6, 8];
const LRS = [0.001, 0.002, 0.003, 0.005, 0.01];
const WDS = [0, 0.0001, 0.001, 0.01];
const AUXES = [0, 0.001, 0.01, 0.05, 0.1];
const BATCHES = [8, 16, 24, 32, 48];
const SPEEDS = [1, 2, 4, 8];
const CLIPS = [0, 1, 2, 5];

const pct = (v: number) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '—');

export default function MoEPanel({
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
  activeCount,
}: Props) {
  const set = <K extends keyof MoETrainerConfig>(key: K, value: MoETrainerConfig[K]) =>
    setConfig((c) => ({ ...c, [key]: value }));

  const maxDigits = config.task === 'add' ? 4 : 7;
  const ctx = maxSeqLen(config.task, config.digits);
  const kOptions = Array.from({ length: config.nExperts }, (_, i) => i + 1).filter((k) => k <= 4);
  const activePct = paramCount > 0 ? (100 * activeCount) / paramCount : 0;

  return (
    <aside className="panel">
      <section className="group">
        <h3>Task</h3>
        <div className="seg four">
          {SEQ_TASKS.map((t) => (
            <button
              key={t.kind}
              className={config.task === t.kind ? 'on' : ''}
              onClick={() =>
                setConfig((c) => ({ ...c, task: t.kind, digits: Math.min(c.digits, t.kind === 'add' ? 3 : 7) }))
              }
            >
              {t.label}
            </button>
          ))}
        </div>
        <p className="muted small task-blurb">{SEQ_TASKS.find((t) => t.kind === config.task)?.blurb}</p>
        <label className="field">
          <span>
            Digits <b>{config.digits}</b> · context {ctx} tokens
          </span>
          <input
            type="range"
            min={config.task === 'add' ? 1 : 2}
            max={maxDigits}
            step={1}
            value={config.digits}
            onChange={(e) => set('digits', Number(e.target.value))}
          />
        </label>
      </section>

      <section className="group">
        <h3>Sparsity · {config.nExperts} experts, top-{Math.min(config.topK, config.nExperts)}</h3>
        <div className="two">
          <label className="field">
            <span>experts (E)</span>
            <select
              value={config.nExperts}
              onChange={(e) => {
                const E = Number(e.target.value);
                setConfig((c) => ({ ...c, nExperts: E, topK: Math.min(c.topK, E, 4) }));
              }}
            >
              {EXPERTS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>active (top-k)</span>
            <select value={Math.min(config.topK, config.nExperts)} onChange={(e) => set('topK', Number(e.target.value))}>
              {kOptions.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="moe-sparsity-readout">
          <div className="moe-bigstat">
            <b>{(activeCount / 1000).toFixed(1)}k</b>
            <span className="muted small">active / token</span>
          </div>
          <div className="moe-bigstat">
            <b>{(paramCount / 1000).toFixed(1)}k</b>
            <span className="muted small">total capacity</span>
          </div>
          <div className="moe-bigstat">
            <b>{activePct.toFixed(0)}%</b>
            <span className="muted small">of params fire</span>
          </div>
        </div>
        <label className="field">
          <span>
            load-balancing aux weight <b>{config.loadCoef}</b>
          </span>
          <select value={config.loadCoef} onChange={(e) => set('loadCoef', Number(e.target.value))}>
            {AUXES.map((x) => (
              <option key={x} value={x}>
                {x === 0 ? 'off (watch it collapse)' : x}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className="group">
        <h3>Model</h3>
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
            <span>layers</span>
            <select value={config.nLayers} onChange={(e) => set('nLayers', Number(e.target.value))}>
              {LAYERS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>expert d_ff</span>
            <select value={config.dFF} onChange={(e) => set('dFF', Number(e.target.value))}>
              {DFFS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      <section className="group">
        <h3>Optimization</h3>
        <label className="field">
          <span>Optimizer</span>
          <select value={config.optimizer} onChange={(e) => set('optimizer', e.target.value as OptimizerKind)}>
            {OPTS.map((o) => (
              <option key={o} value={o}>
                {o.toUpperCase()}
              </option>
            ))}
          </select>
        </label>
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
                  {b}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>grad clip</span>
            <select value={config.clipNorm} onChange={(e) => set('clipNorm', Number(e.target.value))}>
              {CLIPS.map((c) => (
                <option key={c} value={c}>
                  {c === 0 ? 'off' : c}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="field">
          <span>
            steps / frame <b>{config.stepsPerFrame}×</b>
          </span>
          <div className="seg" style={{ gridTemplateColumns: 'repeat(4,1fr)' }}>
            {SPEEDS.map((s) => (
              <button key={s} className={config.stepsPerFrame === s ? 'on' : ''} onClick={() => set('stepsPerFrame', s)}>
                {s}×
              </button>
            ))}
          </div>
        </label>
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
            <span className="muted small">loss</span>
            <b>{Number.isFinite(metrics.loss) ? metrics.loss.toFixed(3) : '—'}</b>
          </div>
          <div className="stat">
            <span className="muted small">aux</span>
            <b>{Number.isFinite(metrics.auxLoss) ? metrics.auxLoss.toFixed(3) : '—'}</b>
          </div>
          <div className="stat">
            <span className="muted small">token acc</span>
            <b>{pct(metrics.tokAcc)}</b>
          </div>
          <div className="stat">
            <span className="muted small">solved</span>
            <b>{pct(metrics.seqAcc)}</b>
          </div>
          <div className="stat">
            <span className="muted small">load CV</span>
            <b>{Number.isFinite(metrics.loadCV) ? metrics.loadCV.toFixed(3) : '—'}</b>
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
              {gradResult.maxRelError < 1e-3
                ? '✓ every weight’s gradient verified (router + experts + aux)'
                : '⚠ unexpected disagreement'}
            </div>
          </div>
        )}
        <SelfTestPanel />
      </section>
    </aside>
  );
}
