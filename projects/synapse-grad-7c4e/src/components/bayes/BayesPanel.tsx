import { useState, type Dispatch, type SetStateAction } from 'react';
import type { BayesConfigUI, BayesMetrics, UQMethod } from '../../hooks/useBayesTrainer';
import type { GradCheckResult } from '../../engine/gradcheck';
import type { OptimizerKind } from '../../engine/optim';
import type { ScheduleKind } from '../../engine/schedule';
import type { Activation } from '../../engine/nn';
import { REG_FUNCS } from '../../engine/bayes';
import SelfTestPanel from '../SelfTestPanel';

interface Props {
  config: BayesConfigUI;
  setConfig: Dispatch<SetStateAction<BayesConfigUI>>;
  running: boolean;
  onStart: () => void;
  onPause: () => void;
  onReset: () => void;
  onStep: () => void;
  onGradCheck: () => void;
  gradResult: GradCheckResult | null;
  metrics: BayesMetrics;
  paramCount: number;
  members: number;
  slots: string[];
  onSave: (name: string) => void;
  onLoadSlot: (name: string) => void;
  onDeleteSlot: (name: string) => void;
  onShare: () => void;
  shareMsg: string | null;
}

const METHODS: { id: UQMethod; label: string }[] = [
  { id: 'bbb', label: 'Bayes-by-Backprop' },
  { id: 'dropout', label: 'MC-Dropout' },
  { id: 'ensemble', label: 'Deep Ensemble' },
];
const OPTS: OptimizerKind[] = ['adam', 'adamw', 'rmsprop', 'nesterov', 'momentum', 'sgd'];
const SCHEDULES: { id: ScheduleKind; label: string }[] = [
  { id: 'constant', label: 'constant' },
  { id: 'step', label: 'step decay' },
  { id: 'cosine', label: 'cosine' },
  { id: 'warmup-cosine', label: 'warmup→cosine' },
];
const ACTS: Activation[] = ['tanh', 'silu', 'gelu', 'relu'];
const HIDDENS = [16, 32, 48, 64, 96];
const DEPTHS = [1, 2, 3];
const PRIORS = [0.1, 0.3, 0.5, 1];
const KLWS = [0, 0.1, 0.5, 1, 2];
const RHOINITS = [-5, -4, -3, -2];
const DROPS = [0.05, 0.1, 0.2, 0.3, 0.5];
const ENS = [3, 5, 8, 12];
const LRS = [0.002, 0.005, 0.01, 0.02, 0.05];
const WDS = [0, 0.0001, 0.001, 0.01];
const BATCHES = [16, 32, 64, 128];
const SPEEDS = [1, 2, 4, 8];
const PREDS = [20, 40, 60, 100];
const FUNCS = [10, 20, 40, 80];

