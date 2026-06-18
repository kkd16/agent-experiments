import type { ControllerConfig } from '../wfc/controller';
import { SAMPLES } from '../wfc/samples';
import { TILESETS } from '../wfc/tilesets';

type Props = {
  cfg: ControllerConfig;
  seedLocked: boolean;
  /** Apply a config patch; `rebuild` recreates the solver. */
  onPatch: (patch: Partial<ControllerConfig>, rebuild: boolean) => void;
  onNewSeed: () => void;
  onSeedLock: (b: boolean) => void;
  onEditSample: () => void;
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

function Segmented<T extends string | number>({
  options,
  value,
  onChange,
}: {
  options: { label: string; value: T }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button
          key={String(o.value)}
          className={`seg ${o.value === value ? 'active' : ''}`}
          onClick={() => onChange(o.value)}
          type="button"
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export default function Tuning({ cfg, seedLocked, onPatch, onNewSeed, onSeedLock, onEditSample }: Props) {
  const activeTileset = TILESETS.find((t) => t.key === cfg.tilesetKey) ?? TILESETS[0];
  const activeSample = SAMPLES.find((s) => s.key === cfg.sampleKey);
  const blurb =
    cfg.model === 'tiled'
      ? activeTileset.blurb
      : cfg.sampleKey === 'custom'
        ? 'Your own hand-drawn sample — WFC learns its patterns live.'
        : activeSample?.blurb;

  return (
    <section className="panel tuning">
      <header className="panel-head">
        <h2>Model</h2>
      </header>
      <Segmented
        options={[
          { label: 'Tiled', value: 'tiled' },
          { label: 'Overlapping', value: 'overlap' },
        ]}
        value={cfg.model}
        onChange={(m) => onPatch({ model: m as ControllerConfig['model'] }, true)}
      />

      {cfg.model === 'tiled' ? (
        <>
          <header className="panel-head sub">
            <h2>Tileset</h2>
          </header>
          <div className="tileset-picker">
            {TILESETS.map((t) => (
              <button
                key={t.key}
                className={`chip ${t.key === cfg.tilesetKey ? 'active' : ''}`}
                onClick={() => onPatch({ tilesetKey: t.key }, true)}
                type="button"
              >
                {t.name}
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <header className="panel-head sub">
            <h2>Sample</h2>
          </header>
          <div className="tileset-picker">
            {SAMPLES.map((s) => (
              <button
                key={s.key}
                className={`chip ${s.key === cfg.sampleKey ? 'active' : ''}`}
                onClick={() => onPatch({ sampleKey: s.key }, true)}
                type="button"
              >
                {s.name}
              </button>
            ))}
            <button className={`chip ${cfg.sampleKey === 'custom' ? 'active' : ''}`} onClick={onEditSample} type="button">
              ✎ Custom
            </button>
          </div>
          <button className="btn btn-wide" onClick={onEditSample} type="button">
            {cfg.sampleKey === 'custom' ? 'Edit your sample' : 'Draw your own…'}
          </button>

          <div className="field">
            <span className="field-label">pattern size</span>
            <Segmented
              options={[
                { label: '2 × 2', value: 2 },
                { label: '3 × 3', value: 3 },
              ]}
              value={cfg.patternN}
              onChange={(n) => onPatch({ patternN: n }, true)}
            />
          </div>
          <div className="field">
            <span className="field-label">symmetry</span>
            <Segmented
              options={[
                { label: '1', value: 1 },
                { label: '2', value: 2 },
                { label: '4', value: 4 },
                { label: '8', value: 8 },
              ]}
              value={cfg.symmetry}
              onChange={(s) => onPatch({ symmetry: s }, true)}
            />
          </div>
          <div className="toggles">
            <Toggle
              label="Periodic input"
              hint="wrap the sample"
              value={cfg.periodicInput}
              onChange={(b) => onPatch({ periodicInput: b }, true)}
            />
          </div>
        </>
      )}
      {blurb && <p className="blurb">{blurb}</p>}

      <label className="field">
        <span className="field-label">
          grid <em>{cfg.size} × {cfg.size}</em>
        </span>
        <input type="range" min={10} max={48} value={cfg.size} onChange={(e) => onPatch({ size: Number(e.target.value) }, true)} />
      </label>

      <div className="field">
        <span className="field-label">seed</span>
        <div className="seed-row">
          <input
            className="seed-input"
            type="text"
            value={cfg.seed}
            spellCheck={false}
            onChange={(e) => onPatch({ seed: e.target.value }, true)}
          />
          <button className="btn btn-icon" onClick={onNewSeed} title="Random seed (N)" type="button">
            ⚄
          </button>
        </div>
      </div>

      <div className="toggles">
        <Toggle label="Lock seed" hint="reuse on reset" value={seedLocked} onChange={onSeedLock} />
        <Toggle label="Wrap edges" hint="toroidal output" value={cfg.wrap} onChange={(b) => onPatch({ wrap: b }, true)} />
        <Toggle label="Backtracking" hint="recover from dead-ends" value={cfg.backtracking} onChange={(b) => onPatch({ backtracking: b }, true)} />
      </div>

      <header className="panel-head">
        <h2>View</h2>
      </header>
      <div className="toggles">
        <Toggle label="Ghost superpositions" value={cfg.showGhost} onChange={(b) => onPatch({ showGhost: b }, false)} />
        <Toggle label="Entropy heatmap" hint="H" value={cfg.showEntropy} onChange={(b) => onPatch({ showEntropy: b }, false)} />
        <Toggle label="Grid lines" value={cfg.showGrid} onChange={(b) => onPatch({ showGrid: b }, false)} />
      </div>
    </section>
  );
}
