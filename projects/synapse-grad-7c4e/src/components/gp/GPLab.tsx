import { useEffect, useState } from 'react';
import { useGPTrainer, type GPConfigUI, type SharedGP } from '../../hooks/useGPTrainer';
import { GP_KERNELS, GP_DATASETS } from '../../engine/gp';
import type { GradCheckResult } from '../../engine/gradcheck';
import { makeState, shareUrl, writeHashState, readHashState } from '../../engine/serialize';
import GPPanel from './GPPanel';
import PosteriorPlot from './PosteriorPlot';
import LMLLandscape from './LMLLandscape';
import KernelHeatmap from './KernelHeatmap';
import KernelShape from './KernelShape';
import LMLChart from './LMLChart';

const HASH_KEY = 'j';
const PLOT_RES = 180;

const GP_INITIAL: GPConfigUI = {
  dataset: 'sine',
  kind: 'rbf',
  seed: 1,
  alpha: 2,
  period: 2,
  optimizer: 'adam',
  lr: 0.05,
  lockEll: false,
  lockSf: false,
  lockSn: false,
  stepsPerFrame: 2,
  sampleCount: 4,
  showSamples: true,
  showPredictive: false,
  loadId: 0,
};

function sanitize(raw: unknown): GPConfigUI {
  const c = (raw ?? {}) as Partial<GPConfigUI>;
  const kind = GP_KERNELS.some((k) => k.id === c.kind) ? (c.kind as GPConfigUI['kind']) : GP_INITIAL.kind;
  const dataset = GP_DATASETS.some((d) => d.id === c.dataset) ? (c.dataset as GPConfigUI['dataset']) : GP_INITIAL.dataset;
  return { ...GP_INITIAL, ...c, kind, dataset };
}

export default function GPLab() {
  const [config, setConfig] = useState<GPConfigUI>(GP_INITIAL);
  const [gradResult, setGradResult] = useState<GradCheckResult | null>(null);
  const [shareMsg, setShareMsg] = useState<string | null>(null);
  const [sampleSeed, setSampleSeed] = useState(11);

  const {
    running,
    tick,
    metrics,
    start,
    pause,
    reset,
    stepOnce,
    setHyper,
    addPoint,
    removePointNear,
    clearPoints,
    resetPoints,
    runGradCheck,
    posterior,
    samples,
    kernelMatrix,
    kernelShape,
    lmlLandscape,
    dataPoints,
    domain,
    pointCount,
    shareState,
    prepareShared,
  } = useGPTrainer(config);

  // restore a shared GP from the URL hash (#j=…) on first load
  useEffect(() => {
    const st = readHashState<SharedGP>(HASH_KEY);
    if (st && st.config) {
      prepareShared(st.config);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setConfig({ ...sanitize(st.config.config), loadId: 1 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doGradCheck = () => setGradResult(runGradCheck());

  const onShare = () => {
    const shared = shareState();
    const state = makeState(shared, [], shared.step);
    const url = shareUrl(state, HASH_KEY);
    writeHashState(state, HASH_KEY);
    const flash = (msg: string) => {
      setShareMsg(msg);
      window.setTimeout(() => setShareMsg(null), 2200);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url).then(
        () => flash('Link copied to clipboard ✓'),
        () => flash('Link is in the address bar'),
      );
    } else {
      flash('Link is in the address bar');
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

  const samplesXs = config.showSamples ? samples(PLOT_RES, 1, 0)?.Xs ?? null : null;

  return (
    <div className="lab">
      <GPPanel
        config={config}
        setConfig={setConfig}
        metrics={metrics}
        running={running}
        pointCount={pointCount}
        onStart={start}
        onPause={pause}
        onReset={reset}
        onStep={stepOnce}
        onGradCheck={doGradCheck}
        gradResult={gradResult}
        setHyper={setHyper}
        onClearPoints={clearPoints}
        onResetPoints={resetPoints}
        onShare={onShare}
        shareMsg={shareMsg}
      />

      <main className="stage">
        <div className="card density-card">
          <div className="card-title">
            Posterior over functions
            <span className="muted small"> — exact GP regression; the prior is being fit to the data by maximising the marginal likelihood</span>
            <button className="link interp-new" onClick={() => setSampleSeed((s) => s + 1)}>
              ↻ new samples
            </button>
          </div>
          <PosteriorPlot
            domain={domain}
            tick={tick}
            showSamples={config.showSamples}
            showPredictive={config.showPredictive}
            sampleCount={config.sampleCount}
            sampleSeed={sampleSeed}
            res={PLOT_RES}
            posterior={posterior}
            samples={samples}
            dataPoints={dataPoints}
            onAdd={addPoint}
            onRemove={(x) => removePointNear(x, domain[1] - domain[0])}
          />
        </div>

        <div className="stage-row gp-row">
          <div className="card gp-side-card">
            <div className="card-title">
              Marginal-likelihood landscape
              <span className="muted small"> — LML over (ℓ, σ_n), with the optimizer's path</span>
            </div>
            <LMLLandscape tick={tick} res={44} landscape={lmlLandscape} />
          </div>
          <div className="card gp-side-card">
            <div className="card-title">
              Kernel Gram matrix K
              <span className="muted small"> — what the Cholesky factorizes</span>
            </div>
            <KernelHeatmap tick={tick} kernelMatrix={kernelMatrix} />
          </div>
          <div className="card gp-side-card">
            <div className="card-title">
              Kernel &amp; prior
              <span className="muted small"> — k(r) and draws from the prior</span>
            </div>
            <KernelShape tick={tick} res={PLOT_RES} kernelShape={kernelShape} samplesXs={samplesXs} />
          </div>
        </div>

        <div className="card chart-card">
          <div className="card-title">Log marginal likelihood · gradient ascent through the Cholesky</div>
          <LMLChart history={metrics.lmlHistory} width={320} height={150} />
        </div>
      </main>
    </div>
  );
}
