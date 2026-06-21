import { useEffect, useState } from 'react';
import { useRLTrainer, type RLConfig } from '../../hooks/useRLTrainer';
import { RL_ALGOS, RL_PRESETS } from '../../engine/policy';
import { GRID_LAYOUTS } from '../../engine/rl-env';
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
import PolicyBars from './PolicyBars';
import ValueField from './ValueField';
import PhasePortrait from './PhasePortrait';

const HASH_KEY = 'r';

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
  stepsPerFrame: 1,
  demoSpeed: 2,
  greedyDemo: false,
  seed: 1,
  loadId: 0,
};

function sanitizeRLConfig(raw: unknown): RLConfig {
  const c = (raw ?? {}) as Partial<RLConfig>;
  const envKind = c.envKind === 'gridworld' ? 'gridworld' : 'cartpole';
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
  const isCart = config.envKind === 'cartpole';

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
            <span className="muted small">
              {' '}
              — the current policy acting in {isCart ? 'CartPole' : GRID_LAYOUTS.find((l) => l.id === config.gridLayoutId)?.label}, animated every frame
            </span>
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
              solvedAt={isCart ? 500 : undefined}
            />
            <p className="muted small chart-foot">
              The faint line is each batch's mean episode return; the bold line is its moving average. Entropy (amber)
              falls as the policy commits to a strategy.
            </p>
          </div>
          <div className="card">
            <div className="card-title">
              Action policy <span className="muted small">— π(a | s) for the live state</span>
            </div>
            <PolicyBars handle={handle} tick={tick} demoInfo={demoInfo} usesCritic={usesCritic} />
          </div>
        </div>
      </main>

      <section className="neurons card">
        {isCart ? (
          <>
            <div className="card-title">Policy phase portrait</div>
            <p className="muted small">
              The learned action across pole angle × angular velocity (cart centred). A clean diagonal means it has
              learned to push toward the falling side. The dot is the live state.
            </p>
            <PhasePortrait handle={handle} tick={tick} demoInfo={demoInfo} />
          </>
        ) : (
          <>
            <div className="card-title">Value &amp; policy field</div>
            <p className="muted small">
              The critic's V(s) as a heatmap with the greedy action drawn per cell. Watch value flood backward from the
              ★ goal and the arrows organise into a path while ✖ pits stay cold.
            </p>
            <ValueField handle={handle} tick={tick} />
          </>
        )}
      </section>
    </div>
  );
}