export default function BayesPanel({
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
  members,
  slots,
  onSave,
  onLoadSlot,
  onDeleteSlot,
  onShare,
  shareMsg,
}: Props) {
  const [slotName, setSlotName] = useState('uq-1');
  const set = <K extends keyof BayesConfigUI>(key: K, value: BayesConfigUI[K]) => setConfig((c) => ({ ...c, [key]: value }));
  const showSched = config.scheduleKind !== 'constant';
  const m = config.method;

  return (
    <aside className="panel">
      <section className="group">
        <h3>Method</h3>
        <div className="seg vert">
          {METHODS.map((mm) => (
            <button key={mm.id} className={m === mm.id ? 'on' : ''} onClick={() => set('method', mm.id)}>
              {mm.label}
            </button>
          ))}
        </div>
        <p className="muted small arch-desc">
          {m === 'bbb'
            ? 'Every weight is a Gaussian q(w)=N(μ, σ²). The ELBO = data-NLL + (1/N)·KL(q‖prior); test-time weight samples give epistemic spread.'
            : m === 'dropout'
              ? 'A plain net trained with dropout, but with dropout kept ON at test time — each pass is a posterior sample (Gal & Ghahramani, 2016).'
              : `${members} independently-initialised nets; their disagreement is the epistemic signal (Lakshminarayanan et al., 2017).`}
        </p>
      </section>

      <section className="group">
        <h3>Target</h3>
        <label className="field">
          <span>Function</span>
          <select value={config.func} onChange={(e) => set('func', e.target.value as BayesConfigUI['func'])}>
            {REG_FUNCS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Train points · {config.samples}</span>
          <input type="range" min={30} max={300} step={10} value={config.samples} onChange={(e) => set('samples', Number(e.target.value))} />
        </label>
        <label className="field">
          <span>Noise σ · {config.noise.toFixed(2)}</span>
          <input type="range" min={0} max={0.4} step={0.01} value={config.noise} onChange={(e) => set('noise', Number(e.target.value))} />
        </label>
        <label className="toggle">
          <input type="checkbox" checked={config.hetero} onChange={(e) => set('hetero', e.target.checked)} /> heteroscedastic noise (grows with x)
        </label>
        <button className="ghost wide" onClick={() => set('seed', (config.seed + 1) % 100000)}>
          ⟳ Resample data &amp; weights
        </button>
      </section>

      <section className="group">
        <h3>
          Network <span className="muted small">· {paramCount} params</span>
        </h3>
        <div className="two">
          <label className="field">
            <span>Width</span>
            <select value={config.hidden} onChange={(e) => set('hidden', Number(e.target.value))}>
              {HIDDENS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Depth</span>
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
          <span>Activation</span>
          <select value={config.activation} onChange={(e) => set('activation', e.target.value as Activation)}>
            {ACTS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
      </section>

      {m === 'bbb' && (
        <section className="group">
          <h3>Variational posterior</h3>
          <div className="two">
            <label className="field">
              <span>Prior σ</span>
              <select value={config.priorSigma} onChange={(e) => set('priorSigma', Number(e.target.value))}>
                {PRIORS.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>KL weight β</span>
              <select value={config.klWeight} onChange={(e) => set('klWeight', Number(e.target.value))}>
                {KLWS.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="field">
            <span>Init ρ · σ₀≈{Math.log1p(Math.exp(config.rhoInit)).toFixed(3)}</span>
            <select value={config.rhoInit} onChange={(e) => set('rhoInit', Number(e.target.value))}>
              {RHOINITS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
        </section>
      )}

      {m === 'dropout' && (
        <section className="group">
          <h3>Dropout</h3>
          <label className="field">
            <span>Drop rate p · {config.dropP}</span>
            <div className="seg">
              {DROPS.map((v) => (
                <button key={v} className={config.dropP === v ? 'on' : ''} onClick={() => set('dropP', v)}>
                  {v}
                </button>
              ))}
            </div>
          </label>
          <p className="muted small arch-desc">Dropout stays active when sampling predictions — that is what makes the spread Bayesian.</p>
        </section>
      )}

      {m === 'ensemble' && (
        <section className="group">
          <h3>Ensemble</h3>
          <label className="field">
            <span>Members M · {config.ensembleSize}</span>
            <div className="seg">
              {ENS.map((v) => (
                <button key={v} className={config.ensembleSize === v ? 'on' : ''} onClick={() => set('ensembleSize', v)}>
                  {v}
                </button>
              ))}
            </div>
          </label>
          <p className="muted small arch-desc">Each member trains on its own shuffled stream from a different init; the predictive is their Gaussian mixture.</p>
        </section>
      )}

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
            <span>Predict samples</span>
            <select value={config.predSamples} onChange={(e) => set('predSamples', Number(e.target.value))} disabled={m === 'ensemble'}>
              {PREDS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Drawn curves</span>
            <select value={config.funcSamples} onChange={(e) => set('funcSamples', Number(e.target.value))}>
              {FUNCS.map((v) => (
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
            <span className="muted small">test RMSE</span>
            <b>{Number.isFinite(metrics.rmse) ? metrics.rmse.toFixed(3) : '—'}</b>
          </div>
          <div className="stat">
            <span className="muted small">test NLL</span>
            <b>{Number.isFinite(metrics.nll) ? metrics.nll.toFixed(3) : '—'}</b>
          </div>
          <div className="stat">
            <span className="muted small">cal. error</span>
            <b>{Number.isFinite(metrics.ece) ? metrics.ece.toFixed(3) : '—'}</b>
          </div>
        </div>
      </section>

      <section className="group">
        <h3>Gradient check</h3>
        <p className="muted small">
          {m === 'bbb' ? 'Finite differences vs. back-prop through the whole reparameterized ELBO (NLL + KL).' : 'Finite differences vs. back-prop through the Gaussian-NLL head.'}
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
            <div className="muted small">{gradResult.maxRelError < 1e-3 ? '✓ gradients verified' : '⚠ check setup'}</div>
          </div>
        )}
      </section>

      <section className="group">
        <h3>Engine self-test</h3>
        <p className="muted small">Gradcheck every op — now including the Gaussian NLL, the variational KL &amp; a Bayes-by-Backprop layer.</p>
        <SelfTestPanel />
      </section>

      <section className="group">
        <h3>Save &amp; share</h3>
        <div className="save-row">
          <input className="slot-input" value={slotName} onChange={(e) => setSlotName(e.target.value)} placeholder="slot name" />
          <button className="ghost" onClick={() => onSave(slotName.trim() || 'uq')}>
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
