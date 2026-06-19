import { useCallback, useEffect, useMemo, useState } from 'react';
import './index.css';
import Viewport from './components/Viewport';
import Transport from './components/Transport';
import Tuning from './components/Tuning';
import StatsPanel from './components/StatsPanel';
import Gallery from './components/Gallery';
import PaintPanel from './components/PaintPanel';
import SampleEditor from './components/SampleEditor';
import SolverLab from './components/SolverLab';
import TestsPanel from './components/TestsPanel';
import { Controller, type ControllerConfig, type Stats } from './wfc/controller';
import { randomSeedString } from './wfc/prng';
import { decodeHash, encodeHash } from './wfc/permalink';
import { sampleByKey, type Sample } from './wfc/samples';
import Studio3D from './components/Studio3D';
import { decodeHash3, hashMode, type Mode } from './wfc3d/permalink3';

const DEFAULTS: ControllerConfig = {
  model: 'overlap',
  tilesetKey: 'terrain',
  sampleKey: 'flowers',
  patternN: 3,
  symmetry: 2,
  periodicInput: false,
  size: 28,
  seed: 'seed',
  wrap: false,
  backtracking: true,
  speed: 10,
  showGhost: true,
  showEntropy: false,
  showGrid: false,
  showContraHeat: false,
  heuristic: 'entropy',
  tilePolicy: 'weighted',
  connectivity: 'off',
};

// Boot config: defaults, a fresh random seed, then anything pinned in the URL hash wins.
function initialConfig(): ControllerConfig {
  return { ...DEFAULTS, seed: randomSeedString(), ...decodeHash(window.location.hash) };
}

const EMPTY_STATS: Stats = {
  status: 'running',
  collapsed: 0,
  total: 0,
  percent: 0,
  contradictions: 0,
  backtracks: 0,
  restarts: 0,
  steps: 0,
  stepsPerSec: 0,
  eliminations: 0,
  peakDepth: 0,
  elapsedMs: 0,
  nTiles: 0,
  running: false,
  pins: 0,
  recording: false,
  supportsConnectivity: false,
  connectivity: 'off',
  components: 0,
  routed: null,
  terminals: 0,
};

