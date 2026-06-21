import { useEffect, useMemo, useState } from 'react';
import { useGenTrainer, type GenConfig } from '../../hooks/useGenTrainer';
import { VAE_PRESETS } from '../../engine/vae';
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
  GEN_SLOT_PREFIX,
} from '../../engine/serialize';
import GenPanel from './GenPanel';
import LatentManifold from './LatentManifold';
import Reconstructions from './Reconstructions';
import LatentScatter from './LatentScatter';
import PriorSamples from './PriorSamples';
import Interpolation from './Interpolation';
import LatentExplorer from './LatentExplorer';
import GenChart from './GenChart';

const HASH_KEY = 'g';

const GEN_INITIAL: GenConfig = {
  dataset: 'digits',
  imgSize: 16,
  samples: 600,
  noise: 0.06,
  jitter: 0.8,
  seed: 1,
  latent: 2,
  presetId: 'standard',
  activation: 'gelu',
  optimizer: 'adamw',
  lr: 0.005,
  weightDecay: 0,
  beta: 1,
  batchSize: 32,
  stepsPerFrame: 1,
  valFraction: 0.15,
  scheduleKind: 'constant',
  schedulePeriod: 600,
  scheduleWarmup: 100,
  clipNorm: 5,
  manifoldN: 11,
  manifoldSpan: 2,
  loadId: 0,
};

function sanitizeGenConfig(raw: unknown): GenConfig {
  const c = (raw ?? {}) as Partial<GenConfig>;
  const presetId = VAE_PRESETS.some((p) => p.id === c.presetId) ? (c.presetId as string) : GEN_INITIAL.presetId;
  const dataset = c.dataset === 'shapes' || c.dataset === 'digits' ? c.dataset : GEN_INITIAL.dataset;
  const latent = [2, 4, 8, 16].includes(Number(c.latent)) ? Number(c.latent) : GEN_INITIAL.latent;
  return {
    ...GEN_INITIAL,
    ...c,
    dataset,
    presetId,
    latent,
    imgSize: 16,
    samples: Math.max(120, Math.min(1200, Math.round(Number(c.samples) || GEN_INITIAL.samples))),
    valFraction: Math.max(0, Math.min(0.5, Number.isFinite(Number(c.valFraction)) ? Number(c.valFraction) : GEN_INITIAL.valFraction)),
    manifoldN: Math.max(5, Math.min(15, Math.round(Number(c.manifoldN) || GEN_INITIAL.manifoldN))),
    manifoldSpan: Math.max(1, Math.min(3, Number(c.manifoldSpan) || GEN_INITIAL.manifoldSpan)),
  };
}

