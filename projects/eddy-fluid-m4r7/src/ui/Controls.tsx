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
  onToggleRecord: () => void;
  recording: boolean;
  canRecord: boolean;
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
        {props.canRecord && (
          <div className="row">
            <button
              type="button"
              className={props.recording ? 'recording' : ''}
              onClick={props.onToggleRecord}
              title="Record the canvas to a WebM video clip"
            >
              {props.recording ? '⏹ Stop recording' : '⏺ Record clip'}
            </button>
          </div>
        )}
      </section>

      <section>
        <h2>Brush</h2>
        <Segmented<Tool>
          value={s.tool}
          onChange={(tool) => onChange({ tool })}
          options={[
            { value: 'dye', label: 'Dye' },
            { value: 'heat', label: 'Heat' },
            { value: 'fuel', label: 'Fuel' },
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
          label="Dye diffusion κₛ (Schmidt)"
          value={s.params.dyeDiffusion}
          min={0}
          max={0.0002}
          step={0.000005}
          fmt={(v) =>
            v === 0
              ? 'off'
              : `${v.toExponential(1)} · Sc≈${s.params.viscosity > 0 ? (s.params.viscosity / v).toFixed(1) : '∞'}`
          }
          onChange={(dyeDiffusion) => onParam({ dyeDiffusion })}
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
        <Slider
          label="Over-relaxation ω"
          value={s.params.overRelax}
          min={1}
          max={1.95}
          step={0.05}
          fmt={(v) => v.toFixed(2)}
          onChange={(overRelax) => onParam({ overRelax })}
        />
        <label className="checkbox">
          <input
            type="checkbox"
            checked={s.params.sharpDye}
            onChange={(e) => onParam({ sharpDye: e.target.checked })}
          />
          Sharp dye (MacCormack advection)
        </label>
        <div className="field-label">Pressure solver</div>
        <Segmented<'sor' | 'cg' | 'mg' | 'mgcg'>
          value={s.params.pressureSolver}
          onChange={(pressureSolver) => onParam({ pressureSolver })}
          options={[
            { value: 'sor', label: 'SOR' },
            { value: 'cg', label: 'CG' },
            { value: 'mg', label: 'Multigrid' },
            { value: 'mgcg', label: 'MGCG' },
          ]}
        />
        <p className="scene-blurb">
          All four solve the same Poisson system. <strong>SOR</strong> is cheapest per sweep;{' '}
          <strong>CG</strong> (Krylov) converges far faster per iteration; <strong>Multigrid</strong>{' '}
          is work-optimal (O(N), grid-independent convergence) and shines on open domains;{' '}
          <strong>MGCG</strong> wraps a multigrid V-cycle in CG — grid-independent <em>and</em> robust
          to obstacles. See the <a href="#/verify">Verify</a> page for the head-to-head.
        </p>
      </section>

      <section>
        <h2>Thermal (buoyancy)</h2>
        <Slider
          label="Buoyancy"
          value={s.params.buoyancy}
          min={0}
          max={140}
          step={1}
          onChange={(buoyancy) => onParam({ buoyancy })}
        />
        <Slider
          label="Heat diffusion"
          value={s.params.thermalDiffusion}
          min={0}
          max={0.0002}
          step={0.000005}
          fmt={(v) => v.toExponential(1)}
          onChange={(thermalDiffusion) => onParam({ thermalDiffusion })}
        />
        <Slider
          label="Cooling"
          value={s.params.cooling}
          min={0}
          max={1}
          step={0.01}
          fmt={(v) => v.toFixed(2)}
          onChange={(cooling) => onParam({ cooling })}
        />
        <p className="scene-blurb">
          Use the <strong>Heat</strong> brush to inject hot fluid; buoyancy lifts it. Try the
          Rayleigh–Bénard or plume scenes with the Temperature render mode.
        </p>
      </section>

      <section>
        <h2>Combustion (reactive flow)</h2>
        <Slider
          label="Reaction rate"
          value={s.params.combustion}
          min={0}
          max={12}
          step={0.25}
          fmt={(v) => (v === 0 ? 'off' : v.toFixed(2))}
          onChange={(combustion) => onParam({ combustion })}
        />
        <Slider
          label="Ignition temp"
          value={s.params.ignition}
          min={0}
          max={3}
          step={0.05}
          fmt={(v) => v.toFixed(2)}
          onChange={(ignition) => onParam({ ignition })}
        />
        <Slider
          label="Heat release"
          value={s.params.heatRelease}
          min={0}
          max={8}
          step={0.1}
          fmt={(v) => v.toFixed(1)}
          onChange={(heatRelease) => onParam({ heatRelease })}
        />
        <Slider
          label="Smoke buoyancy"
          value={s.params.smokeBuoyancy}
          min={-20}
          max={20}
          step={0.5}
          onChange={(smokeBuoyancy) => onParam({ smokeBuoyancy })}
        />
        <p className="scene-blurb">
          A real reactive flow: an advected <strong>fuel</strong> field ignites above the threshold
          temperature, releases heat, and is consumed. <strong>Smoke buoyancy</strong> is a
          variable-density (non-Boussinesq) lift proportional to local dye mass. Load the{' '}
          <strong>Fire</strong> scene to see it.
        </p>
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
            { value: 'temperature', label: 'Temp' },
            { value: 'lic', label: 'LIC' },
            { value: 'schlieren', label: 'Schlieren' },
            { value: 'qcrit', label: 'Q-vortex' },
            { value: 'ftle', label: 'LCS' },
          ]}
        />
        {s.mode === 'ftle' && (
          <>
            <Segmented<'fwd' | 'bwd'>
              value={s.ftleBackward ? 'bwd' : 'fwd'}
              onChange={(d) => onChange({ ftleBackward: d === 'bwd' })}
              options={[
                { value: 'bwd', label: 'Attracting (backward)' },
                { value: 'fwd', label: 'Repelling (forward)' },
              ]}
            />
            <Slider
              label="Integration time τ"
              value={s.ftleTime}
              min={0.2}
              max={3}
              step={0.1}
              fmt={(v) => `${v.toFixed(1)} s`}
              onChange={(ftleTime) => onChange({ ftleTime })}
            />
            <p className="scene-blurb">
              <strong>Lagrangian Coherent Structures.</strong> Each pixel is the finite-time Lyapunov
              exponent — how fast nearby tracers separate over τ. Bright ridges are transport barriers.{' '}
              <strong>Attracting</strong> (backward-time) ridges are the filaments where dye collects;{' '}
              <strong>repelling</strong> (forward-time) ridges are the watersheds it is flung from.
            </p>
          </>
        )}
        {s.mode !== 'dye' && (
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
        <label className="checkbox">
          <input
            type="checkbox"
            checked={s.showStreamlines}
            onChange={(e) => onChange({ showStreamlines: e.target.checked })}
          />
          Streamlines
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={s.showParticles}
            onChange={(e) => onChange({ showParticles: e.target.checked })}
          />
          Tracer particles
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={s.showProbe}
            onChange={(e) => onChange({ showProbe: e.target.checked })}
          />
          Hover probe (read fields at the cursor)
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
