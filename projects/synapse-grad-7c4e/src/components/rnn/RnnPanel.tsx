import type { Dispatch, SetStateAction } from 'react';
import type { RnnTrainerConfig, RnnMetrics } from '../../hooks/useRnnTrainer';
import type { GradCheckResult } from '../../engine/gradcheck';
import type { OptimizerKind } from '../../engine/optim';
import type { CellKind } from '../../engine/recurrent';
import { RNN_TASKS } from '../../engine/charseq';
import SelfTestPanel from '../SelfTestPanel';

interface Props {
  config: RnnTrainerConfig;
  setConfig: Dispatch<SetStateAction<RnnTrainerConfig>>;
  running: boolean;
  onStart: () => void;
  onPause: () => void;
  onReset: () => void;
  onStep: () => void;
  onGradCheck: () => void;
  gradResult: GradCheckResult | null;
  metrics: RnnMetrics;
  paramCount: number;
}

const CELLS: { kind: CellKind; label: string }[] = [
  { kind: 'rnn', label: 'RNN' },
  { kind: 'gru', label: 'GRU' },
  { kind: 'lstm', label: 'LSTM' },
];
const OPTS: OptimizerKind[] = ['sgd', 'momentum', 'nesterov', 'rmsprop', 'adam', 'adamw'];
const EMBS = [8, 16, 24, 32];
const HIDDENS = [16, 24, 32, 48, 64];
const LAYERS = [1, 2, 3];
const LRS = [0.002, 0.003, 0.005, 0.01, 0.02];
const WDS = [0, 0.0001, 0.001];
const BATCHES = [8, 16, 24, 32];
const SPEEDS = [1, 2, 4, 8];
const CLIPS = [0, 1, 2, 5];

const pct = (v: number) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '—');

export default function RnnPanel({
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
  const set = <K extends keyof RnnTrainerConfig>(key: K, value: RnnTrainerConfig[K]) =>
    setConfig((c) => ({ ...c, [key]: value }));

  const info = RNN_TASKS.find((t) => t.kind === config.task)!;

  return (
    <aside className="panel">
      <section className="group">
        <h3>Cell</h3>
        <div className="seg" style={{ gridTemplateColumns: 'repeat(3,1fr)' }}>
          {CELLS.map((c) => (
            <button key={c.kind} className={config.cell === c.kind ? 'on' : ''} onClick={() => set('cell', c.kind)}>
              {c.label}
            </button>
          ))}
        </div>
        <p className="muted small task-blurb">
          {config.cell === 'rnn'
            ? 'Vanilla recurrence h_t = tanh(Wx + Uh + b). Simple — and prone to vanishing gradients.'
            : config.cell === 'gru'
              ? 'Gated Recurrent Unit: update & reset gates carry state with one less gate than an LSTM.'
              : 'Long Short-Term Memory: input/forget/output gates over a protected cell-state highway.'}
        </p>
      </section>

      <section className="group">
        <h3>Task</h3>
        <div className="seg four">
          {RNN_TASKS.map((t) => (
            <button
              key={t.kind}
              className={config.task === t.kind ? 'on' : ''}
              onClick={() =>
                setConfig((c) => ({ ...c, task: t.kind, len: RNN_TASKS.find((x) => x.kind === t.kind)!.lenDefault }))
              }
            >
              {t.label}
            </button>
          ))}
        </div>
        <p className="muted small task-blurb">{info.blurb}</p>
        <label className="field">
          <span>
            {info.lenLabel} <b>{config.len}</b>
          </span>
          <input
            type="range"
            min={info.lenMin}
            max={info.lenMax}
            step={1}
            value={config.len}
            onChange={(e) => set('len', Number(e.target.value))}
          />
        </label>
      </section>

      <section className="group">
        <h3>Model · {paramCount.toLocaleString()} params</h3>
        <div className="two">
          <label className="field">
            <span>embed</span>
            <select value={config.embDim} onChange={(e) => set('embDim', Number(e.target.value))}>
              {EMBS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>hidden</span>
            <select value={config.hidden} onChange={(e) => set('hidden', Number(e.target.value))}>
              {HIDDENS.map((h) => (
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
            <span className="muted small">grad‖·‖</span>
            <b>{Number.isFinite(metrics.gradNorm) ? metrics.gradNorm.toFixed(2) : '—'}</b>
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
            <span className="muted small">params</span>
            <b>{(paramCount / 1000).toFixed(1)}k</b>
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
                ? '✓ every weight’s gradient verified through time'
                : '⚠ unexpected disagreement'}
            </div>
          </div>
        )}
        <SelfTestPanel />
      </section>
    </aside>
  );
}
