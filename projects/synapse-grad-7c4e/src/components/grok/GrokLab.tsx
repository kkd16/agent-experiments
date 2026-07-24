import { useEffect, useState } from 'react';
import { useGrokTrainer, type GrokTrainerConfig } from '../../hooks/useGrokTrainer';
import type { GradCheckResult } from '../../engine/gradcheck';
import { GROK_OPS, type GrokOp } from '../../engine/grok';
import {
  listSlots,
  loadSlot,
  saveSlot,
  deleteSlot,
  makeState,
  shareUrl,
  writeHashState,
  readHashState,
  GROK_SLOT_PREFIX,
} from '../../engine/serialize';
import GrokPanel from './GrokPanel';
import GrokCurve from './GrokCurve';
import MechanismChart from './MechanismChart';
import EmbeddingCircle from './EmbeddingCircle';
import FourierSpectrum from './FourierSpectrum';
import CayleyTable from './CayleyTable';

const HASH_KEY = 'w';

// The verified default: p=13 modular addition, 60% of the table shown, a 1-layer 4-head
// Transformer (7.6k params), full-batch AdamW at lr 2e-3 with weight decay 2.5. This configuration
// memorizes within ~200 steps (train → 100%, held-out at chance) and then groks — held-out accuracy
// leaps to 100% around step ~800 and holds there — fast enough to watch the whole arc live, while
// its Fourier spectrum develops visible key frequencies. (Turn weight decay to 0 to watch it
// memorize forever; raise p or lower the train fraction to lengthen the plateau.)
const DEFAULT_CONFIG: GrokTrainerConfig = {
  p: 13,
  op: 'add',
  trainFrac: 0.6,
  dModel: 24,
  nHeads: 4,
  dFF: 96,
  lr: 0.002,
  weightDecay: 2.5,
  batchSize: 0,
  stepsPerFrame: 2,
  clipNorm: 0,
  seed: 1,
  loadId: 0,
};

function sanitize(raw: unknown): GrokTrainerConfig {
  const c = (raw ?? {}) as Partial<GrokTrainerConfig>;
  const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const op: GrokOp = GROK_OPS.some((o) => o.kind === c.op) ? (c.op as GrokOp) : DEFAULT_CONFIG.op;
  return {
    ...DEFAULT_CONFIG,
    ...c,
    op,
    p: Math.max(5, Math.min(31, Math.round(num(c.p, DEFAULT_CONFIG.p)))),
    trainFrac: Math.max(0.2, Math.min(0.8, num(c.trainFrac, DEFAULT_CONFIG.trainFrac))),
    dModel: Math.max(8, Math.min(64, Math.round(num(c.dModel, DEFAULT_CONFIG.dModel)))),
    nHeads: [1, 2, 4].includes(Number(c.nHeads)) ? Number(c.nHeads) : DEFAULT_CONFIG.nHeads,
    dFF: Math.max(16, Math.min(256, Math.round(num(c.dFF, DEFAULT_CONFIG.dFF)))),
    weightDecay: Math.max(0, Math.min(10, num(c.weightDecay, DEFAULT_CONFIG.weightDecay))),
    lr: Math.max(1e-5, Math.min(0.05, num(c.lr, DEFAULT_CONFIG.lr))),
    batchSize: Math.max(0, Math.min(1024, Math.round(num(c.batchSize, DEFAULT_CONFIG.batchSize)))),
  };
}

interface Phase {
  key: string;
  label: string;
  detail: string;
  tone: 'idle' | 'memo' | 'grok' | 'done';
}

function phaseOf(trainAcc: number, testAcc: number, wd: number): Phase {
  if (!Number.isFinite(trainAcc)) return { key: 'init', label: 'Ready', detail: 'press Train to begin', tone: 'idle' };
  if (trainAcc < 0.9)
    return { key: 'learn', label: 'Learning', detail: 'fitting the training pairs', tone: 'memo' };
  if (testAcc < 0.55) {
    const extra = wd === 0 ? ' — with weight decay off it will stay here forever' : ' — keep training…';
    return { key: 'memo', label: 'Memorizing', detail: `train solved, held-out at chance${extra}`, tone: 'memo' };
  }
  if (testAcc < 0.95)
    return { key: 'grok', label: 'Grokking!', detail: 'held-out accuracy is climbing — the algorithm is forming', tone: 'grok' };
  return { key: 'done', label: 'Generalized', detail: 'the network derived the rule it was never shown', tone: 'done' };
}

