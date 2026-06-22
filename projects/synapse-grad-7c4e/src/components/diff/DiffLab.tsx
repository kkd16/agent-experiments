import { useEffect, useMemo, useState } from 'react';
import { useDiffusionTrainer, type DiffConfig, type TrajFrame } from '../../hooks/useDiffusionTrainer';
import { DIFF_PRESETS } from '../../engine/diffusion';
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
  DIFF_SLOT_PREFIX,
} from '../../engine/serialize';
import DiffPanel from './DiffPanel';
import ReverseTrajectory from './ReverseTrajectory';
import SampleGallery, { type GalleryRow } from './SampleGallery';
import NoiseSchedulePlot from './NoiseSchedulePlot';
import DiffInterpolation from './DiffInterpolation';
import DiffChart from './DiffChart';

const HASH_KEY = 'd';

const DIFF_INITIAL: DiffConfig = {
  dataset: 'digits',
  imgSize: 16,
  samples: 600,
  noise: 0.04,
  jitter: 0.7,
  seed: 1,
  presetId: 'standard',
  timeDim: 64,
  diffSchedule: 'cosine',
  T: 200,
  pUncond: 0.1,
  optimizer: 'adamw',
  lr: 0.003,
  weightDecay: 0.0001,
  batchSize: 32,
  stepsPerFrame: 2,
  valFraction: 0.15,
  scheduleKind: 'constant',
  schedulePeriod: 1500,
  scheduleWarmup: 200,
  clipNorm: 5,
  sampler: 'ddim',
  samplingSteps: 50,
  eta: 0,
  guidance: 0,
  loadId: 0,
};

function sanitize(raw: unknown): DiffConfig {
  const c = (raw ?? {}) as Partial<DiffConfig>;
  const presetId = DIFF_PRESETS.some((p) => p.id === c.presetId) ? (c.presetId as string) : DIFF_INITIAL.presetId;
  const dataset = c.dataset === 'shapes' || c.dataset === 'digits' ? c.dataset : DIFF_INITIAL.dataset;
  const diffSchedule = c.diffSchedule === 'linear' ? 'linear' : 'cosine';
  const sampler = c.sampler === 'ddpm' ? 'ddpm' : 'ddim';
  const T = [50, 100, 200, 400].includes(Number(c.T)) ? Number(c.T) : DIFF_INITIAL.T;
  return {
    ...DIFF_INITIAL,
    ...c,
    dataset,
    presetId,
    diffSchedule,
    sampler,
    T,
    imgSize: 16,
    timeDim: 64,
    samples: Math.max(120, Math.min(1200, Math.round(Number(c.samples) || DIFF_INITIAL.samples))),
    valFraction: Math.max(0, Math.min(0.4, Number.isFinite(Number(c.valFraction)) ? Number(c.valFraction) : DIFF_INITIAL.valFraction)),
  };
}

