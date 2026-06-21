import { useCallback, useEffect, useMemo, useState } from 'react';
import InfiniteViewport from './InfiniteViewport';
import { ControllerInf, type ControllerInfConfig, type StatsInf } from '../infinite/controller_inf';
import { INFINITE_TILESET_KEYS } from '../infinite/sets';
import { encodeHashInf } from '../infinite/permalink_inf';
import { tilesetByKey } from '../wfc/tilesets/index';
import { randomSeedString } from '../wfc/prng';
import { runAllTestsInf, testCountInf, type TestGroup } from '../infinite/tests_inf';

const DEFAULTS_INF: ControllerInfConfig = {
  tilesetKey: 'terrain',
  seed: 'seed',
  chunkSize: 12,
  cellPx: 24,
  centerX: 0,
  centerY: 0,
  showGrid: false,
  showJunctions: false,
  autoPan: false,
};

const EMPTY_INF: StatsInf = {
  tilesetName: '',
  nTiles: 0,
  chunkSize: 12,
  cellPx: 24,
  centerX: 0,
  centerY: 0,
  cellsVisible: 0,
  chunks: 0,
  seams: 0,
  junctions: 0,
  chunkSolves: 0,
  seamSolves: 0,
  fallbacks: 0,
  hover: null,
  running: false,
  ground: -1,
};

export default function InfiniteStudio({ initial }: { initial: Partial<ControllerInfConfig> }) {
  const [cfg, setCfg] = useState<ControllerInfConfig>(() => ({ ...DEFAULTS_INF, seed: randomSeedString(), ...initial }));
  const [controller] = useState(() => new ControllerInf(cfg));
  const [stats, setStats] = useState<StatsInf>(EMPTY_INF);

  const onStats = useCallback((s: StatsInf) => setStats(s), []);

  // Keep the URL hash live so an exact view is shareable. The controller mutates its own centre as
  // you pan, so we re-read it (not just `cfg`) to keep the hash honest.
  useEffect(() => {
    const id = window.setInterval(() => {
      window.history.replaceState(null, '', encodeHashInf(controller.config));
    }, 600);
    return () => window.clearInterval(id);
  }, [controller]);

  const apply = useCallback(
    (patch: Partial<ControllerInfConfig>, rebuild: boolean) => {
      setCfg((c) => ({ ...c, ...patch }));
      controller.update(patch, rebuild);
    },
    [controller],
  );

  const newSeed = useCallback(() => apply({ seed: randomSeedString() }, true), [apply]);
  const toggleAutopan = useCallback(() => {
    controller.toggle();
    setCfg((c) => ({ ...c, autoPan: !c.autoPan }));
  }, [controller]);
  const recenter = useCallback(() => {
    controller.recenter();
    setCfg((c) => ({ ...c, centerX: 0, centerY: 0 }));
  }, [controller]);
  const exportPng = useCallback(() => controller.exportPng(), [controller]);

  const share = useCallback(async (): Promise<boolean> => {
    const url = window.location.origin + window.location.pathname + encodeHashInf(controller.config);
    try {
      await navigator.clipboard.writeText(url);
      return true;
    } catch {
      return false;
    }
  }, [controller]);

  // keyboard (only mounted in infinite mode, so it owns these keys)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      switch (e.key.toLowerCase()) {
        case ' ':
          e.preventDefault();
          toggleAutopan();
          break;
        case 'n':
          newSeed();
          break;
        case 'r':
          recenter();
          break;
        case 'e':
          exportPng();
          break;
        case 'g':
          apply({ showGrid: !controller.config.showGrid }, false);
          break;
        case 'j':
          apply({ showJunctions: !controller.config.showJunctions }, false);
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleAutopan, newSeed, recenter, exportPng, apply, controller]);

  const tileset = controller.tileset;

  return (
    <main className="layout">
      <div className="stage">
        <InfiniteViewport controller={controller} onStats={onStats} />
        <TransportInf
          running={stats.running}
          onToggle={toggleAutopan}
          onNewSeed={newSeed}
          onRecenter={recenter}
          onExport={exportPng}
          onShare={share}
        />
      </div>
      <aside className="sidebar">
        <StatsInfPanel stats={stats} />
        <TuningInf cfg={cfg} onPatch={apply} onNewSeed={newSeed} />
        <GalleryInf variants={tileset.variants} />
        <ProofInf />
      </aside>
    </main>
  );
}