export default function GrokLab() {
  const [config, setConfig] = useState<GrokTrainerConfig>(DEFAULT_CONFIG);
  const trainer = useGrokTrainer(config);
  const [gradResult, setGradResult] = useState<GradCheckResult | null>(null);
  const [slots, setSlots] = useState<string[]>(() => listSlots(GROK_SLOT_PREFIX));
  const [shareMsg, setShareMsg] = useState<string | null>(null);
  const { handle, metrics, running, tick } = trainer;
  const gpt = handle.gpt;
  const ds = handle.ds;

  const onGradCheck = () => setGradResult(trainer.runGradCheck());

  useEffect(() => {
    const st = readHashState<GrokTrainerConfig>(HASH_KEY);
    if (st && st.weights?.length) {
      trainer.prepareLoad(st.weights, st.step ?? 0);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setConfig({ ...sanitize(st.config), loadId: 1 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onSave = (name: string) => {
    const { weights, step } = trainer.snapshot();
    if (saveSlot(name, makeState(config, weights, step), GROK_SLOT_PREFIX)) setSlots(listSlots(GROK_SLOT_PREFIX));
  };
  const onLoadSlot = (name: string) => {
    const st = loadSlot<GrokTrainerConfig>(name, GROK_SLOT_PREFIX);
    if (!st) return;
    trainer.prepareLoad(st.weights, st.step ?? 0);
    setConfig((c) => ({ ...sanitize(st.config), loadId: c.loadId + 1 }));
  };
  const onDeleteSlot = (name: string) => {
    deleteSlot(name, GROK_SLOT_PREFIX);
    setSlots(listSlots(GROK_SLOT_PREFIX));
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

  const phase = phaseOf(metrics.trainAcc, metrics.testAcc, config.weightDecay);
  const opInfo = GROK_OPS.find((o) => o.kind === config.op);

  return (
    <div className="lab seq-lab">
      <GrokPanel
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
        <div className={`grok-phase tone-${phase.tone}`}>
          <div className="grok-phase-badge">{phase.label}</div>
          <div className="grok-phase-detail">{phase.detail}</div>
        </div>

        <div className="card">
          <div className="card-title">
            Generalization curve <span className="muted small">· train vs held-out accuracy on a log-step axis</span>
          </div>
          <GrokCurve history={metrics.history} grokStep={metrics.grokStep} width={560} height={190} />
          <p className="muted small chart-foot">
            The <b style={{ color: '#fbbf24' }}>train</b> curve saturates almost immediately; the{' '}
            <b style={{ color: '#4ade80' }}>held-out</b> curve sits at the memorization plateau, then groks — the
            shaded band is the “memorized but not understood” gap.
          </p>
        </div>

        <div className="card">
          <div className="card-title">
            Cayley table <span className="muted small">· {opInfo?.formula} — held-out cells fill in at grokking</span>
          </div>
          {gpt && ds ? (
            <CayleyTable gpt={gpt} ds={ds} step={metrics.step} running={running} width={300} />
          ) : (
            <p className="muted small">building…</p>
          )}
        </div>

        <div className="card">
          <div className="card-title">
            Why it happens <span className="muted small">· weight norm falls · representation sparsifies</span>
          </div>
          <MechanismChart history={metrics.history} grokStep={metrics.grokStep} width={560} height={150} />
        </div>
      </div>

      <div className="seq-right">
        <div className="card">
          <div className="card-title">
            Embedding circle <span className="muted small">· the learned representation of each number</span>
          </div>
          {gpt ? (
            <EmbeddingCircle gpt={gpt} p={config.p} tick={tick} width={300} height={300} />
          ) : (
            <p className="muted small">building…</p>
          )}
        </div>

        <div className="card">
          <div className="card-title">
            Fourier spectrum <span className="muted small">· DFT of the embedding table</span>
          </div>
          <FourierSpectrum spectrum={metrics.spectrum} width={300} height={130} />
          <p className="muted small chart-foot">
            A memorizing net spreads energy across every frequency; a grokked net spikes it onto a few{' '}
            <b style={{ color: '#38bdf8' }}>key frequencies</b> — the cos/sin channels that turn addition into rotation.
          </p>
        </div>

        <div className="card grok-about">
          <div className="card-title">What am I looking at?</div>
          <p className="muted small">
            <b>Grokking</b> (Power et al., 2022): a network trained on part of a modular-arithmetic table first{' '}
            <i>memorizes</i> — perfect on what it has seen, useless on the rest — and then, long after, abruptly{' '}
            <i>generalizes</i>. Nanda et al. (2023) reverse-engineered the trick: the model places each number on a
            circle and adds by rotating. Everything here — the Transformer, its autograd, the weight-decayed AdamW that
            drives the transition — is Synapse’s own engine; nothing is pretrained.
          </p>
        </div>
      </div>
    </div>
  );
}
