import { useCallback, useEffect, useMemo, useState } from 'react';
import MeshViewport from './MeshViewport';
import { ControllerMesh, type ControllerMeshConfig, type StatsMesh } from '../mesh/controller_mesh';
import { MESH_TILESETS, meshTilesetByKey } from '../mesh/tilesets/index';
import { encodeHashMesh } from '../mesh/permalink_mesh';
import { randomSeedString } from '../wfc/prng';
import { runAllTestsMesh, testCountMesh, type TestGroup } from '../mesh/tests_mesh';
import type { CellGeom, MeshVariant, Palette } from '../mesh/meshtypes';

const DEFAULTS_MESH: ControllerMeshConfig = {
  tilesetKey: 'paths',
  cols: 9,
  rows: 9,
  seed: 'seed',
  jitter: 34,
  relax: 3,
  merge: true,
  backtracking: true,
  speed: 12,
  showGhost: true,
  showEntropy: false,
  showGrid: false,
};

const EMPTY_MESH: StatsMesh = {
  status: 'running',
  collapsed: 0,
  total: 0,
  percent: 0,
  contradictions: 0,
  backtracks: 0,
  restarts: 0,
  steps: 0,
  stepsPerSec: 0,
  nTiles: 0,
  cells: 0,
  running: false,
};

export default function MeshStudio({ initial }: { initial: Partial<ControllerMeshConfig> }) {
  const [cfg, setCfg] = useState<ControllerMeshConfig>(() => ({ ...DEFAULTS_MESH, seed: randomSeedString(), ...initial }));
  const [controller] = useState(() => new ControllerMesh(cfg));
  const [stats, setStats] = useState<StatsMesh>(EMPTY_MESH);
  const [seedLocked, setSeedLocked] = useState(false);

  const onStats = useCallback((s: StatsMesh) => setStats(s), []);

  useEffect(() => {
    window.history.replaceState(null, '', encodeHashMesh(cfg));
  }, [cfg]);

  const apply = useCallback(
    (patch: Partial<ControllerMeshConfig>, rebuild: boolean) => {
      setCfg((c) => ({ ...c, ...patch }));
      controller.update(patch, rebuild);
    },
    [controller],
  );

  const toggle = useCallback(() => controller.toggle(), [controller]);
  const step = useCallback(() => controller.stepOnce(), [controller]);
  const exportPng = useCallback(() => controller.exportPng(), [controller]);
  const newSeed = useCallback(() => apply({ seed: randomSeedString() }, true), [apply]);
  const reset = useCallback(() => {
    if (seedLocked) controller.reset();
    else apply({ seed: randomSeedString() }, true);
  }, [controller, seedLocked, apply]);

  const share = useCallback(async (): Promise<boolean> => {
    const url = window.location.origin + window.location.pathname + encodeHashMesh(cfg);
    try {
      await navigator.clipboard.writeText(url);
      return true;
    } catch {
      return false;
    }
  }, [cfg]);

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
        case 'm':
          apply({ merge: !cfg.merge }, true);
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle, step, reset, newSeed, exportPng, apply, cfg.showEntropy, cfg.showGrid, cfg.merge]);

  return (
    <main className="layout">
      <div className="stage">
        <MeshViewport controller={controller} onStats={onStats} />
        <TransportMesh
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
        <StatsMeshPanel stats={stats} />
        <TuningMesh cfg={cfg} seedLocked={seedLocked} onPatch={apply} onNewSeed={newSeed} onSeedLock={setSeedLocked} />
        <GalleryMesh controller={controller} tilesetKey={cfg.tilesetKey} variantCount={controller.tileset.variants.length} />
        <ProofMesh />
      </aside>
    </main>
  );
}

// ---- transport -------------------------------------------------------------

const SLIDER_MAX = 100;
const sliderToSpeed = (v: number) => Math.round(2 ** ((v / SLIDER_MAX) * 9));
const speedToSlider = (s: number) => Math.round((Math.log2(Math.max(1, s)) / 9) * SLIDER_MAX);

