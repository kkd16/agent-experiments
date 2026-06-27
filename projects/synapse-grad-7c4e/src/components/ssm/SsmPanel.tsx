import type { Dispatch, SetStateAction } from 'react';
import type { SsmTrainerConfig, SsmMetrics } from '../../hooks/useSsmTrainer';
import type { GradCheckResult } from '../../engine/gradcheck';
import type { OptimizerKind } from '../../engine/optim';
import { SSM_TASKS, maxSeqLen } from '../../engine/ssmtasks';
import { defaultDtRank } from '../../engine/ssm';
import SelfTestPanel from '../SelfTestPanel';

interface Props {
  config: SsmTrainerConfig;
  setConfig: Dispatch<SetStateAction<SsmTrainerConfig>>;
  running: boolean;
  onStart: () => void;
  onPause: () => void;
  onReset: () => void;
  onStep: () => void;
  onGradCheck: () => void;
  gradResult: GradCheckResult | null;
  metrics: SsmMetrics;
  paramCount: number;
}

const OPTS: OptimizerKind[] = ['sgd', 'momentum', 'nesterov', 'rmsprop', 'adam', 'adamw'];
const DMODELS = [16, 24, 32, 48];
const STATES = [4, 8, 16, 24];
const EXPANDS = [1, 2];
const LAYERS = [1, 2, 3];
const LRS = [0.001, 0.002, 0.003, 0.005, 0.008];
const WDS = [0, 0.0001, 0.001, 0.01];
const BATCHES = [8, 16, 24, 32];
const SPEEDS = [1, 2, 4, 8];
const CLIPS = [0, 1, 2, 5];

const pct = (v: number) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '—');

export default function SsmPanel({
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
  const set = <K extends keyof SsmTrainerConfig>(key: K, value: SsmTrainerConfig[K]) =>
    setConfig((c) => ({ ...c, [key]: value }));

  const maxN = config.task === 'induction' ? 6 : config.task === 'selective' ? 6 : 7;
  const ctx = maxSeqLen(config.task, config.n);
  const dInner = config.expand * config.dModel;
  const dtRank = defaultDtRank(config.dModel, config.expand);

  return (
    <aside className="panel">
      <section className="group">
        <h3>Task</h3>
        <div className="seg four">
          {SSM_TASKS.map((t) => (
            <button
              key={t.kind}
              className={config.task === t.kind ? 'on' : ''}
              onClick={() =>
                setConfig((c) => ({ ...c, task: t.kind, n: Math.min(c.n, t.kind === 'induction' ? 6 : 7) }))
              }
            >
              {t.label}
            </button>
          ))}
        </div>
        <p className="muted small task-blurb">{SSM_TASKS.find((t) => t.kind === config.task)?.blurb}</p>
        <label className="field">
          <span>
            difficulty n = <b>{config.n}</b> · context {ctx} tokens
          </span>
          <input
            type="range"
            min={2}
            max={maxN}
            step={1}
            value={config.n}
            onChange={(e) => set('n', Number(e.target.value))}
          />
        </label>
      </section>

      <section className="group">
        <h3>
          Mamba block <span className="muted small">· d_inner {dInner}, dt_rank {dtRank}</span>
        </h3>
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
            <span>state N</span>
            <select value={config.dState} onChange={(e) => set('dState', Number(e.target.value))}>
              {STATES.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>expand</span>
            <select value={config.expand} onChange={(e) => set('expand', Number(e.target.value))}>
              {EXPANDS.map((d) => (
                <option key={d} value={d}>
                  {d}×
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
        </div>
        <div className="moe-sparsity-readout">
          <div className="moe-bigstat">
            <b>{(paramCount / 1000).toFixed(1)}k</b>
            <span className="muted small">parameters</span>
          </div>
          <div className="moe-bigstat">
            <b>O(L)</b>
            <span className="muted small">time &amp; memory</span>
          </div>
          <div className="moe-bigstat">
            <b>none</b>
            <span className="muted small">positional enc.</span>
          </div>
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
            <span className="muted small">token acc</span>
            <b>{pct(metrics.tokAcc)}</b>
          </div>
          <div className="stat">
            <span className="muted small">solved</span>
            <b>{pct(metrics.seqAcc)}</b>
          </div>
          <div className="stat">
            <span className="muted small">‖grad‖</span>
            <b>{Number.isFinite(metrics.gradNorm) ? metrics.gradNorm.toFixed(2) : '—'}</b>
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
                ? '✓ every weight verified — incl. the selective scan, causal conv & RMSNorm'
                : '⚠ unexpected disagreement'}
            </div>
          </div>
        )}
        <SelfTestPanel />
      </section>
    </aside>
  );
}
