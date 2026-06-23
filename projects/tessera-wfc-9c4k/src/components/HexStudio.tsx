import { useCallback, useEffect, useMemo, useState } from 'react';
import HexViewport from './HexViewport';
import { ControllerHex, type ControllerHexConfig, type StatsHex } from '../hex/controller_hex';
import { HEX_TILESETS, hexTilesetByKey } from '../hex/tilesets/index';
import { encodeHashHex } from '../hex/permalink_hex';
import { randomSeedString } from '../wfc/prng';
import { runAllTestsHex, testCountHex, type TestGroup } from '../hex/tests_hex';

const DEFAULTS_HEX: ControllerHexConfig = {
  tilesetKey: 'terrain',
  cols: 16,
  rows: 14,
  seed: 'seed',
  wrap: false,
  backtracking: true,
  speed: 12,
  showGhost: true,
  showEntropy: false,
  showGrid: false,
};

const EMPTY_HEX: StatsHex = {
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
  running: false,
};

export default function HexStudio({ initial }: { initial: Partial<ControllerHexConfig> }) {
  const [cfg, setCfg] = useState<ControllerHexConfig>(() => ({ ...DEFAULTS_HEX, seed: randomSeedString(), ...initial }));
  const [controller] = useState(() => new ControllerHex(cfg));
  const [stats, setStats] = useState<StatsHex>(EMPTY_HEX);
  const [seedLocked, setSeedLocked] = useState(false);

  const onStats = useCallback((s: StatsHex) => setStats(s), []);

  useEffect(() => {
    window.history.replaceState(null, '', encodeHashHex(cfg));
  }, [cfg]);

  const apply = useCallback(
    (patch: Partial<ControllerHexConfig>, rebuild: boolean) => {
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
    const url = window.location.origin + window.location.pathname + encodeHashHex(cfg);
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
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle, step, reset, newSeed, exportPng, apply, cfg.showEntropy, cfg.showGrid]);

  return (
    <main className="layout">
      <div className="stage">
        <HexViewport controller={controller} onStats={onStats} />
        <TransportHex
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
        <StatsHexPanel stats={stats} />
        <TuningHex cfg={cfg} seedLocked={seedLocked} onPatch={apply} onNewSeed={newSeed} onSeedLock={setSeedLocked} />
        <GalleryHex controller={controller} tilesetKey={cfg.tilesetKey} variantCount={controller.tileset.variants.length} />
        <ProofHex />
      </aside>
    </main>
  );
}

// ---- transport -------------------------------------------------------------

const SLIDER_MAX = 100;
const sliderToSpeed = (v: number) => Math.round(2 ** ((v / SLIDER_MAX) * 9));
const speedToSlider = (s: number) => Math.round((Math.log2(Math.max(1, s)) / 9) * SLIDER_MAX);

function TransportHex({
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

const STATUS_LABEL: Record<StatsHex['status'], string> = { running: 'solving', done: 'complete', failed: 'stuck' };

function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `${Math.round(n)}`;
}

function StatsHexPanel({ stats }: { stats: StatsHex }) {
  const pct = Math.round(stats.percent * 100);
  const items: [string, string][] = [
    ['tiles in set', `${stats.nTiles}`],
    ['observations', fmt(stats.steps)],
    ['steps / sec', fmt(stats.stepsPerSec)],
    ['restarts', fmt(stats.restarts)],
    ['contradictions', fmt(stats.contradictions)],
    ['backtracks', fmt(stats.backtracks)],
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

function TuningHex({
  cfg,
  seedLocked,
  onPatch,
  onNewSeed,
  onSeedLock,
}: {
  cfg: ControllerHexConfig;
  seedLocked: boolean;
  onPatch: (patch: Partial<ControllerHexConfig>, rebuild: boolean) => void;
  onNewSeed: () => void;
  onSeedLock: (b: boolean) => void;
}) {
  const set = hexTilesetByKey(cfg.tilesetKey);
  const dim = (label: string, key: 'cols' | 'rows', min: number, max: number) => (
    <label className="field">
      <span className="field-label">
        {label} <em>{cfg[key]}</em>
      </span>
      <input type="range" min={min} max={max} value={cfg[key]} onChange={(e) => onPatch({ [key]: Number(e.target.value) } as Partial<ControllerHexConfig>, true)} />
    </label>
  );
  return (
    <section className="panel tuning">
      <header className="panel-head">
        <h2>Tuning</h2>
      </header>
      <div className="tileset-picker">
        {HEX_TILESETS.map((t) => (
          <button key={t.key} className={`chip ${cfg.tilesetKey === t.key ? 'active' : ''}`} onClick={() => onPatch({ tilesetKey: t.key }, true)} type="button">
            {t.name}
          </button>
        ))}
      </div>
      <p className="blurb">{set.blurb}</p>
      {dim('columns', 'cols', 4, 32)}
      {dim('rows', 'rows', 4, 28)}
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
        <Toggle on={cfg.wrap} onClick={() => onPatch({ wrap: !cfg.wrap }, true)} title="Wrap (toroidal)" sub="board wraps on both axes" />
        <Toggle on={cfg.backtracking} onClick={() => onPatch({ backtracking: !cfg.backtracking }, true)} title="Backtracking" sub="recover from contradictions" />
        <Toggle on={cfg.showGhost} onClick={() => onPatch({ showGhost: !cfg.showGhost }, false)} title="Ghost superpositions" sub="tint un-collapsed cells" />
        <Toggle on={cfg.showEntropy} onClick={() => onPatch({ showEntropy: !cfg.showEntropy }, false)} title="Entropy heatmap (H)" sub="cooler = fewer options left" />
        <Toggle on={cfg.showGrid} onClick={() => onPatch({ showGrid: !cfg.showGrid }, false)} title="Hex grid (G)" sub="hairline lattice outlines" />
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

function GalleryHex({ controller, tilesetKey, variantCount }: { controller: ControllerHex; tilesetKey: string; variantCount: number }) {
  const [, force] = useState(0);
  const thumbs = useMemo(() => {
    return controller.tileset.variants.map((v) => {
      try {
        return v.bitmap.toDataURL();
      } catch {
        return '';
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tilesetKey, variantCount]);

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

function ProofHex() {
  const [groups, setGroups] = useState<TestGroup[] | null>(null);
  const [running, setRunning] = useState(false);
  const [ms, setMs] = useState(0);
  const run = useCallback(() => {
    setRunning(true);
    setTimeout(() => {
      const t0 = performance.now();
      const g = runAllTestsHex();
      setMs(Math.round(performance.now() - t0));
      setGroups(g);
      setRunning(false);
    }, 16);
  }, []);
  const tally = groups ? testCountHex(groups) : null;
  const allPass = tally ? tally.passed === tally.total : false;
  return (
    <section className="panel proof">
      <header className="panel-head">
        <h2>Hex Proof Lab</h2>
        {tally && (
          <span className={`badge ${allPass ? 'badge-done' : 'badge-failed'}`}>
            {tally.passed}/{tally.total} {allPass ? 'green' : 'failing'}
          </span>
        )}
      </header>
      <p className="blurb">
        Runs the real compiler + solver: the six-direction lattice algebra (opposite = d+3 mod 6, a
        closed 60° rotation), an adjacency tensor that exactly matches the edge rule, deterministic
        seeds, toroidal seam validity, and the headline — every finished hex solve is 6-neighbour
        adjacency-valid, re-checked the long way.
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
