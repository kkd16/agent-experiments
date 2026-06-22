import { useEffect, useState } from 'react';
import { useRLTrainer, type RLConfig } from '../../hooks/useRLTrainer';
import { RL_ALGOS, RL_PRESETS } from '../../engine/policy';
import { GRID_LAYOUTS, type EnvKind } from '../../engine/rl-env';
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
  RL_SLOT_PREFIX,
} from '../../engine/serialize';
import RLPanel from './RLPanel';
import EnvView from './EnvView';
import ReturnChart from './ReturnChart';
import ReturnHistogram from './ReturnHistogram';
import PolicyBars from './PolicyBars';
import ValueField from './ValueField';
import PhasePortrait from './PhasePortrait';
import PendulumField from './PendulumField';
import MountainCarField from './MountainCarField';

const HASH_KEY = 'r';

const ENV_KINDS: EnvKind[] = ['cartpole', 'gridworld', 'pendulum', 'mountaincar'];

const RL_INITIAL: RLConfig = {
  envKind: 'cartpole',
  gridLayoutId: 'cliff',
  algo: 'baseline',
  presetId: 'standard',
  activation: 'tanh',
  policyLr: 0.004,
  valueLr: 0.008,
  gamma: 0.99,
  lambda: 0.95,
  entCoef: 0.01,
  batchSteps: 1500,
  clipNorm: 0.5,
  normAdv: true,
  ppoClip: 0.2,
  ppoEpochs: 4,
  minibatch: 256,
  targetKL: 0,
  stepsPerFrame: 1,
  demoSpeed: 2,
  greedyDemo: false,
  seed: 1,
  loadId: 0,
};

// Per-environment display metadata.
const ENV_META: Record<EnvKind, { label: string; blurb: string; solvedAt?: number }> = {
  cartpole: {
    label: 'CartPole',
    blurb: 'Balance a pole on a cart by pushing left/right. +1 per step; the episode caps at 500.',
    solvedAt: 500,
  },
  gridworld: {
    label: 'GridWorld',
    blurb: 'Navigate a maze to the ★ goal, avoiding ✖ pits. Reward −0.005 per move, +1 goal, −1 pit.',
  },
  pendulum: {
    label: 'Pendulum',
    blurb:
      'Swing up and balance an underactuated pendulum with a continuous torque (a Gaussian policy). Reward −(θ²+0.1θ̇²+0.001u²); a clean swing-up reaches ≈ −150.',
  },
  mountaincar: {
    label: 'MountainCar',
    blurb:
      'Rock an underpowered car up a hill it can’t climb directly. −1 per step (with potential-based shaping to keep it learnable); reach the flag at x = 0.5.',
  },
};

function sanitizeRLConfig(raw: unknown): RLConfig {
  const c = (raw ?? {}) as Partial<RLConfig>;
  const envKind = ENV_KINDS.includes(c.envKind as EnvKind) ? (c.envKind as EnvKind) : 'cartpole';
  const algo = RL_ALGOS.some((a) => a.id === c.algo) ? c.algo! : RL_INITIAL.algo;
  const presetId = RL_PRESETS.some((p) => p.id === c.presetId) ? c.presetId! : RL_INITIAL.presetId;
  const gridLayoutId = GRID_LAYOUTS.some((l) => l.id === c.gridLayoutId) ? c.gridLayoutId! : RL_INITIAL.gridLayoutId;
  return { ...RL_INITIAL, ...c, envKind, algo, presetId, gridLayoutId };
}

