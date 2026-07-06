import { useEffect, useState } from 'react';
import { useSeqTrainer, type SeqTrainerConfig } from '../../hooks/useSeqTrainer';
import type { GradCheckResult } from '../../engine/gradcheck';
import {
  listSlots,
  loadSlot,
  saveSlot,
  deleteSlot,
  makeState,
  shareUrl,
  writeHashState,
  readHashState,
  SEQ_SLOT_PREFIX,
} from '../../engine/serialize';
import { SEQ_TASKS, type SeqTaskKind } from '../../engine/seqtasks';
import LossChart from '../LossChart';
import SeqPanel from './SeqPanel';
import AttentionMaps from './AttentionMaps';
import AttentionRollout from './AttentionRollout';
import HeadInfluence from './HeadInfluence';
import NextTokenStrip from './NextTokenStrip';
import SamplePredictions from './SamplePredictions';
import GenerateBox from './GenerateBox';
import TokenEmbeddings from './TokenEmbeddings';

const HASH_KEY = 't';

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

// Coerce an untrusted config (from a shared link or a saved slot) back into a valid shape so a
// stale or hand-edited hash can never crash the lab.
function sanitize(raw: unknown): SeqTrainerConfig {
  const c = (raw ?? {}) as Partial<SeqTrainerConfig>;
  const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const task: SeqTaskKind = SEQ_TASKS.some((t) => t.kind === c.task) ? (c.task as SeqTaskKind) : DEFAULT_CONFIG.task;
  const maxDigits = task === 'add' ? 4 : 7;
  return {
    ...DEFAULT_CONFIG,
    ...c,
    task,
    digits: Math.max(1, Math.min(maxDigits, Math.round(num(c.digits, DEFAULT_CONFIG.digits)))),
    dModel: Math.max(8, Math.min(64, Math.round(num(c.dModel, DEFAULT_CONFIG.dModel)))),
    nHeads: [1, 2, 4].includes(Number(c.nHeads)) ? Number(c.nHeads) : DEFAULT_CONFIG.nHeads,
    nLayers: Math.max(1, Math.min(3, Math.round(num(c.nLayers, DEFAULT_CONFIG.nLayers)))),
    dFF: Math.max(16, Math.min(128, Math.round(num(c.dFF, DEFAULT_CONFIG.dFF)))),
  };
}

export default function SeqLab() {
  const [config, setConfig] = useState<SeqTrainerConfig>(DEFAULT_CONFIG);
  const trainer = useSeqTrainer(config);
  const [gradResult, setGradResult] = useState<GradCheckResult | null>(null);
  const [slots, setSlots] = useState<string[]>(() => listSlots(SEQ_SLOT_PREFIX));
  const [shareMsg, setShareMsg] = useState<string | null>(null);
  const { handle, metrics, running, tick } = trainer;
  const gpt = handle.gpt;

  const onGradCheck = () => setGradResult(trainer.runGradCheck());

  // Load a shared model straight off the URL hash on first mount.
  useEffect(() => {
    const st = readHashState<SeqTrainerConfig>(HASH_KEY);
    if (st && st.weights?.length) {
      trainer.prepareLoad(st.weights, st.step ?? 0);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setConfig({ ...sanitize(st.config), loadId: 1 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onSave = (name: string) => {
    const { weights, step } = trainer.snapshot();
    if (saveSlot(name, makeState(config, weights, step), SEQ_SLOT_PREFIX)) setSlots(listSlots(SEQ_SLOT_PREFIX));
  };
  const onLoadSlot = (name: string) => {
    const st = loadSlot<SeqTrainerConfig>(name, SEQ_SLOT_PREFIX);
    if (!st) return;
    trainer.prepareLoad(st.weights, st.step ?? 0);
    setConfig((c) => ({ ...sanitize(st.config), loadId: c.loadId + 1 }));
  };
  const onDeleteSlot = (name: string) => {
    deleteSlot(name, SEQ_SLOT_PREFIX);
    setSlots(listSlots(SEQ_SLOT_PREFIX));
  };
  const onShare = () => {
    const { weights, step } = trainer.snapshot();
    const state = makeState(config, weights, step);
    const url = shareUrl(state, HASH_KEY);
    writeHashState(state, HASH_KEY);
    try {
      void navigator.clipboard?.writeText(url);
      setShareMsg('Link copied — the trained model travels in the URL.');
    } catch {
      setShareMsg('Link is in the address bar.');
    }
    setTimeout(() => setShareMsg(null), 3200);
  };

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
        slots={slots}
        onSave={onSave}
        onLoadSlot={onLoadSlot}
        onDeleteSlot={onDeleteSlot}
        onShare={onShare}
        shareMsg={shareMsg}
      />

      <div className="seq-center">
        {gpt && probe && (
          <AttentionMaps gpt={gpt} probeIds={probe.tokens} answerStart={probe.answerStart} tick={tick} />
        )}
        {gpt && probe && (
          <AttentionRollout gpt={gpt} probeIds={probe.tokens} answerStart={probe.answerStart} tick={tick} />
        )}
        {gpt && probe && (
          <NextTokenStrip gpt={gpt} probeIds={probe.tokens} answerStart={probe.answerStart} tick={tick} />
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
        {gpt && <HeadInfluence gpt={gpt} task={handle.task} digits={handle.digits} tick={tick} running={running} />}
        {gpt && <SamplePredictions gpt={gpt} task={handle.task} digits={handle.digits} tick={tick} />}
        {gpt && <TokenEmbeddings gpt={gpt} tick={tick} />}
      </div>
    </div>
  );
}
