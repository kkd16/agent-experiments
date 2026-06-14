import { useCallback, useEffect, useMemo, useState } from 'react';
import './App.css';
import { type StepStats } from './engine';
import { DEFAULT_DEBUG, type DebugOptions } from './render/renderer';
import ControlPanel, { type ControlValues } from './ui/ControlPanel';
import Hud from './ui/Hud';
import SceneList from './ui/SceneList';
import Simulation, { type SimControls } from './ui/Simulation';
import VerificationModal from './ui/VerificationModal';

const INITIAL_VALUES: ControlValues = {
  gravityY: -9.8,
  velocityIterations: 10,
  positionIterations: 4,
  baumgarte: 0.2,
  warmStarting: true,
  enableSleep: true,
  continuous: true,
  showGjk: false,
  spawnKind: 'box',
};

export default function App() {
  const [sceneId, setSceneId] = useState('pyramid');
  const [running, setRunning] = useState(true);
  const [values, setValues] = useState<ControlValues>(INITIAL_VALUES);
  const [debug, setDebug] = useState<DebugOptions>(DEFAULT_DEBUG);
  const [resetSignal, setResetSignal] = useState(0);
  const [stepSignal, setStepSignal] = useState(0);
  const [stats, setStats] = useState<StepStats | null>(null);
  const [showVerify, setShowVerify] = useState(false);

  const controls = useMemo<SimControls>(
    () => ({
      running,
      gravityY: values.gravityY,
      velocityIterations: values.velocityIterations,
      positionIterations: values.positionIterations,
      baumgarte: values.baumgarte,
      warmStarting: values.warmStarting,
      enableSleep: values.enableSleep,
      continuous: values.continuous,
      debug,
      spawnKind: values.spawnKind,
      showGjk: values.showGjk,
    }),
    [running, values, debug],
  );

  const onStats = useCallback((s: StepStats) => setStats(s), []);
  const reset = useCallback(() => setResetSignal((n) => n + 1), []);
  const step = useCallback(() => setStepSignal((n) => n + 1), []);
  const toggleRun = useCallback(() => setRunning((r) => !r), []);
  const selectScene = useCallback((id: string) => {
    setSceneId(id);
    setRunning(true);
  }, []);

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.code === 'Space') {
        e.preventDefault();
        toggleRun();
      } else if (e.key === 'r') {
        reset();
      } else if (e.key === 's') {
        step();
      } else if (e.key === 'v') {
        setShowVerify((s) => !s);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleRun, reset, step]);

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden>◆</span>
          <div>
            <h1>Impulse</h1>
            <p className="tagline">
              A 2D rigid-body physics engine, from scratch — GJK/EPA, capsules &amp; rounded
              shapes, continuous collision, sequential impulses, joints with limits, islands.
            </p>
          </div>
        </div>
        <div className="header-actions">
          <button className="btn ghost" onClick={() => setShowVerify(true)}>✓ Verify engine</button>
        </div>
      </header>

      <div className="app-body">
        <aside className="sidebar left">
          <SceneList active={sceneId} onSelect={selectScene} />
        </aside>

        <main className="stage">
          <Simulation
            sceneId={sceneId}
            controls={controls}
            resetSignal={resetSignal}
            stepSignal={stepSignal}
            onStats={onStats}
          />
          <Hud stats={stats} />
        </main>

        <aside className="sidebar right">
          <ControlPanel
            running={running}
            values={values}
            debug={debug}
            onToggleRun={toggleRun}
            onStep={step}
            onReset={reset}
            onChange={(patch) => setValues((v) => ({ ...v, ...patch }))}
            onDebug={(patch) => setDebug((d) => ({ ...d, ...patch }))}
          />
        </aside>
      </div>

      <footer className="app-footer">
        <span>Space play/pause · S step · R reset · V verify</span>
        <span>Built with TypeScript + React · no physics libraries</span>
      </footer>

      {showVerify && <VerificationModal onClose={() => setShowVerify(false)} />}
    </div>
  );
}