function TransportMesh({
  running,
  speed,
  onToggle,
  onStep,
  onReset,
  onExport,
  onShare,
  onSpeed,
}: {
  running: boolean;
  speed: number;
  onToggle: () => void;
  onStep: () => void;
  onReset: () => void;
  onExport: () => void;
  onShare: () => Promise<boolean>;
  onSpeed: (v: number) => void;
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
        <button className="btn btn-primary" onClick={onToggle} title="Space">
          {running ? '❚❚ Pause' : '▶ Play'}
        </button>
        <button className="btn" onClick={onStep} disabled={running} title="S">
          ⤳ Step
        </button>
        <button className="btn" onClick={onReset} title="R">
          ↺ Reset
        </button>
        <button className="btn" onClick={onExport} title="Download a PNG (E)">
          ⤓ PNG
        </button>
        <button className="btn" onClick={share} title="Copy a shareable link">
          {copied ? '✓ Copied' : '🔗 Link'}
        </button>
      </div>
      <label className="field">
        <span className="field-label">
          speed <em>{speed} steps / frame</em>
        </span>
        <input type="range" min={0} max={SLIDER_MAX} value={speedToSlider(speed)} onChange={(e) => onSpeed(sliderToSpeed(Number(e.target.value)))} />
      </label>
    </section>
  );
}

// ---- stats -----------------------------------------------------------------

const STATUS_LABEL: Record<StatsMesh['status'], string> = { running: 'solving', done: 'complete', failed: 'stuck' };

function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `${Math.round(n)}`;
}

