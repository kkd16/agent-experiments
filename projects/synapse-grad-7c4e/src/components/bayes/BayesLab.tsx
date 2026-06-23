import { useEffect, useState } from 'react';
import { useBayesTrainer, type BayesConfigUI } from '../../hooks/useBayesTrainer';
import { REG_FUNCS } from '../../engine/bayes';
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
  BAYES_SLOT_PREFIX,
} from '../../engine/serialize';
import BayesPanel from './BayesPanel';
import UncertaintyPlot from './UncertaintyPlot';
import CalibrationPlot from './CalibrationPlot';
import BayesChart from './BayesChart';

const HASH_KEY = 'u';

const BAYES_INITIAL: BayesConfigUI = {
  method: 'bbb',
  func: 'sine',
  samples: 90,
  noise: 0.08,
  hetero: false,
  seed: 1,
  hidden: 48,
  depth: 2,
  activation: 'tanh',
  priorSigma: 0.5,
  klWeight: 0.1,
  rhoInit: -3,
  dropP: 0.1,
  ensembleSize: 5,
  optimizer: 'adam',
  lr: 0.01,
  weightDecay: 0,
  batchSize: 32,
  stepsPerFrame: 4,
  scheduleKind: 'constant',
  schedulePeriod: 800,
  scheduleWarmup: 100,
  clipNorm: 5,
  predSamples: 60,
  funcSamples: 40,
  loadId: 0,
};

function sanitize(raw: unknown): BayesConfigUI {
  const c = (raw ?? {}) as Partial<BayesConfigUI>;
  const func = REG_FUNCS.some((f) => f.id === c.func) ? (c.func as BayesConfigUI['func']) : BAYES_INITIAL.func;
  const method = (['bbb', 'dropout', 'ensemble'] as const).includes(c.method as BayesConfigUI['method'])
    ? (c.method as BayesConfigUI['method'])
    : BAYES_INITIAL.method;
  return {
    ...BAYES_INITIAL,
    ...c,
    func,
    method,
    samples: Math.max(30, Math.min(300, Math.round(Number(c.samples) || BAYES_INITIAL.samples))),
    noise: Math.max(0, Math.min(0.4, Number.isFinite(Number(c.noise)) ? Number(c.noise) : BAYES_INITIAL.noise)),
    hetero: Boolean(c.hetero),
  };
}