export default function RLLab() {
  const [config, setConfig] = useState<RLConfig>(RL_INITIAL);
  const [gradResult, setGradResult] = useState<GradCheckResult | null>(null);
  const [slots, setSlots] = useState<string[]>(() => listSlots(RL_SLOT_PREFIX));
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
  } = useRLTrainer(config);

  // Restore a shared experiment from the URL hash (#r=…) on first load.
  useEffect(() => {
    const st = readHashState<RLConfig>(HASH_KEY);
    if (st && Array.isArray(st.weights)) {
      prepareLoad(st.weights, st.step ?? 0);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setConfig({ ...sanitizeRLConfig(st.config), loadId: 1 });
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
    if (saveSlot(name, makeState(config, weights, step), RL_SLOT_PREFIX)) setSlots(listSlots(RL_SLOT_PREFIX));
  };
  const onLoadSlot = (name: string) => {
    const st = loadSlot<RLConfig>(name, RL_SLOT_PREFIX);
    if (!st) return;
    prepareLoad(st.weights, st.step ?? 0);
    setConfig((c) => ({ ...sanitizeRLConfig(st.config), loadId: c.loadId + 1 }));
  };
  const onDeleteSlot = (name: string) => {
    deleteSlot(name, RL_SLOT_PREFIX);
    setSlots(listSlots(RL_SLOT_PREFIX));
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

  // keyboard shortcuts (mirror the other labs)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (running) pause();
        else start();
      } else if (e.key === 'r') reset();
      else if (e.key === 's' && !running) stepOnce();
      else if (e.key === 'g') setGradResult(runGradCheck());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [running, start, pause, reset, stepOnce, runGradCheck]);

  const paramCount = handle.agent ? handle.agent.paramCount() : 0;
  const usesCritic = RL_ALGOS.find((a) => a.id === config.algo)!.usesCritic;
  const meta = ENV_META[config.envKind];
  const envLabel =
    config.envKind === 'gridworld'
      ? GRID_LAYOUTS.find((l) => l.id === config.gridLayoutId)?.label ?? 'GridWorld'
      : meta.label;

  const analysis = (() => {
    switch (config.envKind) {
      case 'cartpole':
        return {
          title: 'Policy phase portrait',
          note: 'The learned action across pole angle × angular velocity (cart centred). A clean diagonal means it has learned to push toward the falling side. The dot is the live state.',
          view: <PhasePortrait handle={handle} tick={tick} demoInfo={demoInfo} />,
        };
      case 'pendulum':
        return {
          title: 'Policy torque field',
          note: 'The Gaussian policy’s mean torque across angle × angular velocity (blue = left, red = right). A solved swing-up shows an energy-pumping pinwheel. The dot is the live state.',
          view: <PendulumField handle={handle} tick={tick} demoInfo={demoInfo} />,
        };
      case 'mountaincar':
        return {
          title: 'Policy & value phase portrait',
          note: 'The greedy action across position × velocity (pink = left, sky = right) shaded by the critic’s value, with the goal line at x = 0.5. Watch the “push with your velocity” structure emerge.',
          view: <MountainCarField handle={handle} tick={tick} />,
        };
      default:
        return {
          title: 'Value & policy field',
          note: 'The critic’s V(s) as a heatmap with the greedy action drawn per cell. Watch value flood backward from the ★ goal and the arrows organise into a path while ✖ pits stay cold.',
          view: <ValueField handle={handle} tick={tick} />,
        };
    }
  })();

  return (
    <div className="lab">
      <RLPanel
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
            <span className="muted small"> — the current policy acting in {envLabel}, animated every frame</span>
          </div>
          <EnvView handle={handle} tick={tick} demoInfo={demoInfo} greedy={config.greedyDemo} />
        </div>

        <div className="stage-row">
          <div className="card chart-card">
            <div className="card-title">Learning curve · episode return + policy entropy</div>
            <ReturnChart
              raw={metrics.returnHistory}
              smooth={metrics.smoothHistory}
              entropy={metrics.entropyHistory}
              width={320}
              height={160}
              solvedAt={meta.solvedAt}
            />
            <p className="muted small chart-foot">
              The faint line is each batch's mean episode return; the bold line is its moving average. Entropy (amber)
              falls as the policy commits to a strategy.
            </p>
          </div>
          <div className="card">
            <div className="card-title">
              Action policy{' '}
              <span className="muted small">
                — {handle.agent?.continuous ? 'μ ± σ of the torque' : 'π(a | s)'} for the live state
              </span>
            </div>
            <PolicyBars handle={handle} tick={tick} demoInfo={demoInfo} usesCritic={usesCritic} />
          </div>
        </div>
      </main>

      <section className="stage-row">
        <div className="card">
          <div className="card-title">{analysis.title}</div>
          <p className="muted small">{analysis.note}</p>
          {analysis.view}
        </div>
        <div className="card chart-card">
          <div className="card-title">Return distribution · latest batch</div>
          <ReturnHistogram returns={metrics.returnDist} width={320} height={160} />
          <p className="muted small chart-foot">
            Every episode in the most recent batch, binned by return (amber = the batch mean). The spread the noisy
            learning curve hides — it tightens and slides right as the policy converges.
          </p>
        </div>
      </section>
    </div>
  );
}