export default function App() {
  const [mode, setMode] = useState<Mode>(() => hashMode(window.location.hash));
  const [cfg, setCfg] = useState<ControllerConfig>(initialConfig);
  const [controller] = useState(() => new Controller(cfg));
  const [seedLocked, setSeedLocked] = useState(false);
  const [stats, setStats] = useState<Stats>(EMPTY_STATS);
  const [editing, setEditing] = useState(false);
  const [brush, setBrushState] = useState<number | null>(null);
  const [erase, setEraseState] = useState(false);

  const onStats = useCallback((s: Stats) => setStats(s), []);

  // keep the URL hash in sync so the current run is shareable / reproducible. Only the active
  // engine owns the hash — when the 3D studio is up it writes its own (`m=3`) hash instead.
  useEffect(() => {
    if (mode !== '2d') return;
    window.history.replaceState(null, '', encodeHash(cfg));
  }, [cfg, mode]);

  const share = useCallback(async (): Promise<boolean> => {
    const url = window.location.origin + window.location.pathname + encodeHash(cfg);
    try {
      await navigator.clipboard.writeText(url);
      return true;
    } catch {
      return false;
    }
  }, [cfg]);

  // Push a config patch to the controller; `rebuild` recreates the solver. A patch that swaps
  // the active set clears the brush/pins in the controller, so re-sync the React mirror.
  const apply = useCallback(
    (patch: Partial<ControllerConfig>, rebuild: boolean) => {
      setCfg((c) => ({ ...c, ...patch }));
      controller.update(patch, rebuild);
      setBrushState(controller.activeBrush);
      setEraseState(controller.eraseMode);
    },
    [controller],
  );

  const toggle = useCallback(() => controller.toggle(), [controller]);
  const step = useCallback(() => controller.stepOnce(), [controller]);
  const exportPng = useCallback(() => controller.exportPng(), [controller]);
  const exportJson = useCallback(() => controller.exportJson(), [controller]);
  const record = useCallback(() => controller.toggleRecording(), [controller]);
  const reset = useCallback(() => {
    if (seedLocked) {
      controller.reset();
    } else {
      apply({ seed: randomSeedString() }, true);
    }
  }, [controller, seedLocked, apply]);
  const newSeed = useCallback(() => apply({ seed: randomSeedString() }, true), [apply]);

  // --- constraint painting ---
  const pickBrush = useCallback(
    (id: number | null) => {
      controller.setBrush(id);
      setBrushState(id);
      if (id != null) setEraseState(false);
    },
    [controller],
  );
  const setErase = useCallback(
    (on: boolean) => {
      controller.setErase(on);
      setEraseState(on);
      if (on) setBrushState(null);
    },
    [controller],
  );
  const clearPins = useCallback(() => controller.clearPins(), [controller]);
  const setWeight = useCallback((id: number, w: number) => controller.setWeight(id, w), [controller]);
  const resetWeights = useCallback(() => controller.resetWeights(), [controller]);

  // --- sample editor (overlapping model) ---
  const openEditor = useCallback(() => {
    if (cfg.model !== 'overlap') apply({ model: 'overlap' }, true);
    setEditing(true);
  }, [cfg.model, apply]);
  const editorSample: Sample = cfg.sampleKey === 'custom' && cfg.customSample ? cfg.customSample : sampleByKey(cfg.sampleKey);
  const onSampleChange = useCallback(
    (s: Sample) => apply({ model: 'overlap', sampleKey: 'custom', customSample: s }, true),
    [apply],
  );

  // keyboard shortcuts (2D engine only — the 3D studio owns its own keys while it's up)
  useEffect(() => {
    if (mode !== '2d') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      switch (e.key.toLowerCase()) {
        case ' ':
          e.preventDefault();
          toggle();
          break;
        case 's':
          step();
          break;
        case 'r':
          reset();
          break;
        case 'n':
          newSeed();
          break;
        case 'e':
          exportPng();
          break;
        case 'j':
          exportJson();
          break;
        case 'x':
          setErase(!erase);
          break;
        case 'c':
          clearPins();
          break;
        case 'h':
          apply({ showEntropy: !cfg.showEntropy }, false);
          break;
        case 'k':
          apply({ showContraHeat: !cfg.showContraHeat }, false);
          break;
        case 'g':
          apply({ showGrid: !cfg.showGrid }, false);
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, toggle, step, reset, newSeed, exportPng, exportJson, setErase, erase, clearPins, apply, cfg.showEntropy, cfg.showContraHeat, cfg.showGrid]);

  // controller.tileset changes identity on a set switch or a weight edit (both also bump stats
  // and re-render), so reading it here and memoising the brush preview on it is correct.
  const tileset = controller.tileset;
  const brushSrc = useMemo(() => {
    if (brush == null) return null;
    const v = tileset.variants[brush];
    if (!v) return null;
    try {
      return (v.patternBitmap ?? v.bitmap).toDataURL();
    } catch {
      return null;
    }
  }, [tileset, brush]);
  const paintActive = brush != null || erase;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">◩</span>
          <div>
            <h1>Tessera</h1>
            <p>
              {mode === '3d'
                ? 'Wave Function Collapse in three dimensions — a from-scratch voxel engine.'
                : 'A Wave Function Collapse studio — watch constraints crystallise into form.'}
            </p>
          </div>
        </div>
        <div className="topbar-right">
          <div className="segmented mode-switch">
            <button className={`seg ${mode === '2d' ? 'active' : ''}`} type="button" onClick={() => setMode('2d')}>
              2D
            </button>
            <button className={`seg ${mode === '3d' ? 'active' : ''}`} type="button" onClick={() => setMode('3d')}>
              3D
            </button>
          </div>
          <a className="repo-link" href="https://en.wikipedia.org/wiki/Model_synthesis" target="_blank" rel="noreferrer">
            what is WFC?
          </a>
        </div>
      </header>

      {mode === '3d' ? (
        <Studio3D initial={decodeHash3(window.location.hash)} />
      ) : (
        <main className="layout">
          <div className="stage">
            <Viewport controller={controller} tileset={tileset} onStats={onStats} paintActive={paintActive} />
            <Transport
              running={stats.running}
              speed={cfg.speed}
              recording={stats.recording}
              canRecord={controller.canRecord()}
              onToggle={toggle}
              onStep={step}
              onReset={reset}
              onExport={exportPng}
              onExportJson={exportJson}
              onRecord={record}
              onShare={share}
              onSpeed={(v) => apply({ speed: v }, false)}
            />
          </div>

          <aside className="sidebar">
            <StatsPanel stats={stats} />
            <Tuning
              cfg={cfg}
              seedLocked={seedLocked}
              onPatch={apply}
              onNewSeed={newSeed}
              onSeedLock={setSeedLocked}
              onEditSample={openEditor}
            />
            <PaintPanel brushSrc={brushSrc} erase={erase} pinCount={stats.pins} onErase={setErase} onClear={clearPins} />
            <Gallery
              tileset={tileset}
              brush={brush}
              onPickBrush={pickBrush}
              onSetWeight={setWeight}
              onResetWeights={resetWeights}
              hasOverrides={controller.hasWeightOverrides()}
              defaultWeight={(id) => controller.defaultWeight(id)}
            />
            <SolverLab controller={controller} activeHeuristic={cfg.heuristic} size={cfg.size} />
            <TestsPanel />
          </aside>
        </main>
      )}

      {editing && mode === '2d' && <SampleEditor value={editorSample} onChange={onSampleChange} onClose={() => setEditing(false)} />}

      <footer className="footer">
        {mode === '3d' ? (
          <>
            <span>
              Built from scratch — 3D Wave Function Collapse on a 6-neighbour voxel lattice · cube-group socket algebra ·
              support-counter propagation · snapshot backtracking · software voxel rasteriser (orbit camera, face culling,
              Lambert shading) · in-app 3D Proof Lab.
            </span>
            <span className="keys">
              <kbd>space</kbd> play · <kbd>s</kbd> step · <kbd>r</kbd> reset · <kbd>n</kbd> seed · <kbd>e</kbd> png · drag to orbit
            </span>
          </>
        ) : (
          <>
            <span>Built from scratch — tiled + overlapping models · support-counter propagation · snapshot backtracking · pluggable search heuristics (entropy / MRV / scanline / random) · hand constraints · global connectivity (one network / routed pins) · Solver Lab benchmark + in-app Proof Lab.</span>
            <span className="keys">
              <kbd>space</kbd> play · <kbd>s</kbd> step · <kbd>r</kbd> reset · <kbd>n</kbd> seed · <kbd>e</kbd> png · <kbd>j</kbd> json · <kbd>x</kbd> erase · <kbd>c</kbd> clear · <kbd>h</kbd> entropy · <kbd>k</kbd> contradictions
            </span>
          </>
        )}
      </footer>
    </div>
  );
}
