import { useCallback, useEffect, useState } from 'react';
import './index.css';
import Viewport from './components/Viewport';
import Transport from './components/Transport';
import Tuning from './components/Tuning';
import StatsPanel from './components/StatsPanel';
import Gallery from './components/Gallery';
import SampleEditor from './components/SampleEditor';
import { Controller, type ControllerConfig, type Stats } from './wfc/controller';
import { randomSeedString } from './wfc/prng';
import { decodeHash, encodeHash } from './wfc/permalink';
import { sampleByKey, type Sample } from './wfc/samples';

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
  elapsedMs: 0,
  nTiles: 0,
  running: false,
};

export default function App() {
  const [cfg, setCfg] = useState<ControllerConfig>(initialConfig);
  const [controller] = useState(() => new Controller(cfg));
  const [seedLocked, setSeedLocked] = useState(false);
  const [stats, setStats] = useState<Stats>(EMPTY_STATS);
  const [editing, setEditing] = useState(false);

  const onStats = useCallback((s: Stats) => setStats(s), []);

  // keep the URL hash in sync so the current run is shareable / reproducible
  useEffect(() => {
    window.history.replaceState(null, '', encodeHash(cfg));
  }, [cfg]);

  const share = useCallback(async (): Promise<boolean> => {
    const url = window.location.origin + window.location.pathname + encodeHash(cfg);
    try {
      await navigator.clipboard.writeText(url);
      return true;
    } catch {
      return false;
    }
  }, [cfg]);

  // Push a config patch to the controller; `rebuild` recreates the solver.
  const apply = useCallback(
    (patch: Partial<ControllerConfig>, rebuild: boolean) => {
      setCfg((c) => ({ ...c, ...patch }));
      controller.update(patch, rebuild);
    },
    [controller],
  );

  const toggle = useCallback(() => controller.toggle(), [controller]);
  const step = useCallback(() => controller.stepOnce(), [controller]);
  const exportPng = useCallback(() => controller.exportPng(), [controller]);
  const reset = useCallback(() => {
    if (seedLocked) {
      controller.reset();
    } else {
      apply({ seed: randomSeedString() }, true);
    }
  }, [controller, seedLocked, apply]);
  const newSeed = useCallback(() => apply({ seed: randomSeedString() }, true), [apply]);

  // --- sample editor (overlapping model) ---
  const openEditor = useCallback(() => {
    // Switch to the overlapping model if needed; the editor forks the active sample.
    if (cfg.model !== 'overlap') apply({ model: 'overlap' }, true);
    setEditing(true);
  }, [cfg.model, apply]);
  // The bitmap the editor starts from: an in-progress custom sample, or a fork of the built-in.
  const editorSample: Sample = cfg.sampleKey === 'custom' && cfg.customSample ? cfg.customSample : sampleByKey(cfg.sampleKey);
  const onSampleChange = useCallback(
    (s: Sample) => apply({ model: 'overlap', sampleKey: 'custom', customSample: s }, true),
    [apply],
  );

  // keyboard shortcuts
  useEffect(() => {
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
        case 'h':
          apply({ showEntropy: !cfg.showEntropy }, false);
          break;
        case 'g':
          apply({ showGrid: !cfg.showGrid }, false);
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle, step, reset, newSeed, exportPng, apply, cfg.showEntropy, cfg.showGrid]);

  // controller.tileset only changes identity on a tileset switch (which also bumps cfg and
  // re-renders), so reading it here and letting Gallery memo on its identity is correct.
  const tileset = controller.tileset;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">◩</span>
          <div>
            <h1>Tessera</h1>
            <p>A Wave Function Collapse studio — watch constraints crystallise into form.</p>
          </div>
        </div>
        <a className="repo-link" href="https://en.wikipedia.org/wiki/Model_synthesis" target="_blank" rel="noreferrer">
          what is WFC?
        </a>
      </header>

      <main className="layout">
        <div className="stage">
          <Viewport controller={controller} onStats={onStats} />
          <Transport
            running={stats.running}
            speed={cfg.speed}
            onToggle={toggle}
            onStep={step}
            onReset={reset}
            onExport={exportPng}
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
          <Gallery tileset={tileset} />
        </aside>
      </main>

      {editing && <SampleEditor value={editorSample} onChange={onSampleChange} onClose={() => setEditing(false)} />}

      <footer className="footer">
        <span>Built from scratch — tiled + overlapping models · support-counter propagation · snapshot backtracking.</span>
        <span className="keys">
          <kbd>space</kbd> play · <kbd>s</kbd> step · <kbd>r</kbd> reset · <kbd>n</kbd> seed · <kbd>e</kbd> png · <kbd>h</kbd> heatmap
        </span>
      </footer>
    </div>
  );
}
