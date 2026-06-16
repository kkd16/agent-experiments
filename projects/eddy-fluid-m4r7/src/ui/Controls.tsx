// Controls.tsx — the studio control panel.

import type { Settings, Tool } from '../state/settings';
import type { RenderMode } from '../render/renderer';
import { COLORMAPS, type ColorMapName } from '../render/colormaps';
import { SCENES } from '../sim/scenes';

interface Props {
  settings: Settings;
  paused: boolean;
  onChange: (patch: Partial<Settings>) => void;
  onParam: (patch: Partial<Settings['params']>) => void;
  onScene: (id: string) => void;
  onReset: () => void;
  onClearDye: () => void;
  onClearWalls: () => void;
  onTogglePause: () => void;
  onStep: () => void;
  onShare: () => void;
  onSnapshot: () => void;
}

function Slider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  fmt?: (v: number) => string;
  onChange: (v: number) => void;
}) {
  const { label, value, min, max, step, fmt, onChange } = props;
  return (
    <label className="slider">
      <span className="slider-label">
        {label}
        <em>{fmt ? fmt(value) : value}</em>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
    </label>
  );
}

function Segmented<T extends string>(props: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="segmented" role="group">
      {props.options.map((o) => (
        <button
          key={o.value}
          className={o.value === props.value ? 'active' : ''}
          onClick={() => props.onChange(o.value)}
          type="button"
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const SWATCHES = ['rainbow', '#ff3b3b', '#ffb000', '#36e0c0', '#3b82f6', '#a855f7', '#ffffff'];

export function Controls(props: Props) {
  const { settings: s, onChange, onParam } = props;
  return (
    <aside className="panel">
      <section>
        <h2>Scene</h2>
        <div className="scene-grid">
          {SCENES.map((sc) => (
            <button
              key={sc.id}
              type="button"
              className={`scene-btn ${sc.id === s.sceneId ? 'active' : ''}`}
              onClick={() => props.onScene(sc.id)}
              title={sc.blurb}
            >
              {sc.name}
            </button>
          ))}
        </div>
        <p className="scene-blurb">{SCENES.find((x) => x.id === s.sceneId)?.blurb}</p>
      </section>

      <section>
        <h2>Playback</h2>
        <div className="row">
          <button type="button" className="primary" onClick={props.onTogglePause}>
            {props.paused ? '▶ Play' : '❚❚ Pause'}
          </button>
          <button type="button" onClick={props.onStep} disabled={!props.paused}>
            Step ↦
          </button>
          <button type="button" onClick={props.onReset}>
            Reset
          </button>
        </div>
        <div className="row">
          <button type="button" onClick={props.onClearDye}>
            Clear dye
          </button>
          <button type="button" onClick={props.onClearWalls}>
            Clear walls
          </button>
        </div>
        <div className="row">
          <button type="button" onClick={props.onShare} title="Copy a permalink to this exact setup">
            🔗 Share
          </button>
          <button type="button" onClick={props.onSnapshot} title="Download the current frame as a PNG">
            📷 Snapshot
          </button>
        </div>
      </section>

      <section>
        <h2>Brush</h2>
        <Segmented<Tool>
          value={s.tool}
          onChange={(tool) => onChange({ tool })}
          options={[
            { value: 'dye', label: 'Dye' },
            { value: 'wall', label: 'Wall' },
            { value: 'erase', label: 'Erase' },
          ]}
        />
        {s.tool === 'dye' && (
          <div className="swatches">
            {SWATCHES.map((c) => (
              <button
                key={c}
                type="button"
                className={`swatch ${c === s.brushColor ? 'active' : ''} ${c === 'rainbow' ? 'rainbow' : ''}`}
                style={c === 'rainbow' ? undefined : { background: c }}
                onClick={() => onChange({ brushColor: c })}
                title={c === 'rainbow' ? 'cycling rainbow' : c}
              />
            ))}
          </div>
        )}
        <Slider
          label="Brush size"
          value={s.brushRadius}
          min={1}
          max={16}
          step={1}
          onChange={(brushRadius) => onChange({ brushRadius })}
        />
        <Slider
          label="Stir force"
          value={s.forceScale}
          min={0.1}
          max={3}
          step={0.1}
          fmt={(v) => `${v.toFixed(1)}×`}
          onChange={(forceScale) => onChange({ forceScale })}
        />
      </section>

      <section>
        <h2>Fluid</h2>
        <Slider
          label="Vorticity"
          value={s.params.vorticity}
          min={0}
          max={30}
          step={0.5}
          onChange={(vorticity) => onParam({ vorticity })}
        />
        <Slider
          label="Viscosity"
          value={s.params.viscosity}
          min={0}
          max={0.0002}
          step={0.000005}
          fmt={(v) => v.toExponential(1)}
          onChange={(viscosity) => onParam({ viscosity })}
        />
        <Slider
          label="Dye fade"
          value={s.params.dyeDissipation}
          min={0}
          max={0.6}
          step={0.005}
          fmt={(v) => v.toFixed(3)}
          onChange={(dyeDissipation) => onParam({ dyeDissipation })}
        />
        <Slider
          label="Velocity damping"
          value={s.params.velocityDissipation}
          min={0}
          max={0.2}
          step={0.002}
          fmt={(v) => v.toFixed(3)}
          onChange={(velocityDissipation) => onParam({ velocityDissipation })}
        />
        <Slider
          label="Gravity"
          value={s.params.gravity}
          min={-40}
          max={40}
          step={1}
          onChange={(gravity) => onParam({ gravity })}
        />
        <Slider
          label="Solver iterations"
          value={s.params.iterations}
          min={4}
          max={60}
          step={1}
          onChange={(iterations) => onParam({ iterations })}
        />
        <label className="checkbox">
          <input
            type="checkbox"
            checked={s.params.sharpDye}
            onChange={(e) => onParam({ sharpDye: e.target.checked })}
          />
          Sharp dye (MacCormack advection)
        </label>
      </section>

      <section>
        <h2>Render</h2>
        <Segmented<RenderMode>
          value={s.mode}
          onChange={(mode) => onChange({ mode })}
          options={[
            { value: 'dye', label: 'Dye' },
            { value: 'speed', label: 'Speed' },
            { value: 'curl', label: 'Vorticity' },
            { value: 'pressure', label: 'Pressure' },
          ]}
        />
        {(s.mode === 'speed' || s.mode === 'pressure' || s.mode === 'curl') && (
          <div className="colormaps">
            {(Object.keys(COLORMAPS) as ColorMapName[]).map((c) => (
              <button
                key={c}
                type="button"
                className={`cmap ${c === s.colormap ? 'active' : ''}`}
                onClick={() => onChange({ colormap: c })}
              >
                {c}
              </button>
            ))}
          </div>
        )}
        <Slider
          label="Exposure"
          value={s.exposure}
          min={0.2}
          max={3}
          step={0.05}
          fmt={(v) => `${v.toFixed(2)}×`}
          onChange={(exposure) => onChange({ exposure })}
        />
        <label className="checkbox">
          <input
            type="checkbox"
            checked={s.showArrows}
            onChange={(e) => onChange({ showArrows: e.target.checked })}
          />
          Velocity field overlay
        </label>
        <Slider
          label="Resolution"
          value={s.resolution}
          min={64}
          max={256}
          step={16}
          fmt={(v) => `${v}²`}
          onChange={(resolution) => onChange({ resolution })}
        />
      </section>
    </aside>
  );
}
