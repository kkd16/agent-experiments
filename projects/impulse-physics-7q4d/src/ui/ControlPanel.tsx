import { type DebugOptions } from '../render/renderer';
import { SPAWN_KINDS, type SpawnKind } from './spawn';

/** Scalar simulation controls owned by the App. */
export interface ControlValues {
  gravityY: number;
  velocityIterations: number;
  positionIterations: number;
  baumgarte: number;
  warmStarting: boolean;
  enableSleep: boolean;
  continuous: boolean;
  blockSolver: boolean;
  showGjk: boolean;
  spawnKind: SpawnKind;
}

interface Props {
  running: boolean;
  values: ControlValues;
  debug: DebugOptions;
  onToggleRun: () => void;
  onStep: () => void;
  onReset: () => void;
  onChange: (patch: Partial<ControlValues>) => void;
  onDebug: (patch: Partial<DebugOptions>) => void;
}

const DEBUG_LABELS: Array<[keyof DebugOptions, string]> = [
  ['fill', 'Fill'],
  ['outlines', 'Outlines'],
  ['contacts', 'Contacts'],
  ['aabb', 'AABBs'],
  ['broadphaseTree', 'BVH tree'],
  ['centerOfMass', 'Center of mass'],
  ['velocities', 'Velocities'],
  ['joints', 'Joints'],
  ['sleeping', 'Sleep tint'],
  ['fluidPoints', 'Fluid points'],
];

function Slider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  fmt?: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="ctl-slider">
      <span className="ctl-row">
        <span>{props.label}</span>
        <span className="ctl-value">{props.fmt ? props.fmt(props.value) : props.value}</span>
      </span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(parseFloat(e.target.value))}
      />
    </label>
  );
}

function Toggle(props: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="ctl-toggle">
      <input type="checkbox" checked={props.checked} onChange={(e) => props.onChange(e.target.checked)} />
      <span>{props.label}</span>
    </label>
  );
}

/** The right-hand control panel: transport, solver knobs, spawn, debug draws. */
export default function ControlPanel({
  running,
  values,
  debug,
  onToggleRun,
  onStep,
  onReset,
  onChange,
  onDebug,
}: Props) {
  return (
    <div className="control-panel">
      <div className="transport">
        <button className="btn primary" onClick={onToggleRun}>
          {running ? '❚❚ Pause' : '▶ Play'}
        </button>
        <button className="btn" onClick={onStep} disabled={running}>
          ⏭ Step
        </button>
        <button className="btn" onClick={onReset}>
          ↻ Reset
        </button>
      </div>

      <section className="ctl-section">
        <h4>Solver</h4>
        <Slider label="Gravity" value={values.gravityY} min={-30} max={10} step={0.1}
          fmt={(v) => `${v.toFixed(1)} m/s²`} onChange={(v) => onChange({ gravityY: v })} />
        <Slider label="Velocity iters" value={values.velocityIterations} min={1} max={30} step={1}
          onChange={(v) => onChange({ velocityIterations: v })} />
        <Slider label="Position iters" value={values.positionIterations} min={0} max={12} step={1}
          onChange={(v) => onChange({ positionIterations: v })} />
        <Slider label="Position β" value={values.baumgarte} min={0} max={1} step={0.05}
          fmt={(v) => v.toFixed(2)} onChange={(v) => onChange({ baumgarte: v })} />
        <Toggle label="Warm starting" checked={values.warmStarting} onChange={(v) => onChange({ warmStarting: v })} />
        <Toggle label="Block solver" checked={values.blockSolver} onChange={(v) => onChange({ blockSolver: v })} />
        <Toggle label="Sleeping" checked={values.enableSleep} onChange={(v) => onChange({ enableSleep: v })} />
        <Toggle label="Continuous (CCD)" checked={values.continuous} onChange={(v) => onChange({ continuous: v })} />
      </section>

      <section className="ctl-section">
        <h4>Spawn shape</h4>
        <div className="segmented">
          {SPAWN_KINDS.map((k) => (
            <button
              key={k}
              className={`seg${values.spawnKind === k ? ' active' : ''}`}
              onClick={() => onChange({ spawnKind: k })}
            >
              {k}
            </button>
          ))}
        </div>
        <p className="hint">Click empty space to drop · drag a body to fling · scroll to zoom</p>
      </section>

      <section className="ctl-section">
        <h4>Debug draw</h4>
        <div className="debug-grid">
          {DEBUG_LABELS.map(([key, label]) => (
            <Toggle key={key} label={label} checked={debug[key]} onChange={(v) => onDebug({ [key]: v })} />
          ))}
          <Toggle label="GJK distance" checked={values.showGjk} onChange={(v) => onChange({ showGjk: v })} />
        </div>
      </section>
    </div>
  );
}
