import { useCallback, useEffect, useState } from 'react';
import './index.css';
import Viewport from './components/Viewport';
import Transport from './components/Transport';
import Tuning from './components/Tuning';
import StatsPanel from './components/StatsPanel';
import Gallery from './components/Gallery';
import { Controller, type ControllerConfig, type Stats } from './wfc/controller';
import { randomSeedString } from './wfc/prng';

const INITIAL: ControllerConfig = {
  tilesetKey: 'terrain',
  size: 28,
  seed: randomSeedString(),
  wrap: false,
  backtracking: true,
  speed: 8,
  showGhost: true,
  showEntropy: false,
  showGrid: false,
};

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
  const [controller] = useState(() => new Controller(INITIAL));

  const [cfg, setCfg] = useState<ControllerConfig>(INITIAL);
  const [seedLocked, setSeedLocked] = useState(false);
  const [stats, setStats] = useState<Stats>(EMPTY_STATS);

  const onStats = useCallback((s: Stats) => setStats(s), []);

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
            onSpeed={(v) => apply({ speed: v }, false)}
          />
        </div>

        <aside className="sidebar">
          <StatsPanel stats={stats} />
          <Tuning
            tilesetKey={cfg.tilesetKey}
            size={cfg.size}
            seed={cfg.seed}
            seedLocked={seedLocked}
            wrap={cfg.wrap}
            backtracking={cfg.backtracking}
            showGhost={cfg.showGhost}
            showEntropy={cfg.showEntropy}
            showGrid={cfg.showGrid}
            onTileset={(k) => apply({ tilesetKey: k }, true)}
            onSize={(n) => apply({ size: n }, true)}
            onSeed={(s) => apply({ seed: s }, true)}
            onNewSeed={newSeed}
            onSeedLock={setSeedLocked}
            onWrap={(b) => apply({ wrap: b }, true)}
            onBacktracking={(b) => apply({ backtracking: b }, true)}
            onGhost={(b) => apply({ showGhost: b }, false)}
            onEntropy={(b) => apply({ showEntropy: b }, false)}
            onGrid={(b) => apply({ showGrid: b }, false)}
          />
          <Gallery tileset={tileset} />
        </aside>
      </main>

      <footer className="footer">
        <span>Built from scratch — edge-code algebra · support-counter propagation · snapshot backtracking.</span>
        <span className="keys">
          <kbd>space</kbd> play · <kbd>s</kbd> step · <kbd>r</kbd> reset · <kbd>n</kbd> seed · <kbd>e</kbd> png · <kbd>h</kbd> heatmap
        </span>
      </footer>
    </div>
  );
}