export default function BayesLab() {
  const [config, setConfig] = useState<BayesConfigUI>(BAYES_INITIAL);
  const [gradResult, setGradResult] = useState<GradCheckResult | null>(null);
  const [slots, setSlots] = useState<string[]>(() => listSlots(BAYES_SLOT_PREFIX));
  const [shareMsg, setShareMsg] = useState<string | null>(null);
  const [showData, setShowData] = useState(true);
  const [showTrue, setShowTrue] = useState(true);
  const [showSamples, setShowSamples] = useState(true);
  const [showSplit, setShowSplit] = useState(true);

  const {
    running,
    tick,
    metrics,
    handle,
    start,
    pause,
    reset,
    stepOnce,
    runGradCheck,
    predict,
    sampleFunctions,
    trueCurve,
    dataPoints,
    calibration,
    snapshot,
    prepareLoad,
  } = useBayesTrainer(config);

  useEffect(() => {
    const st = readHashState<BayesConfigUI>(HASH_KEY);
    if (st && Array.isArray(st.weights)) {
      prepareLoad(st.weights, st.step ?? 0);
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
    if (saveSlot(name, makeState(config, weights, step), BAYES_SLOT_PREFIX)) setSlots(listSlots(BAYES_SLOT_PREFIX));
  };
  const onLoadSlot = (name: string) => {
    const st = loadSlot<BayesConfigUI>(name, BAYES_SLOT_PREFIX);
    if (!st) return;
    prepareLoad(st.weights, st.step ?? 0);
    setConfig((c) => ({ ...sanitize(st.config), loadId: c.loadId + 1 }));
  };
  const onDeleteSlot = (name: string) => {
    deleteSlot(name, BAYES_SLOT_PREFIX);
    setSlots(listSlots(BAYES_SLOT_PREFIX));
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
      else if (e.key === 's' && !running) stepOnce();
      else if (e.key === 'g') setGradResult(runGradCheck());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [running, start, pause, reset, stepOnce, runGradCheck]);

  const cal = calibration();
  const methodName = handle.method === 'bbb' ? 'Bayes-by-Backprop' : handle.method === 'dropout' ? 'MC-Dropout' : `Deep Ensemble · ${handle.members}`;

  return (
    <div className="lab">
      <BayesPanel
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
        paramCount={handle.paramCount}
        members={handle.members}
        slots={slots}
        onSave={onSave}
        onLoadSlot={onLoadSlot}
        onDeleteSlot={onDeleteSlot}
        onShare={onShare}
        shareMsg={shareMsg}
      />

      <main className="stage">
        <div className="card density-card">
          <div className="card-title">
            Predictive distribution&nbsp;<span className="muted small">— {methodName}; mean ± σ over the input axis</span>
            <span className="flow-toggles">
              <label className="toggle">
                <input type="checkbox" checked={showSplit} onChange={(e) => setShowSplit(e.target.checked)} /> aleatoric/epistemic
              </label>
              <label className="toggle">
                <input type="checkbox" checked={showSamples} onChange={(e) => setShowSamples(e.target.checked)} /> samples
              </label>
              <label className="toggle">
                <input type="checkbox" checked={showTrue} onChange={(e) => setShowTrue(e.target.checked)} /> truth
              </label>
              <label className="toggle">
                <input type="checkbox" checked={showData} onChange={(e) => setShowData(e.target.checked)} /> data
              </label>
            </span>
          </div>
          <UncertaintyPlot
            predict={predict}
            sampleFunctions={sampleFunctions}
            trueCurve={trueCurve}
            dataPoints={dataPoints}
            tick={tick}
            width={720}
            height={380}
            showData={showData}
            showTrue={showTrue}
            showSamples={showSamples}
            showSplit={showSplit}
            funcSamples={config.funcSamples}
          />
          <div className="uq-legend muted small">
            {showSplit ? (
              <>
                <span className="sw sw-epi" /> epistemic (model) &nbsp;·&nbsp; <span className="sw sw-ale" /> aleatoric (data noise) &nbsp;·&nbsp;
              </>
            ) : (
              <>
                <span className="sw sw-tot" /> ±1σ / ±2σ predictive &nbsp;·&nbsp;
              </>
            )}
            <span className="sw sw-mean" /> mean &nbsp;·&nbsp; <span className="sw sw-true" /> truth &nbsp;·&nbsp; shaded = no training data
          </div>
        </div>

        <div className="stage-row">
          <div className="card flow-side-card">
            <div className="card-title">
              Calibration&nbsp;<span className="muted small">— reliability diagram on held-out data</span>
            </div>
            <CalibrationPlot calibration={calibration} tick={tick} width={300} height={240} />
            {cal && (
              <div className="stat-row tight">
                <div className="stat">
                  <span className="muted small">ECE</span>
                  <b>{cal.ece.toFixed(3)}</b>
                </div>
                <div className="stat">
                  <span className="muted small">RMSE</span>
                  <b>{cal.rmse.toFixed(3)}</b>
                </div>
                <div className="stat">
                  <span className="muted small">NLL</span>
                  <b>{cal.nll.toFixed(3)}</b>
                </div>
              </div>
            )}
          </div>
          <div className="card flow-side-card">
            <div className="card-title">Objective · loss &amp; held-out NLL</div>
            <BayesChart loss={metrics.lossHistory} nll={metrics.nllHistory} width={320} height={200} />
            <p className="muted small arch-desc">
              The two faces of uncertainty: <b>aleatoric</b> is the irreducible noise in the data (it stays even with infinite data);
              <b> epistemic</b> is the model's own doubt — it balloons in the central gap and the extrapolation tails, and it shrinks as
              you add data or train longer. A well-calibrated model keeps the reliability curve on the diagonal.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
