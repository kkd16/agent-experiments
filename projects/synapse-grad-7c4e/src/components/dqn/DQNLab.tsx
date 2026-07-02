import { useEffect, useState } from 'react';
import { useDQNTrainer, DQN_PRESETS, type DQNUIConfig, type DQNEnvKind } from '../../hooks/useDQNTrainer';
import { GRID_LAYOUTS } from '../../engine/rl-env';
import type { GradCheckResult } from '../../engine/gradcheck';
import type { Activation } from '../../engine/nn';
import {
  listSlots,
  loadSlot,
  saveSlot,
  deleteSlot,
  makeState,
  shareUrl,
  writeHashState,
  readHashState,
  DQN_SLOT_PREFIX,
} from '../../engine/serialize';
import DQNPanel from './DQNPanel';
import EnvView from './EnvView';
import QValueField from './QValueField';
import QBars from './QBars';
import GroundTruthView from './GroundTruthView';
import LearningChart from './LearningChart';
import ReplayView from './ReplayView';

const HASH_KEY = 'q';

const ENV_KINDS: DQNEnvKind[] = ['cartpole', 'gridworld', 'mountaincar'];
const ACTS: Activation[] = ['relu', 'tanh', 'gelu', 'silu', 'leaky_relu'];

const DQN_INITIAL: DQNUIConfig = {
  envKind: 'gridworld',
  gridLayoutId: 'cliff',
  arch: 'plain',
  double: true,
  per: false,
  presetId: 'small',
  activation: 'relu',
  gamma: 0.99,
  lr: 0.001,
  bufferSize: 20000,
  batch: 64,
  warmup: 1000,
  nStep: 1,
  epsStart: 1,
  epsEnd: 0.1,
  epsDecaySteps: 12000,
  targetMode: 'soft',
  targetPeriod: 500,
  tau: 0.01,
  perAlpha: 0.6,
  huberDelta: 1,
  clipNorm: 10,
  useTargetNet: true,
  useReplay: true,
  learnPerStep: 1,
  stepsPerFrame: 8,
  demoSpeed: 2,
  seed: 1,
  loadId: 0,
};

const ENV_META: Record<DQNEnvKind, { label: string; solvedAt?: number }> = {
  cartpole: { label: 'CartPole', solvedAt: 500 },
  gridworld: { label: 'GridWorld' },
  mountaincar: { label: 'MountainCar' },
};

function sanitize(raw: unknown): DQNUIConfig {
  const c = (raw ?? {}) as Partial<DQNUIConfig>;
  const envKind = ENV_KINDS.includes(c.envKind as DQNEnvKind) ? (c.envKind as DQNEnvKind) : 'gridworld';
  const presetId = DQN_PRESETS.some((p) => p.id === c.presetId) ? c.presetId! : DQN_INITIAL.presetId;
  const gridLayoutId = GRID_LAYOUTS.some((l) => l.id === c.gridLayoutId) ? c.gridLayoutId! : DQN_INITIAL.gridLayoutId;
  const arch = c.arch === 'dueling' ? 'dueling' : 'plain';
  const targetMode = c.targetMode === 'soft' ? 'soft' : 'hard';
  const activation = ACTS.includes(c.activation as Activation) ? (c.activation as Activation) : DQN_INITIAL.activation;
  return {
    ...DQN_INITIAL,
    ...c,
    envKind,
    presetId,
    gridLayoutId,
    arch,
    targetMode,
    activation,
    useTargetNet: c.useTargetNet !== false,
    useReplay: c.useReplay !== false,
  };
}

