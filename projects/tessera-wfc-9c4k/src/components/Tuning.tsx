import { TILESETS } from '../wfc/tilesets';

type Props = {
  tilesetKey: string;
  size: number;
  seed: string;
  seedLocked: boolean;
  wrap: boolean;
  backtracking: boolean;
  showGhost: boolean;
  showEntropy: boolean;
  showGrid: boolean;
  onTileset: (k: string) => void;
  onSize: (n: number) => void;
  onSeed: (s: string) => void;
  onNewSeed: () => void;
  onSeedLock: (b: boolean) => void;
  onWrap: (b: boolean) => void;
  onBacktracking: (b: boolean) => void;
  onGhost: (b: boolean) => void;
  onEntropy: (b: boolean) => void;
  onGrid: (b: boolean) => void;
};

function Toggle({ label, hint, value, onChange }: { label: string; hint?: string; value: boolean; onChange: (b: boolean) => void }) {
  return (
    <button className={`toggle ${value ? 'on' : ''}`} onClick={() => onChange(!value)} type="button">
      <span className="toggle-knob" />
      <span className="toggle-text">
        {label}
        {hint && <em>{hint}</em>}
      </span>
    </button>
  );
}

export default function Tuning(p: Props) {
  const active = TILESETS.find((t) => t.key === p.tilesetKey) ?? TILESETS[0];
  return (
    <section className="panel tuning">
      <header className="panel-head">
        <h2>Tileset</h2>
      </header>
      <div className="tileset-picker">
        {TILESETS.map((t) => (
          <button
            key={t.key}
            className={`chip ${t.key === p.tilesetKey ? 'active' : ''}`}
            onClick={() => p.onTileset(t.key)}
            type="button"
          >
            {t.name}
          </button>
        ))}
      </div>
      <p className="blurb">{active.blurb}</p>

      <label className="field">
        <span className="field-label">
          grid <em>{p.size} × {p.size}</em>
        </span>
        <input type="range" min={10} max={48} value={p.size} onChange={(e) => p.onSize(Number(e.target.value))} />
      </label>

      <div className="field">
        <span className="field-label">seed</span>
        <div className="seed-row">
          <input
            className="seed-input"
            type="text"
            value={p.seed}
            spellCheck={false}
            onChange={(e) => p.onSeed(e.target.value)}
          />
          <button className="btn btn-icon" onClick={p.onNewSeed} title="Random seed (N)" type="button">
            ⚄
          </button>
        </div>
      </div>

      <div className="toggles">
        <Toggle label="Lock seed" hint="reuse on reset" value={p.seedLocked} onChange={p.onSeedLock} />
        <Toggle label="Wrap edges" hint="toroidal" value={p.wrap} onChange={p.onWrap} />
        <Toggle label="Backtracking" hint="recover from dead-ends" value={p.backtracking} onChange={p.onBacktracking} />
      </div>

      <header className="panel-head">
        <h2>View</h2>
      </header>
      <div className="toggles">
        <Toggle label="Ghost superpositions" value={p.showGhost} onChange={p.onGhost} />
        <Toggle label="Entropy heatmap" hint="H" value={p.showEntropy} onChange={p.onEntropy} />
        <Toggle label="Grid lines" value={p.showGrid} onChange={p.onGrid} />
      </div>
    </section>
  );
}
