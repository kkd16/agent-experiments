import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTrainer, type TrainerConfig } from './hooks/useTrainer';
import ControlPanel from './components/ControlPanel';
import DecisionBoundary from './components/DecisionBoundary';
import RegressionPlot from './components/RegressionPlot';
import NeuronGrid from './components/NeuronGrid';
import LossChart from './components/LossChart';
import GraphView from './components/GraphView';
import type { GradCheckResult } from './engine/gradcheck';
import './App.css';

const INITIAL: TrainerConfig = {
  mode: 'classification',
  classKind: 'spiral',
  regKind: 'sine',
  samples: 240,
  noise: 0.08,
  seed: 1,
  hidden: [
    { units: 8, activation: 'tanh' },
    { units: 6, activation: 'tanh' },
  ],
  optimizer: 'adam',
  lr: 0.03,
  weightDecay: 0,
  batchSize: 30,
  stepsPerFrame: 2,
};

export default function App() {
  const [config, setConfig] = useState<TrainerConfig>(INITIAL);
  const [selected, setSelected] = useState<[number, number] | null>([0.3, 0.3]);
  const [gradResult, setGradResult] = useState<GradCheckResult | null>(null);
  const { running, tick, metrics, start, pause, reset, stepOnce, runGradCheck, handle } = useTrainer(config);

  // measure the stage to size the square board responsively
  const stageRef = useRef<HTMLDivElement>(null);
  const [board, setBoard] = useState(440);
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0].contentRect.width;
      setBoard(Math.max(260, Math.min(560, Math.floor(w))));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const doGradCheck = () => setGradResult(runGradCheck());

  // keyboard shortcuts
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
      else if (e.key === 'g') doGradCheck();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, start, pause, reset, stepOnce]);

  const paramCount = handle.model ? handle.model.paramCount() : 0;

  return (
    <div className="app">
      <header className="masthead">
        <div className="brand">
          <span className="logo">∇</span>
          <div>
            <h1>Synapse</h1>
            <p>A tiny deep-learning framework — reverse-mode tensor autograd, live in your browser.</p>
          </div>
        </div>
        <div className="kbd-hint">
          <kbd>space</kbd> train · <kbd>s</kbd> step · <kbd>r</kbd> reset · <kbd>g</kbd> gradcheck
        </div>
      </header>

      <div className="lab">
        <ControlPanel
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
        />

        <main className="stage">
          <div className="board-card" ref={stageRef}>
            <div className="card-title">
              {config.mode === 'classification' ? 'Decision boundary' : 'Function fit'}
              <span className="muted small">
                {config.mode === 'classification'
                  ? ' — click to move the autograd probe'
                  : ' — model output vs. samples'}
              </span>
            </div>
            {config.mode === 'classification' ? (
              <DecisionBoundary handle={handle} tick={tick} selected={selected} onSelect={setSelected} size={board} />
            ) : (
              <RegressionPlot handle={handle} tick={tick} size={board} />
            )}
          </div>

          <div className="stage-row">
            <div className="card chart-card">
              <div className="card-title">Training curves</div>
              <LossChart
                loss={metrics.lossHistory}
                acc={metrics.accHistory}
                accLabel={config.mode === 'classification' ? 'accuracy' : 'R²'}
                width={300}
                height={150}
              />
            </div>
            <div className="card graph-card">
              <div className="card-title">Computation graph</div>
              <GraphView handle={handle} tick={tick} selected={selected} />
            </div>
          </div>
        </main>

        <section className="neurons card">
          <div className="card-title">Neuron feature maps</div>
          <p className="muted small">
            Each tile shows one hidden unit&apos;s activation across the input plane — the features the network learns.
          </p>
          <div className="neuron-scroll">
            <NeuronGrid handle={handle} tick={tick} />
          </div>
        </section>
      </div>

      <footer className="foot">
        <span>
          No ML libraries — the tensor autograd, optimizers, losses and datasets are all hand-written. Open{' '}
          <code>src/engine/</code> to read the gradients.
        </span>
      </footer>
    </div>
  );
}