export default function DQNLab() {
  const [config, setConfig] = useState<DQNUIConfig>(DQN_INITIAL);
  const [gradResult, setGradResult] = useState<GradCheckResult | null>(null);
  const [slots, setSlots] = useState<string[]>(() => listSlots(DQN_SLOT_PREFIX));
  const [shareMsg, setShareMsg] = useState<string | null>(null);

  const {
    running,
    tick,
    metrics,
    handle,
    start,
    pause,
    reset,
    stepOnce,
    resetDemo,
    demoInfo,
    runGradCheck,
    snapshot,
    prepareLoad,
  } = useDQNTrainer(config);

  // Restore a shared experiment from the URL hash (#q=…) on first load.
  useEffect(() => {
    const st = readHashState<DQNUIConfig>(HASH_KEY);
    if (st && Array.isArray(st.weights)) {
      prepareLoad(st.weights);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setConfig({ ...sanitize(st.config), loadId: 1 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doGradCheck = () => setGradResult(runGradCheck());
  const flashShare = (msg: string) => {
    setShareMsg(msg);
    window.setTimeout(() => setShareMsg(null), 2200);
  };
  const onSave = (name: string) => {
    const { weights, step } = snapshot();
    if (saveSlot(name, makeState(config, weights, step), DQN_SLOT_PREFIX)) setSlots(listSlots(DQN_SLOT_PREFIX));
  };
  const onLoadSlot = (name: string) => {
    const st = loadSlot<DQNUIConfig>(name, DQN_SLOT_PREFIX);
    if (!st) return;
    prepareLoad(st.weights);
    setConfig((c) => ({ ...sanitize(st.config), loadId: c.loadId + 1 }));
  };
  const onDeleteSlot = (name: string) => {
    deleteSlot(name, DQN_SLOT_PREFIX);
    setSlots(listSlots(DQN_SLOT_PREFIX));
  };
  const onShare = () => {
    const { weights, step } = snapshot();
    const state = makeState(config, weights, step);
    const url = shareUrl(state, HASH_KEY);
    writeHashState(state, HASH_KEY);
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url).then(
        () => flashShare('Link copied to clipboard ✓'),
        () => flashShare('Link is in the address bar'),
      );
    } else {
      flashShare('Link is in the address bar');
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (running) pause();
        else start();
      } else if (e.key === 'r') reset();
      else if (e.key === 's') stepOnce();
      else if (e.key === 'g') setGradResult(runGradCheck());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [running, start, pause, reset, stepOnce, runGradCheck]);

  const paramCount = handle.agent ? handle.agent.paramCount() : 0;
  const meta = ENV_META[config.envKind];
  const isGrid = config.envKind === 'gridworld';
  const envLabel = isGrid
    ? GRID_LAYOUTS.find((l) => l.id === config.gridLayoutId)?.label ?? 'GridWorld'
    : meta.label;

  return (
    <div className="lab">
      <DQNPanel
        config={config}
        setConfig={setConfig}
        running={running}
        onStart={start}
        onPause={pause}
        onReset={reset}
        onStep={stepOnce}
        onResetDemo={resetDemo}
        onGradCheck={doGradCheck}
        gradResult={gradResult}
        metrics={metrics}
        paramCount={paramCount}
        slots={slots}
        onSave={onSave}
        onLoadSlot={onLoadSlot}
        onDeleteSlot={onDeleteSlot}
        onShare={onShare}
        shareMsg={shareMsg}
      />

      <main className="stage">
        <div className="card">
          <div className="card-title">
            Live agent
            <span className="muted small"> — the greedy argmax_a Q(s,a) policy acting in {envLabel}, animated every frame</span>
          </div>
          <EnvView handle={handle} tick={tick} demoInfo={demoInfo} />
        </div>

        <div className="stage-row">
          <div className="card chart-card">
            <div className="card-title">Learning curve · return, TD-loss &amp; ε</div>
            <LearningChart
              raw={metrics.returnHistory}
              smooth={metrics.smoothHistory}
              loss={metrics.lossHistory}
              eps={metrics.epsHistory}
              width={320}
              height={160}
              solvedAt={meta.solvedAt}
            />
            <p className="muted small chart-foot">
              Cyan is the episode return (bold = moving average); amber is the bootstrapped TD (Huber) loss on a log
              axis; violet is the ε-greedy exploration rate decaying to its floor.
            </p>
          </div>
          <div className="card">
            <div className="card-title">
              Action values <span className="muted small">— Q(s, a) for the live state, greedy action in green</span>
            </div>
            <QBars handle={handle} tick={tick} demoInfo={demoInfo} />
          </div>
        </div>
      </main>

      <section className="stage-row">
        <div className="card">
          <div className="card-title">Value landscape · V(s) = max_a Q(s, a)</div>
          <p className="muted small">
            {isGrid
              ? 'The learned state-value painted over every cell with the greedy action arrowed — value floods backward from the ★ goal and the arrows organise into a path, value iteration learned by a net from one-hot states.'
              : 'The learned max-Q over a 2-D slice of state space, with the live state marked — the value surface the greedy agent is climbing.'}
          </p>
          <QValueField handle={handle} tick={tick} />
        </div>
        <div className="card">
          {isGrid ? (
            <>
              <div className="card-title">Learned Q vs the exact optimum Q*</div>
              <p className="muted small">
                GridWorld is a finite MDP, so a from-scratch value-iteration solver gives the exact optimal Q*. The
                scatter collapses onto y = x and the grid turns green as the neural DQN converges to provably-optimal play.
              </p>
              <GroundTruthView handle={handle} tick={tick} gamma={config.gamma} />
            </>
          ) : (
            <>
              <div className="card-title">Experience replay buffer</div>
              <p className="muted small">
                The off-policy data store DQN samples minibatches from — a histogram of the one-step rewards of every
                transition currently held, and how full the ring buffer is.
              </p>
              <ReplayView handle={handle} tick={tick} bufferFill={metrics.bufferFill} />
            </>
          )}
        </div>
      </section>

      {isGrid && (
        <section className="stage-row">
          <div className="card">
            <div className="card-title">Experience replay buffer</div>
            <p className="muted small">
              The off-policy data store DQN samples minibatches from — a histogram of the one-step rewards of every
              transition currently held (a wall of −stepCost with rare +1 goals and −1 pits), and the ring-buffer fill.
            </p>
            <ReplayView handle={handle} tick={tick} bufferFill={metrics.bufferFill} />
          </div>
        </section>
      )}
    </div>
  );
}
