import { useEffect, useState } from 'react';
import { useSsmTrainer, type SsmTrainerConfig } from '../../hooks/useSsmTrainer';
import type { GradCheckResult } from '../../engine/gradcheck';
import LossChart from '../LossChart';
import SsmPanel from './SsmPanel';
import SelectivityView from './SelectivityView';
import StateView from './StateView';
import SsmGenerateBox from './SsmGenerateBox';
import SsmSamplePredictions from './SsmSamplePredictions';

const DEFAULT_CONFIG: SsmTrainerConfig = {
  task: 'selective',
  n: 4,
  dModel: 32,
  dState: 16,
  expand: 2,
  nLayers: 2,
  optimizer: 'adamw',
  lr: 0.005,
  weightDecay: 0.0001,
  batchSize: 16,
  stepsPerFrame: 4,
  clipNorm: 1,
  seed: 1,
  loadId: 0,
};

export default function SsmLab() {
  const [config, setConfig] = useState<SsmTrainerConfig>(DEFAULT_CONFIG);
  const trainer = useSsmTrainer(config);
  const [gradResult, setGradResult] = useState<GradCheckResult | null>(null);
  const { handle, metrics, running, tick } = trainer;
  const model = handle.model;

  const onGradCheck = () => setGradResult(trainer.runGradCheck());

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (running) trainer.pause();
        else trainer.start();
      } else if (e.key === 's') trainer.stepOnce();
      else if (e.key === 'r') trainer.reset();
      else if (e.key === 'g') onGradCheck();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, trainer]);

  const probe = trainer.probe.current;

  return (
    <div className="lab seq-lab">
      <SsmPanel
        config={config}
        setConfig={setConfig}
        running={running}
        onStart={trainer.start}
        onPause={trainer.pause}
        onReset={trainer.reset}
        onStep={trainer.stepOnce}
        onGradCheck={onGradCheck}
        gradResult={gradResult}
        metrics={metrics}
        paramCount={model ? model.paramCount() : 0}
      />

      <div className="seq-center">
        {model && probe && (
          <SelectivityView model={model} probeIds={probe.tokens} answerStart={probe.answerStart} tick={tick} />
        )}
        {model && probe && (
          <StateView model={model} probeIds={probe.tokens} answerStart={probe.answerStart} tick={tick} />
        )}
        <div className="card">
          <div className="card-title">
            Training curves <span className="muted small">· held-out loss + token / sequence accuracy</span>
          </div>
          <LossChart
            loss={metrics.lossHistory}
            acc={metrics.tokAccHistory}
            valAcc={metrics.seqAccHistory}
            accLabel="token acc"
            width={560}
            height={150}
          />
          <p className="muted small chart-foot">
            Solid green = per-token accuracy · dashed = full-sequence solve rate · rose = cross-entropy loss
          </p>
        </div>
        {model && <SsmGenerateBox model={model} task={handle.task} n={handle.n} tick={tick} />}
      </div>

      <div className="seq-right">
        {model && <SsmSamplePredictions model={model} task={handle.task} n={handle.n} tick={tick} />}
        <div className="card">
          <div className="card-title">What is a selective state-space model?</div>
          <div className="ssm-about">
            <p>
              A <b>Mamba</b> block (Gu &amp; Dao, 2023) replaces attention with a <b>linear-time</b> recurrence.
              Each channel runs a tiny state-space system{' '}
              <code>h_l = Ā·h_(l-1) + B̄·x_l</code>, <code>y_l = C·h_l + D·x_l</code> — but the parameters are{' '}
              <b>input-dependent</b>: <code>Δ, B, C</code> are projected from the token itself, so the model{' '}
              <b>selects</b> what to remember per token (the <b>Δ</b> heatmap above).
            </p>
            <ul>
              <li>
                <b>O(L)</b> compute and memory — no L×L attention matrix.
              </li>
              <li>
                <b>No positional encoding</b> — order is carried by the recurrence and a short causal conv.
              </li>
              <li>
                <b>Selective-copy</b> &amp; <b>induction</b> are the paper's diagnostics: they need
                content-aware gating that a linear-time-<i>invariant</i> SSM (S4) cannot do.
              </li>
            </ul>
            <p className="muted small">
              The selective scan, causal depthwise conv and RMSNorm are hand-derived autograd ops, each
              gradchecked to ~1e-9 in the engine self-test — press <kbd>g</kbd> to verify this model end-to-end.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
