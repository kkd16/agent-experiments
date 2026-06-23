import { useEffect, useState } from 'react';
import { useMoETrainer, type MoETrainerConfig } from '../../hooks/useMoETrainer';
import type { GradCheckResult } from '../../engine/gradcheck';
import LossChart from '../LossChart';
import MoEPanel from './MoEPanel';
import RouterHeatmap from './RouterHeatmap';
import ExpertUtilization from './ExpertUtilization';
import ExpertSpecialization from './ExpertSpecialization';
import MoEGenerateBox from './MoEGenerateBox';
import MoESamplePredictions from './MoESamplePredictions';
import BalanceChart from './BalanceChart';

const DEFAULT_CONFIG: MoETrainerConfig = {
  task: 'sort',
  digits: 4,
  dModel: 32,
  nHeads: 4,
  nLayers: 2,
  dFF: 32,
  nExperts: 6,
  topK: 2,
  loadCoef: 0.01,
  optimizer: 'adamw',
  lr: 0.003,
  weightDecay: 0.0001,
  batchSize: 24,
  stepsPerFrame: 4,
  clipNorm: 1,
  seed: 1,
  loadId: 0,
};

export default function MoELab() {
  const [config, setConfig] = useState<MoETrainerConfig>(DEFAULT_CONFIG);
  const trainer = useMoETrainer(config);
  const [gradResult, setGradResult] = useState<GradCheckResult | null>(null);
  const { handle, metrics, running, tick } = trainer;
  const moe = handle.moe;

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
      <MoEPanel
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
        paramCount={moe ? moe.paramCount() : 0}
        activeCount={moe ? moe.activeParamCount() : 0}
      />

      <div className="seq-center">
        {moe && probe && (
          <RouterHeatmap moe={moe} probeIds={probe.tokens} answerStart={probe.answerStart} tick={tick} />
        )}
        {moe && <MoEGenerateBox moe={moe} task={handle.task} digits={handle.digits} tick={tick} />}
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
        <div className="card">
          <div className="card-title">
            Load balancing <span className="muted small">· the aux loss flattening the experts over training</span>
          </div>
          <BalanceChart loadCV={metrics.loadCVHistory} aux={metrics.auxHistory} width={560} height={120} />
          <p className="muted small chart-foot">
            Violet = per-expert load imbalance (CV → 0 is balanced) · amber = Switch load-balancing aux term
          </p>
        </div>
      </div>

      <div className="seq-right">
        {moe && <ExpertUtilization moe={moe} routingStats={trainer.routingStats} tick={tick} />}
        {moe && <ExpertSpecialization moe={moe} routingStats={trainer.routingStats} tick={tick} />}
        {moe && <MoESamplePredictions moe={moe} task={handle.task} digits={handle.digits} tick={tick} />}
      </div>
    </div>
  );
}
