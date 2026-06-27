import { useEffect, useState } from 'react';
import { useRnnTrainer, type RnnTrainerConfig } from '../../hooks/useRnnTrainer';
import type { GradCheckResult } from '../../engine/gradcheck';
import { RNN_TASKS } from '../../engine/charseq';
import LossChart from '../LossChart';
import RnnPanel from './RnnPanel';
import HiddenStateView from './HiddenStateView';
import GateView from './GateView';
import GradientFlowView from './GradientFlowView';
import GenerateBox from './GenerateBox';
import SamplePredictions from './SamplePredictions';

const DEFAULT_CONFIG: RnnTrainerConfig = {
  cell: 'lstm',
  task: 'recall',
  len: 12,
  embDim: 16,
  hidden: 32,
  nLayers: 1,
  optimizer: 'adamw',
  lr: 0.01,
  weightDecay: 0.0001,
  batchSize: 16,
  stepsPerFrame: 4,
  clipNorm: 1,
  seed: 1,
  loadId: 0,
};

export default function RnnLab() {
  const [config, setConfig] = useState<RnnTrainerConfig>(DEFAULT_CONFIG);
  const trainer = useRnnTrainer(config);
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
  const taskInfo = RNN_TASKS.find((t) => t.kind === handle.task)!;

  return (
    <div className="lab seq-lab">
      <RnnPanel
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
        <GradientFlowView />
        {model && probe && <HiddenStateView model={model} task={handle.task} sample={probe} tick={tick} />}
        {model && probe && (handle.cell === 'gru' || handle.cell === 'lstm') && (
          <GateView model={model} task={handle.task} sample={probe} tick={tick} />
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
      </div>

      <div className="seq-right">
        {model && taskInfo.generative && <GenerateBox model={model} task={handle.task} len={handle.len} />}
        {model && <SamplePredictions model={model} task={handle.task} len={handle.len} tick={tick} />}
      </div>
    </div>
  );
}