export default function GenLab() {
  const [config, setConfig] = useState<GenConfig>(GEN_INITIAL);
  const [gradResult, setGradResult] = useState<GradCheckResult | null>(null);
  const [slots, setSlots] = useState<string[]>(() => listSlots(GEN_SLOT_PREFIX));
  const [shareMsg, setShareMsg] = useState<string | null>(null);
  const [priorSeed, setPriorSeed] = useState(7);
  const [pair, setPair] = useState<{ a: number; b: number }>({ a: 0, b: 1 });

  const {
    running,
    tick,
    metrics,
    start,
    pause,
    reset,
    stepOnce,
    runGradCheck,
    handle,
    snapshot,
    prepareLoad,
    reconstructionsFor,
    latentScatter,
    decodeManifold,
    decodePlanePoint,
    priorSamples,
    interpolate,
  } = useGenTrainer(config);

  // Restore a shared VAE experiment from the URL hash (#g=…) on first load.
  useEffect(() => {
    const st = readHashState<GenConfig>(HASH_KEY);
    if (st && Array.isArray(st.weights)) {
      prepareLoad(st.weights, st.step ?? 0);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setConfig({ ...sanitizeGenConfig(st.config), loadId: 1 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A varied, deterministic set of samples to reconstruct, spread across the dataset (and so
  // across classes, which are laid out cyclically).
  const reconIndices = useMemo(() => {
    const n = handle.data?.n ?? 0;
    if (n === 0) return [];
    const count = Math.min(12, n);
    return Array.from({ length: count }, (_, i) => Math.floor((i * n) / count));
  }, [handle.data]);

  // Keep the interpolation endpoints in range when the dataset changes.
  useEffect(() => {
    const n = handle.data?.n ?? 0;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (n > 1 && (pair.a >= n || pair.b >= n)) setPair({ a: 0, b: 1 });
  }, [handle.data, pair.a, pair.b]);

  const newPair = () => {
    const n = handle.data?.n ?? 0;
    if (n < 2) return;
    const a = Math.floor(Math.random() * n);
    let b = Math.floor(Math.random() * n);
    if (b === a) b = (b + 1) % n;
    setPair({ a, b });
  };

  const doGradCheck = () => setGradResult(runGradCheck());
  const flashShare = (msg: string) => {
    setShareMsg(msg);
    window.setTimeout(() => setShareMsg(null), 2200);
  };
  const onSave = (name: string) => {
    const { weights, step } = snapshot();
    if (saveSlot(name, makeState(config, weights, step), GEN_SLOT_PREFIX)) setSlots(listSlots(GEN_SLOT_PREFIX));
  };
  const onLoadSlot = (name: string) => {
    const st = loadSlot<GenConfig>(name, GEN_SLOT_PREFIX);
    if (!st) return;
    prepareLoad(st.weights, st.step ?? 0);
    setConfig((c) => ({ ...sanitizeGenConfig(st.config), loadId: c.loadId + 1 }));
  };
  const onDeleteSlot = (name: string) => {
    deleteSlot(name, GEN_SLOT_PREFIX);
    setSlots(listSlots(GEN_SLOT_PREFIX));
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

  const paramCount = handle.model ? handle.model.paramCount() : 0;

  return (
    <div className="lab">
      <GenPanel
        config={config}
        setConfig={setConfig}
        running={running}
        onStart={start}
        onPause={pause}
        onReset={reset}
        onStep={stepOnce}
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
        <div className="card manifold-card">
          <div className="card-title">
            Latent manifold
            <span className="muted small"> — decode a sweep of the 2-D latent plane into synthesised glyphs</span>
          </div>
          <LatentManifold imgSize={handle.imgSize} n={config.manifoldN} span={config.manifoldSpan} tick={tick} decodeManifold={decodeManifold} />
        </div>

        <div className="stage-row">
          <div className="card recon-card">
            <div className="card-title">
              Reconstructions
              <span className="muted small"> — input (top) vs. the VAE's rebuild (bottom)</span>
            </div>
            <Reconstructions handle={handle} tick={tick} indices={reconIndices} reconstructionsFor={reconstructionsFor} />
          </div>
          <div className="card chart-card">
            <div className="card-title">Training curves · −ELBO = recon + β·KL</div>
            <GenChart total={metrics.lossHistory} recon={metrics.reconHistory} kl={metrics.klHistory} valTotal={metrics.valLossHistory} width={300} height={150} />
          </div>
        </div>

        <div className="stage-row">
          <div className="card scatter-card">
            <div className="card-title">
              Latent space
              <span className="muted small"> — encoded means (PCA), coloured by class</span>
            </div>
            <LatentScatter handle={handle} tick={tick} span={config.manifoldSpan} latentScatter={latentScatter} />
          </div>
          <div className="card interp-card">
            <div className="card-title">
              Interpolation
              <button className="link interp-new" onClick={newPair}>
                ↻ new pair
              </button>
            </div>
            <Interpolation handle={handle} tick={tick} a={pair.a} b={pair.b} steps={9} interpolate={interpolate} />
          </div>
        </div>
      </main>

      <section className="neurons card">
        <div className="card-title">
          Sample from the prior
          <button className="link interp-new" onClick={() => setPriorSeed((s) => s + 1)}>
            ↻ new sample
          </button>
        </div>
        <p className="muted small">Glyphs decoded straight from z ~ N(0, I) — never seen in any dataset.</p>
        <PriorSamples handle={handle} tick={tick} seed={priorSeed} count={16} priorSamples={priorSamples} />
        <div className="card-title explorer-title">Latent explorer</div>
        <p className="muted small">Drag the axes to fly through the manifold.</p>
        <LatentExplorer handle={handle} tick={tick} decodePlanePoint={decodePlanePoint} />
      </section>
    </div>
  );
}
