import { useEffect, useState } from 'react';
import { useNtmTrainer, type NtmTrainerConfig } from '../../hooks/useNtmTrainer';
import type { GradCheckResult } from '../../engine/gradcheck';
import LossChart from '../LossChart';
import NtmPanel from './NtmPanel';
import MemoryView from './MemoryView';
import SequenceView from './SequenceView';

const DEFAULT_CONFIG: NtmTrainerConfig = {
  task: 'copy',
  bitWidth: 6,
  controller: 'lstm',
  controllerSize: 100,
  memLocations: 32,
  memWidth: 10,
  readHeads: 1,
  writeHeads: 1,
  shiftRange: 1,
  maxLen: 8,
  optimizer: 'rmsprop',
  lr: 0.001,
  clipNorm: 10,
  batchSize: 4,
  stepsPerFrame: 1,
  probeLen: 6,
  seed: 1,
  loadId: 0,
};

export default function NtmLab() {
  const [config, setConfig] = useState<NtmTrainerConfig>(DEFAULT_CONFIG);
  const trainer = useNtmTrainer(config);
  const [gradResult, setGradResult] = useState<GradCheckResult | null>(null);
  const { handle, metrics, running, tick } = trainer;
  const model = handle.model;
  const probe = trainer.probe.current;

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

  return (
    <div className="lab seq-lab">
      <NtmPanel
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
        {model && probe && <MemoryView model={model} probe={probe} tick={tick} />}
        {model && probe && <SequenceView model={model} probe={probe} tick={tick} />}
        <div className="card">
          <div className="card-title">
            Training curves <span className="muted small">· held-out loss + bit / sequence solve rate</span>
          </div>
          <LossChart
            loss={metrics.lossHistory}
            acc={metrics.bitAccHistory}
            valAcc={metrics.seqAccHistory}
            accLabel="bit acc"
            width={560}
            height={150}
          />
          <p className="muted small chart-foot">
            Solid green = per-bit accuracy · dashed = full-sequence solve rate · rose = BCE loss.
            The curriculum length rises automatically as the machine solves each length.
          </p>
        </div>
      </div>

      <div className="seq-right">
        <div className="card">
          <div className="card-title">What is a Neural Turing Machine?</div>
          <div className="ssm-about">
            <p>
              A <b>Neural Turing Machine</b> (Graves, Wayne &amp; Danihelka, 2014) couples a neural{' '}
              <b>controller</b> to an external <b>memory matrix</b> through differentiable read/write{' '}
              <b>heads</b>. Because every memory access is a smooth function, the <i>entire</i> apparatus
              is one autograd graph — so it learns an <b>algorithm</b> by gradient descent, not just a
              function.
            </p>
            <ul>
              <li>
                <b>Content addressing</b> — cosine-similarity lookup, sharpened by a key strength β.
              </li>
              <li>
                <b>Location addressing</b> — interpolate with the previous focus, then a circular-
                convolution <b>shift</b> and a <b>sharpening</b> exponent γ.
              </li>
              <li>
                <b>Write</b> = erase + add (<code>M ⊙ (1 − w eᵀ) + w aᵀ</code>); <b>read</b> = <code>wᵀM</code>.
              </li>
            </ul>
            <p className="muted small">
              The three addressing ops — cosine similarity, the circular shift and sharpening — are
              hand-derived autograd ops, each gradchecked to ~1e-6 in the engine self-test, and the
              whole machine is gradchecked end-to-end through the copy loss. Press <kbd>g</kbd> to verify
              this model, or <b>Run engine self-test</b> for all of them.
            </p>
            <p className="muted small">
              <b>Copy</b> is the canonical demo: store a sequence, then reproduce it from memory. Watch
              the write head lay it down and the read head trace it back — and the model{' '}
              <b>generalizes past its training length</b> (the <i>gen&gt;len</i> stat).
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