// ---- transport -------------------------------------------------------------

function TransportInf({
  running,
  onToggle,
  onNewSeed,
  onRecenter,
  onExport,
  onShare,
}: {
  running: boolean;
  onToggle: () => void;
  onNewSeed: () => void;
  onRecenter: () => void;
  onExport: () => void;
  onShare: () => Promise<boolean>;
}) {
  const [copied, setCopied] = useState(false);
  const share = async () => {
    if (await onShare()) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    }
  };
  return (
    <section className="panel transport">
      <div className="transport-row">
        <button className="btn btn-primary" onClick={onToggle} title="Auto-pan (Space)">
          {running ? '❚❚ Stop drift' : '▶ Auto-pan'}
        </button>
        <button className="btn" onClick={onNewSeed} title="New world (N)">
          🎲 New world
        </button>
        <button className="btn" onClick={onRecenter} title="Jump home to (0,0) (R)">
          ⌖ Home
        </button>
        <button className="btn" onClick={onExport} title="Download this view as PNG (E)">
          ⤓ PNG
        </button>
        <button className="btn" onClick={share} title="Copy a link to this exact view">
          {copied ? '✓ Copied' : '🔗 Link'}
        </button>
      </div>
      <p className="blurb" style={{ margin: '4px 2px 0' }}>
        Drag to pan, scroll to zoom — the plane is generated lazily and never ends. The same seed
        always grows the same world, so a link pins an exact spot in it.
      </p>
    </section>
  );
}

// ---- stats -----------------------------------------------------------------

function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `${Math.round(n)}`;
}