function StatsMeshPanel({ stats }: { stats: StatsMesh }) {
  const pct = Math.round(stats.percent * 100);
  const items: [string, string][] = [
    ['quad cells', `${stats.cells}`],
    ['tiles in set', `${stats.nTiles}`],
    ['observations', fmt(stats.steps)],
    ['steps / sec', fmt(stats.stepsPerSec)],
    ['restarts', fmt(stats.restarts)],
    ['contradictions', fmt(stats.contradictions)],
  ];
  return (
    <section className="panel stats">
      <header className="panel-head">
        <h2>Telemetry</h2>
        <span className={`badge badge-${stats.status}`}>
          {stats.running && stats.status === 'running' ? '● ' : ''}
          {STATUS_LABEL[stats.status]}
        </span>
      </header>
      <div className="progress">
        <div className="progress-bar" style={{ width: `${pct}%` }} />
        <span className="progress-label">
          {stats.collapsed} / {stats.total} cells · {pct}%
        </span>
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

function TuningMesh({
  cfg,
  seedLocked,
  onPatch,
  onNewSeed,
  onSeedLock,
}: {
  cfg: ControllerMeshConfig;
  seedLocked: boolean;
  onPatch: (patch: Partial<ControllerMeshConfig>, rebuild: boolean) => void;
  onNewSeed: () => void;
  onSeedLock: (b: boolean) => void;
}) {
  const set = meshTilesetByKey(cfg.tilesetKey);
  const slider = (label: string, key: 'cols' | 'rows' | 'jitter' | 'relax', min: number, max: number, suffix = '') => (
    <label className="field">
      <span className="field-label">
        {label}{' '}
        <em>
          {cfg[key]}
          {suffix}
        </em>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        value={cfg[key]}
        onChange={(e) => onPatch({ [key]: Number(e.target.value) } as Partial<ControllerMeshConfig>, true)}
      />
    </label>
  );
  return (
    <section className="panel tuning">
      <header className="panel-head">
        <h2>Tuning</h2>
      </header>
      <div className="tileset-picker">
        {MESH_TILESETS.map((t) => (
          <button key={t.key} className={`chip ${cfg.tilesetKey === t.key ? 'active' : ''}`} onClick={() => onPatch({ tilesetKey: t.key }, true)} type="button">
            {t.name}
          </button>
        ))}
      </div>
      <p className="blurb">{set.blurb}</p>
      {slider('columns', 'cols', 4, 18)}
      {slider('rows', 'rows', 4, 18)}
      {slider('jitter', 'jitter', 0, 60, '%')}
      {slider('relax', 'relax', 0, 8, '×')}
      <label className="field">
        <span className="field-label">seed</span>
        <div className="seed-row">
          <input className="seed-input" value={cfg.seed} spellCheck={false} onChange={(e) => onPatch({ seed: e.target.value }, true)} />
          <button className="btn btn-icon" onClick={onNewSeed} title="Random seed (N)" type="button">
            🎲
          </button>
        </div>
      </label>
      <div className="toggles">
        <Toggle on={seedLocked} onClick={() => onSeedLock(!seedLocked)} title="Lock seed" sub="reset keeps this seed" />
        <Toggle on={cfg.merge} onClick={() => onPatch({ merge: !cfg.merge }, true)} title="Merge triangles (M)" sub="quad-heavy, more irregular" />
        <Toggle on={cfg.backtracking} onClick={() => onPatch({ backtracking: !cfg.backtracking }, true)} title="Backtracking" sub="recover from contradictions" />
        <Toggle on={cfg.showGhost} onClick={() => onPatch({ showGhost: !cfg.showGhost }, false)} title="Ghost superpositions" sub="tint un-collapsed cells" />
        <Toggle on={cfg.showEntropy} onClick={() => onPatch({ showEntropy: !cfg.showEntropy }, false)} title="Entropy heatmap (H)" sub="cooler = fewer options left" />
        <Toggle on={cfg.showGrid} onClick={() => onPatch({ showGrid: !cfg.showGrid }, false)} title="Cell outlines (G)" sub="hairline mesh edges" />
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

/** Render a variant into a small square cell so the gallery can preview an irregular-mesh tile. */
function tileThumb(variant: MeshVariant, palette: Palette, size: number): string {
  try {
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const ctx = c.getContext('2d');
    if (!ctx) return '';
    const p = size * 0.12;
    const poly = [
      { x: p, y: p },
      { x: size - p, y: p },
      { x: size - p, y: size - p },
      { x: p, y: size - p },
    ];
    const mids = [0, 1, 2, 3].map((s) => {
      const a = poly[s];
      const b = poly[(s + 1) % 4];
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    });
    const g: CellGeom = { poly, mids, centroid: { x: size / 2, y: size / 2 }, inradius: (size - 2 * p) / 2 };
    variant.render(ctx, g, palette);
    return c.toDataURL();
  } catch {
    return '';
  }
}

function GalleryMesh({ controller, tilesetKey, variantCount }: { controller: ControllerMesh; tilesetKey: string; variantCount: number }) {
  const [, force] = useState(0);
  const thumbs = useMemo(
    () => controller.tileset.variants.map((v) => tileThumb(v, controller.tileset.palette, 56)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tilesetKey, variantCount],
  );
  const variants = controller.tileset.variants;
  return (
    <section className="panel gallery">
      <header className="panel-head">
        <h2>Tiles</h2>
        {controller.hasWeightOverrides() && (
          <button
            className="seg"
            type="button"
            onClick={() => {
              controller.resetWeights();
              force((n) => n + 1);
            }}
          >
            reset weights
          </button>
        )}
      </header>
      <div className="tile-grid">
        {variants.map((v) => (
          <div className="tile" key={v.id}>
            <div className="tile-pick tile-pick-hex">{thumbs[v.id] ? <img src={thumbs[v.id]} alt={v.proto} width={56} height={56} /> : null}</div>
            <input
              className={`tile-weight ${controller.tileset.weights[v.id] !== controller.defaultWeight(v.id) ? 'edited' : ''}`}
              type="range"
              min={0.05}
              max={6}
              step={0.05}
              value={controller.tileset.weights[v.id]}
              onChange={(e) => {
                controller.setWeight(v.id, Number(e.target.value));
                force((n) => n + 1);
              }}
              title={`${v.proto} · weight ${controller.tileset.weights[v.id].toFixed(2)}`}
            />
          </div>
        ))}
      </div>
      <p className="gallery-hint">Drag a slider to re-bias how often a tile appears (adjacency is untouched).</p>
    </section>
  );
}

// ---- proof -----------------------------------------------------------------

function ProofMesh() {
  const [groups, setGroups] = useState<TestGroup[] | null>(null);
  const [running, setRunning] = useState(false);
  const [ms, setMs] = useState(0);
  const run = useCallback(() => {
    setRunning(true);
    setTimeout(() => {
      const t0 = performance.now();
      const g = runAllTestsMesh();
      setMs(Math.round(performance.now() - t0));
      setGroups(g);
      setRunning(false);
    }, 16);
  }, []);
  const tally = groups ? testCountMesh(groups) : null;
  const allPass = tally ? tally.passed === tally.total : false;
  return (
    <section className="panel proof">
      <header className="panel-head">
        <h2>Mesh Proof Lab</h2>
        {tally && (
          <span className={`badge ${allPass ? 'badge-done' : 'badge-failed'}`}>
            {tally.passed}/{tally.total} {allPass ? 'green' : 'failing'}
          </span>
        )}
      </header>
      <p className="blurb">
        Runs the real generator + compiler + solver: the mesh is a valid 2-manifold (every interior
        edge shared by exactly two cells in opposite senses, Euler χ = 1), the adjacency tensor is
        symmetric, and the headline — the mesh and every finished collapse are deterministic from a
        seed, and every solve is 4-edge adjacency-valid with no connection dead-ending across a seam,
        all re-checked the long way.
      </p>
      <button className="btn btn-wide" onClick={run} disabled={running} type="button">
        {running ? 'Running…' : groups ? 'Re-run verification' : 'Run verification'}
      </button>
      {groups && (
        <>
          <p className="proof-time">{ms} ms</p>
          {groups.map((grp) => (
            <div key={grp.group} className="proof-group">
              <h3>{grp.group}</h3>
              <ul>
                {grp.results.map((r) => (
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
