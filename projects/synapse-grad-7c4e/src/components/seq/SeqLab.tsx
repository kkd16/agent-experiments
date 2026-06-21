import { useEffect, useState } from 'react';
import { useSeqTrainer, type SeqTrainerConfig } from '../../hooks/useSeqTrainer';
import type { GradCheckResult } from '../../engine/gradcheck';
import LossChart from '../LossChart';
import SeqPanel from './SeqPanel';
import AttentionMaps from './AttentionMaps';
import SamplePredictions from './SamplePredictions';
import GenerateBox from './GenerateBox';
import TokenEmbeddings from './TokenEmbeddings';

const DEFAULT_CONFIG: SeqTrainerConfig = {
  task: 'sort',
  digits: 4,
  dModel: 32,
  nHeads: 4,
  nLayers: 2,
  dFF: 64,
  optimizer: 'adamw',
  lr: 0.003,
  weightDecay: 0.0001,
  batchSize: 24,
  stepsPerFrame: 4,
  clipNorm: 1,
  seed: 1,
  loadId: 0,
};

export default function SeqLab() {
  const [config, setConfig] = useState<SeqTrainerConfig>(DEFAULT_CONFIG);
  const trainer = useSeqTrainer(config);
  const [gradResult, setGradResult] = useState<GradCheckResult | null>(null);
  const { handle, metrics, running, tick } = trainer;
  const gpt = handle.gpt;

  const onGradCheck = () => setGradResult(trainer.runGradCheck());

  // Keyboard shortcuts, matching the masthead hint (space / s / r / g).
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
      <SeqPanel
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
        paramCount={gpt ? gpt.paramCount() : 0}
      />

      <div className="seq-center">
        {gpt && probe && (
          <AttentionMaps gpt={gpt} probeIds={probe.tokens} answerStart={probe.answerStart} tick={tick} />
        )}
        {gpt && <GenerateBox gpt={gpt} task={handle.task} digits={handle.digits} tick={tick} />}
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
        {gpt && <SamplePredictions gpt={gpt} task={handle.task} digits={handle.digits} tick={tick} />}
        {gpt && <TokenEmbeddings gpt={gpt} tick={tick} />}
      </div>
    </div>
  );
}