function StatsInfPanel({ stats }: { stats: StatsInf }) {
  const items: [string, string][] = [
    ['tiles in set', `${stats.nTiles}`],
    ['chunk size', `${stats.chunkSize}×${stats.chunkSize}`],
    ['zoom', `${stats.cellPx}px/cell`],
    ['cells on screen', fmt(stats.cellsVisible)],
    ['chunks built', fmt(stats.chunks)],
    ['seams built', fmt(stats.seams)],
    ['chunk solves', fmt(stats.chunkSolves)],
    ['fallbacks', `${stats.fallbacks}`],
  ];
  return (
    <section className="panel stats">
      <header className="panel-head">
        <h2>Telemetry</h2>
        <span className={`badge ${stats.fallbacks === 0 ? 'badge-done' : 'badge-failed'}`}>
          {stats.fallbacks === 0 ? '● valid' : 'fallback!'}
        </span>
      </header>
      <div className="coord-readout">
        <span>
          centre <em>{Math.round(stats.centerX)}, {Math.round(stats.centerY)}</em>
        </span>
        {stats.hover && (
          <span>
            cursor <em>{stats.hover.x}, {stats.hover.y}</em>
          </span>
        )}
      </div>
      <dl className="metrics">
        {items.map(([k, v]) => (
          <div key={k} className="metric">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

// ---- tuning ----------------------------------------------------------------

function TuningInf({
  cfg,
  onPatch,
  onNewSeed,
}: {
  cfg: ControllerInfConfig;
  onPatch: (patch: Partial<ControllerInfConfig>, rebuild: boolean) => void;
  onNewSeed: () => void;
}) {
  const set = tilesetByKey(cfg.tilesetKey);
  return (
    <section className="panel tuning">
      <header className="panel-head">
        <h2>Tuning</h2>
      </header>
      <div className="tileset-picker">
        {INFINITE_TILESET_KEYS.map((key) => {
          const t = tilesetByKey(key);
          return (
            <button
              key={key}
              className={`chip ${cfg.tilesetKey === key ? 'active' : ''}`}
              onClick={() => onPatch({ tilesetKey: key }, true)}
              type="button"
            >
              {t.name}
            </button>
          );
        })}
      </div>
      <p className="blurb">{set.blurb}</p>
      <label className="field">
        <span className="field-label">
          chunk size <em>{cfg.chunkSize}</em>
        </span>
        <input
          type="range"
          min={6}
          max={20}
          value={cfg.chunkSize}
          onChange={(e) => onPatch({ chunkSize: Number(e.target.value) }, true)}
        />
      </label>
      <label className="field">
        <span className="field-label">
          zoom <em>{Math.round(cfg.cellPx)} px / cell</em>
        </span>
        <input
          type="range"
          min={6}
          max={64}
          value={cfg.cellPx}
          onChange={(e) => onPatch({ cellPx: Number(e.target.value) }, false)}
        />
      </label>
      <label className="field">
        <span className="field-label">seed</span>
        <div className="seed-row">
          <input
            className="seed-input"
            value={cfg.seed}
            spellCheck={false}
            onChange={(e) => onPatch({ seed: e.target.value }, true)}
          />
          <button className="btn btn-icon" onClick={onNewSeed} title="Random world (N)" type="button">
            🎲
          </button>
        </div>
      </label>
      <div className="toggles">
        <Toggle on={cfg.showGrid} onClick={() => onPatch({ showGrid: !cfg.showGrid }, false)} title="Chunk lattice" sub="show the chunk boundaries (G)" />
        <Toggle on={cfg.showJunctions} onClick={() => onPatch({ showJunctions: !cfg.showJunctions }, false)} title="Junctions" sub="mark the lattice corner cells (J)" />
      </div>
    </section>
  );
}

function Toggle({ on, onClick, title, sub }: { on: boolean; onClick: () => void; title: string; sub: string }) {
  return (
    <button className={`toggle ${on ? 'on' : ''}`} onClick={onClick} type="button">
      <span className="toggle-knob" />
      <span className="toggle-text">
        {title}
        <em>{sub}</em>
      </span>
    </button>
  );
}

// ---- gallery ---------------------------------------------------------------

function GalleryInf({ variants }: { variants: { id: number; proto: string; bitmap: HTMLCanvasElement; patternBitmap?: HTMLCanvasElement }[] }) {
  const thumbs = useMemo(
    () =>
      variants.map((v) => {
        try {
          return (v.patternBitmap ?? v.bitmap).toDataURL();
        } catch {
          return '';
        }
      }),
    [variants],
  );
  return (
    <section className="panel gallery">
      <header className="panel-head">
        <h2>Tiles</h2>
        <span className="badge">{variants.length}</span>
      </header>
      <div className="tile-grid">
        {variants.map((v) => (
          <div className="tile" key={v.id}>
            <div className="tile-pick">{thumbs[v.id] ? <img src={thumbs[v.id]} alt={v.proto} width={48} height={48} /> : null}</div>
          </div>
        ))}
      </div>
      <p className="gallery-hint">The ground tile (one self-compatible in all four directions) anchors every chunk corner, keeping the endless plane solvable.</p>
    </section>
  );
}

// ---- proof -----------------------------------------------------------------

function ProofInf() {
  const [groups, setGroups] = useState<TestGroup[] | null>(null);
  const [running, setRunning] = useState(false);
  const [ms, setMs] = useState(0);
  const run = useCallback(() => {
    setRunning(true);
    setTimeout(() => {
      const t0 = performance.now();
      const g = runAllTestsInf();
      setMs(Math.round(performance.now() - t0));
      setGroups(g);
      setRunning(false);
    }, 16);
  }, []);
  const tally = groups ? testCountInf(groups) : null;
  const allPass = tally ? tally.passed === tally.total : false;
  return (
    <section className="panel proof">
      <header className="panel-head">
        <h2>Infinite Proof Lab</h2>
        {tally && (
          <span className={`badge ${allPass ? 'badge-done' : 'badge-failed'}`}>
            {tally.passed}/{tally.total} {allPass ? 'green' : 'failing'}
          </span>
        )}
      </header>
      <p className="blurb">
        Runs the real world generator: the coordinate algebra partitions the plane, seams are valid
        1-D chains, chunk borders equal their shared seams, and — the headline — every adjacency on a
        block of the plane is valid (re-checked the long way from raw socket codes), the world is
        order-independent, and the fallback path never fires.
      </p>
      <button className="btn btn-wide" onClick={run} disabled={running} type="button">
        {running ? 'Running…' : groups ? 'Re-run verification' : 'Run verification'}
      </button>
      {groups && (
        <>
          <p className="proof-time">{ms} ms</p>
          {groups.map((g) => (
            <div key={g.group} className="proof-group">
              <h3>{g.group}</h3>
              <ul>
                {g.results.map((r) => (
                  <li key={r.name} className={r.pass ? 'ok' : 'bad'}>
                    <span className="proof-mark">{r.pass ? '✓' : '✕'}</span>
                    <span className="proof-name">{r.name}</span>
                    <span className="proof-detail">{r.detail}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </>
      )}
    </section>
  );
}