export default function DiffLab() {
  const [config, setConfig] = useState<DiffConfig>(DIFF_INITIAL);
  const [gradResult, setGradResult] = useState<GradCheckResult | null>(null);
  const [slots, setSlots] = useState<string[]>(() => listSlots(DIFF_SLOT_PREFIX));
  const [shareMsg, setShareMsg] = useState<string | null>(null);

  const [sampleCls, setSampleCls] = useState(0);
  const [sampleSeed, setSampleSeed] = useState(7);
  const [frames, setFrames] = useState<TrajFrame[]>([]);
  const [galleryRows, setGalleryRows] = useState<GalleryRow[]>([]);
  const [gallerySeed, setGallerySeed] = useState(0);
  const [interp, setInterp] = useState<{ a: number; b: number; cls: number; tick: number }>({ a: 11, b: 29, cls: 0, tick: 0 });

  const {
    running,
    metrics,
    start,
    pause,
    reset,
    stepOnce,
    runGradCheck,
    handle,
    snapshot,
    prepareLoad,
    sampleTrajectory,
    sampleFinal,
    slerpInterpolate,
    schedule,
  } = useDiffusionTrainer(config);

  // Restore a shared diffusion experiment from the URL hash (#d=…) on first load.
  useEffect(() => {
    const st = readHashState<DiffConfig>(HASH_KEY);
    if (st && Array.isArray(st.weights)) {
      prepareLoad(st.weights, st.step ?? 0);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setConfig({ ...sanitize(st.config), loadId: 1 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the chosen sampling class in range for the active dataset.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (sampleCls >= handle.classes) setSampleCls(0);
  }, [handle.classes, sampleCls]);

  const doSample = () => setFrames(sampleTrajectory(sampleCls, sampleSeed));
  const newSeedSample = () => {
    const s = Math.floor(Math.random() * 100000);
    setSampleSeed(s);
    setFrames(sampleTrajectory(sampleCls, s));
  };

  // Build the class-conditional sheet on demand only (each cell is a full sampler run, so this must
  // never fire during a training frame). A few glyphs per class keeps the click responsive.
  const resampleGallery = () => {
    const perClass = handle.classes > 5 ? 4 : 6;
    const base = gallerySeed + 1;
    setGallerySeed(base);
    const rows: GalleryRow[] = [];
    for (let c = 0; c < handle.classes; c++) {
      const cells: Float64Array[] = [];
      for (let j = 0; j < perClass; j++) cells.push(sampleFinal(c, base * 131 + c * 17 + j));
      rows.push({ label: handle.labels[c] ?? String(c), cells });
    }
    setGalleryRows(rows);
  };

  const doGradCheck = () => setGradResult(runGradCheck());
  const flashShare = (msg: string) => {
    setShareMsg(msg);
    window.setTimeout(() => setShareMsg(null), 2200);
  };
  const onSave = (name: string) => {
    const { weights, step } = snapshot();
    if (saveSlot(name, makeState(config, weights, step), DIFF_SLOT_PREFIX)) setSlots(listSlots(DIFF_SLOT_PREFIX));
  };
  const onLoadSlot = (name: string) => {
    const st = loadSlot<DiffConfig>(name, DIFF_SLOT_PREFIX);
    if (!st) return;
    prepareLoad(st.weights, st.step ?? 0);
    setConfig((c) => ({ ...sanitize(st.config), loadId: c.loadId + 1 }));
  };
  const onDeleteSlot = (name: string) => {
    deleteSlot(name, DIFF_SLOT_PREFIX);
    setSlots(listSlots(DIFF_SLOT_PREFIX));
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
  const classOptions = useMemo(() => {
    const opts: { value: number; label: string }[] = [{ value: -1, label: 'unconditional' }];
    for (let c = 0; c < handle.classes; c++) opts.push({ value: c, label: handle.labels[c] ?? String(c) });
    return opts;
  }, [handle.classes, handle.labels]);

  return (
    <div className="lab">
      <DiffPanel
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
        <div className="card traj-card">
          <div className="card-title">
            Reverse diffusion
            <span className="muted small"> — a glyph condensing out of pure noise, step by step</span>
          </div>
          <div className="traj-bar">
            <label className="inline-field">
              <span className="muted small">class</span>
              <select value={sampleCls} onChange={(e) => setSampleCls(Number(e.target.value))}>
                {classOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <button className="primary" onClick={doSample}>
              ✶ Sample
            </button>
            <button className="ghost" onClick={newSeedSample}>
              ↻ new seed
            </button>
            <span className="muted small">{config.sampler === 'ddim' ? `DDIM · ${config.samplingSteps} steps · η=${config.eta}` : `DDPM · ${config.T} steps`} · w={config.guidance}</span>
          </div>
          <ReverseTrajectory frames={frames} imgSize={handle.imgSize} />
        </div>

        <div className="stage-row">
          <div className="card gallery-card">
            <div className="card-title">
              Samples by class
              <button className="link interp-new" onClick={resampleGallery}>
                ↻ resample
              </button>
            </div>
            <p className="muted small">Each row is a trained label; each cell a fresh DDIM draw from a different seed.</p>
            <SampleGallery rows={galleryRows} imgSize={handle.imgSize} />
          </div>
          <div className="card chart-card">
            <div className="card-title">Training curve · ε-prediction MSE</div>
            <DiffChart loss={metrics.lossHistory} valLoss={metrics.valLossHistory} width={300} height={150} />
            <div className="card-title sub">Noise schedule</div>
            <NoiseSchedulePlot schedule={schedule()} width={300} height={120} />
          </div>
        </div>

        <div className="card interp-card">
          <div className="card-title">
            Noise-space interpolation
            <span className="muted small"> — slerp two seeds, decode each blend with deterministic DDIM</span>
            <button className="link interp-new" onClick={() => setInterp((p) => ({ ...p, a: Math.floor(Math.random() * 1e5), b: Math.floor(Math.random() * 1e5), tick: p.tick + 1 }))}>
              ↻ new pair
            </button>
          </div>
          <div className="traj-bar">
            <label className="inline-field">
              <span className="muted small">class</span>
              <select value={interp.cls} onChange={(e) => setInterp((p) => ({ ...p, cls: Number(e.target.value), tick: p.tick + 1 }))}>
                {classOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <DiffInterpolation cls={interp.cls} seedA={interp.a} seedB={interp.b} steps={9} imgSize={handle.imgSize} slerp={slerpInterpolate} tick={interp.tick} />
        </div>
      </main>
    </div>
  );
}
