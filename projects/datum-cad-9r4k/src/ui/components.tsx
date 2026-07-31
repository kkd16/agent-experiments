import { useEffect, useRef, useState } from 'react'
import type { Example, DriverSpec } from '../model/examples'
import type { ConstraintOption } from '../model/constraintRules'
import type { Constraint, Entity } from '../model/types'
import type { DofReport } from '../solver/dof'
import type { SolveResult } from '../solver/solver'
import type { TestResult } from '../solver/selftest'
import type { MotionProfile } from '../solver/kinematics'
import { statusColor } from '../render/renderer'

type ToolId = 'select' | 'point' | 'line' | 'circle' | 'arc' | 'spline'

const TOOLS: { id: ToolId; label: string; icon: string; key: string }[] = [
  { id: 'select', label: 'Select / Drag', icon: '⭤', key: 'V' },
  { id: 'point', label: 'Point', icon: '•', key: 'P' },
  { id: 'line', label: 'Line', icon: '╱', key: 'L' },
  { id: 'circle', label: 'Circle', icon: '◯', key: 'C' },
  { id: 'arc', label: 'Arc', icon: '◜', key: 'A' },
  { id: 'spline', label: 'Spline', icon: '∿', key: 'S' },
]

export function Toolbar(props: {
  tool: ToolId
  onTool: (t: ToolId) => void
  exampleId: string
  examples: Example[]
  onExample: (id: string) => void
  showGrid: boolean
  onToggleGrid: () => void
  showConstraints: boolean
  onToggleConstraints: () => void
  onFit: () => void
  onDiagnostics: () => void
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  onAutoConstrain: () => void
  onNew: () => void
  onSave: () => void
  onOpen: () => void
  onShare: () => void
}) {
  return (
    <header className="toolbar">
      <div className="brand">
        <span className="brandMark">◈</span>
        <div className="brandText">
          <strong>Datum</strong>
          <span>Parametric Sketch Solver</span>
        </div>
      </div>

      <div className="toolGroup">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            className={`toolBtn ${props.tool === t.id ? 'active' : ''}`}
            onClick={() => props.onTool(t.id)}
            title={`${t.label} (${t.key})`}
          >
            <span className="toolIcon">{t.icon}</span>
            <span className="toolLabel">{t.label.split(' ')[0]}</span>
          </button>
        ))}
      </div>

      <div className="toolGroup subtle">
        <button className="chip" onClick={props.onUndo} disabled={!props.canUndo} title="Undo (Ctrl/⌘+Z)">
          ↶ Undo
        </button>
        <button className="chip" onClick={props.onRedo} disabled={!props.canRedo} title="Redo (Ctrl/⌘+Shift+Z)">
          ↷ Redo
        </button>
        <button className="chip accent" onClick={props.onAutoConstrain} title="Infer horizontal / vertical / parallel / equal relations from the rough sketch">
          ✨ Auto
        </button>
      </div>

      <div className="spacer" />

      <label className="exampleSelect">
        <span>Example</span>
        <select value={props.exampleId} onChange={(e) => props.onExample(e.target.value)}>
          {!props.exampleId && (
            <option value="" disabled hidden>
              Custom sketch
            </option>
          )}
          {props.examples.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
      </label>

      <div className="toolGroup subtle">
        <button className={`chip ${props.showGrid ? 'on' : ''}`} onClick={props.onToggleGrid} title="Toggle grid">
          Grid
        </button>
        <button
          className={`chip ${props.showConstraints ? 'on' : ''}`}
          onClick={props.onToggleConstraints}
          title="Toggle constraint glyphs"
        >
          Glyphs
        </button>
        <button className="chip" onClick={props.onFit} title="Fit to view (F)">
          Fit
        </button>
        <button className="chip" onClick={props.onDiagnostics} title="Run solver self-tests">
          ✓ Tests
        </button>
      </div>

      <div className="toolGroup subtle">
        <button className="chip" onClick={props.onNew} title="Start a new blank sketch">
          New
        </button>
        <button className="chip" onClick={props.onOpen} title="Open a .json sketch file">
          Open
        </button>
        <button className="chip" onClick={props.onSave} title="Save this sketch to a .json file">
          Save
        </button>
        <button className="chip accent" onClick={props.onShare} title="Copy a shareable link that reconstructs this sketch">
          ⇪ Share
        </button>
      </div>
    </header>
  )
}

export function ConstraintPalette(props: {
  options: ConstraintOption[]
  onApply: (opt: ConstraintOption) => void
  onDelete: () => void
  onAnchor: () => void
  onReverseArc: () => void
  canReverseArc: boolean
  onSplitSpline: () => void
  canSplitSpline: boolean
  selectionCount: number
}) {
  return (
    <div className="palette">
      <div className="paletteHead">
        {props.selectionCount === 0 ? 'Select geometry to constrain' : `${props.selectionCount} selected`}
      </div>
      <div className="paletteBody">
        {props.options.map((o) => (
          <button key={o.kind + o.label} className="cBtn" onClick={() => props.onApply(o)} title={o.label}>
            <span className="cSym">{o.symbol}</span>
            <span className="cLbl">{o.label}</span>
          </button>
        ))}
        {props.canReverseArc && (
          <button className="cBtn" onClick={props.onReverseArc} title="Swap the arc's endpoints — toggle the minor / major arc">
            <span className="cSym">↺</span>
            <span className="cLbl">Reverse</span>
          </button>
        )}
        {props.canSplitSpline && (
          <button className="cBtn" onClick={props.onSplitSpline} title="Split the spline into two curves (at a selected bead, else the midpoint) — exact, C1 at the join">
            <span className="cSym">✂</span>
            <span className="cLbl">Split</span>
          </button>
        )}
        {props.selectionCount > 0 && (
          <>
            <button className="cBtn warn" onClick={props.onAnchor} title="Anchor / free a point (fix its position)">
              <span className="cSym">⚓</span>
              <span className="cLbl">Anchor</span>
            </button>
            <button className="cBtn danger" onClick={props.onDelete} title="Delete selection (Del)">
              <span className="cSym">🗑</span>
              <span className="cLbl">Delete</span>
            </button>
          </>
        )}
      </div>
    </div>
  )
}

function describeConstraint(c: Constraint): string {
  const label: Record<string, string> = {
    coincident: 'Coincident',
    horizontal: 'Horizontal',
    vertical: 'Vertical',
    parallel: 'Parallel',
    perpendicular: 'Perpendicular',
    equalLength: 'Equal length',
    equalRadius: 'Equal radius',
    distance: 'Distance',
    pointOnLine: 'Point on line',
    pointOnCircle: 'Point on circle',
    radius: 'Radius',
    diameter: 'Diameter',
    tangentLineCircle: 'Tangent',
    tangentCircles: 'Tangent',
    concentric: 'Concentric',
    angle: 'Angle',
    midpoint: 'Midpoint',
    symmetric: 'Symmetric',
    colinear: 'Colinear',
    splineTangentLine: 'Spline tangent',
    splineTangentSpline: 'Smooth join',
    splineTangentArc: 'Spline tangent',
    pointOnSpline: 'On spline',
    splineLength: 'Length',
  }
  let s = label[c.kind] ?? c.kind
  if (c.value !== undefined && (c.kind === 'distance' || c.kind === 'radius' || c.kind === 'diameter' || c.kind === 'splineLength'))
    s += ` = ${c.value.toFixed(0)}`
  else if (c.value !== undefined && c.kind === 'angle') s += ` = ${c.value.toFixed(0)}°`
  return s
}

// Live kinematics readout for the driven mechanism's tracer point.
export type MotionData = {
  unit: 'rad' | 'len'
  tracerLabel: string
  speedCoeff: number // |dx/dθ| at the tracer
  accelCoeff: number // |d²x/dθ²| at the tracer
  omega: number // driver rate (θ-units per second) from the driver's sweep period
  driveGain: number // peak |velocity coefficient| over the whole mechanism
  nearDeadPoint: boolean
  currentFrac: number // 0..1 position of the current driver value within its range
  showVelocity: boolean
  showAccel: boolean
  onToggleVelocity: () => void
  onToggleAccel: () => void
  profile: MotionProfile | null
}

function fmt(x: number): string {
  if (!Number.isFinite(x)) return '∞'
  const a = Math.abs(x)
  if (a === 0) return '0'
  if (a >= 1000 || a < 0.01) return x.toExponential(1)
  return x.toFixed(a < 1 ? 3 : a < 10 ? 2 : 1)
}

// The hodograph: the locus of the tracer's velocity vector *tip* (x'(θ), y'(θ)) as
// the crank turns one full cycle — the classical velocity diagram of a mechanism.
// Its distance from the origin is the velocity ratio at that instant; a cusp/loop
// through the origin marks a dead point. Drawn in its own centred, aspect-true frame
// with the current crank position highlighted. Pure inline SVG.
function Hodograph({ profile, currentFrac }: { profile: MotionProfile; currentFrac: number }) {
  const S = 120
  const n = profile.samples.length
  if (n < 2 || profile.maxSpeed <= 1e-9) return null
  const R = profile.maxSpeed * 1.08
  const map = (vx: number, vy: number): [number, number] => [
    S / 2 + (vx / R) * (S / 2 - 6),
    S / 2 - (vy / R) * (S / 2 - 6), // flip y to world-up
  ]
  const d = profile.samples
    .map((s, i) => {
      const [x, y] = map(s.vx, s.vy)
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  const idx = Math.min(n - 1, Math.max(0, Math.round(currentFrac * (n - 1))))
  const cur = map(profile.samples[idx].vx, profile.samples[idx].vy)
  return (
    <svg className="hodograph" viewBox={`0 0 ${S} ${S}`} width={S} height={S}>
      <rect x="0" y="0" width={S} height={S} fill="#0b1017" />
      <line x1={S / 2} y1="0" x2={S / 2} y2={S} stroke="#26313f" strokeWidth="1" />
      <line x1="0" y1={S / 2} x2={S} y2={S / 2} stroke="#26313f" strokeWidth="1" />
      <path d={d + 'Z'} fill="none" stroke="#57e6c9" strokeWidth="1.4" />
      <circle cx={cur[0]} cy={cur[1]} r="3" fill="#ffd166" />
      <line x1={S / 2} y1={S / 2} x2={cur[0]} y2={cur[1]} stroke="#ffd166" strokeWidth="1" strokeOpacity="0.6" />
    </svg>
  )
}

// A tiny two-curve plot of the tracer's speed (cyan) and acceleration magnitude
// (orange) across one full driver sweep, each normalised to its own peak, with a
// marker at the current driver position. Pure inline SVG — no chart dependency.
function MotionPlot({ profile, currentFrac }: { profile: MotionProfile; currentFrac: number }) {
  const W = 232
  const H = 84
  const pad = 4
  const n = profile.samples.length
  if (n < 2) return null
  const path = (pick: (s: MotionSampleView) => number, max: number) => {
    if (max <= 1e-12) return ''
    return profile.samples
      .map((s, i) => {
        const x = pad + ((W - 2 * pad) * i) / (n - 1)
        const y = H - pad - ((H - 2 * pad) * pick(s)) / max
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
      })
      .join(' ')
  }
  const mx = pad + (W - 2 * pad) * Math.min(1, Math.max(0, currentFrac))
  return (
    <svg className="motionPlot" viewBox={`0 0 ${W} ${H}`} width="100%" preserveAspectRatio="none">
      <rect x="0" y="0" width={W} height={H} fill="#0b1017" />
      <line x1={mx} y1="0" x2={mx} y2={H} stroke="#ffffff" strokeWidth="1" strokeOpacity="0.5" />
      <path d={path((s) => s.jerk, profile.maxJerk)} fill="none" stroke="#ff8a65" strokeWidth="1.2" strokeOpacity="0.85" />
      <path d={path((s) => s.accel, profile.maxAccel)} fill="none" stroke="#c792ea" strokeWidth="1.4" />
      <path d={path((s) => s.speed, profile.maxSpeed)} fill="none" stroke="#57e6c9" strokeWidth="1.4" />
    </svg>
  )
}

type MotionSampleView = { speed: number; accel: number; jerk: number }

function MotionSection(props: { motion: MotionData }) {
  const m = props.motion
  const av = m.unit === 'rad' ? 'rad' : 'u'
  return (
    <section className="pSection">
      <h3>Kinematics</h3>
      <div className="chipRow">
        <button className={`chip ${m.showVelocity ? 'on' : ''}`} onClick={m.onToggleVelocity}>
          <span className="swatch v" /> Velocity
        </button>
        <button className={`chip ${m.showAccel ? 'on' : ''}`} onClick={m.onToggleAccel}>
          <span className="swatch a" /> Accel
        </button>
      </div>
      <p className="hint">
        Exact velocity &amp; acceleration of the mechanism, from the constraint Jacobian (dx/dθ) and its second-order
        kinematic coefficient (d²x/dθ²). Tracing <strong>#{m.tracerLabel}</strong>.
      </p>
      <div className="statGrid">
        <Stat label={`speed  (u/${av})`} value={fmt(m.speedCoeff)} />
        <Stat label={`accel  (u/${av}²)`} value={fmt(m.accelCoeff)} />
        <Stat label="speed (u/s)" value={fmt(m.speedCoeff * m.omega)} />
        <Stat label="accel (u/s²)" value={fmt(m.accelCoeff * m.omega * m.omega)} />
      </div>
      <div className="dofBadge" style={{ borderColor: m.nearDeadPoint ? '#ff6b81' : '#33475a', color: m.nearDeadPoint ? '#ff6b81' : '#a9c0d6' }}>
        {m.nearDeadPoint ? `Near a dead point — drive gain ${fmt(m.driveGain)}` : `Drive gain ${fmt(m.driveGain)} u/${av}`}
      </div>
      {m.profile && m.profile.samples.length > 1 && (
        <>
          <MotionPlot profile={m.profile} currentFrac={m.currentFrac} />
          <div className="plotLegend">
            <span><span className="swatch v" /> speed</span>
            <span><span className="swatch a" /> |accel|</span>
            <span><span className="swatch j" /> |jerk|</span>
            <span className="muted">over one full sweep</span>
          </div>
          <div className="hodoRow">
            <Hodograph profile={m.profile} currentFrac={m.currentFrac} />
            <div className="hodoInfo">
              <div className="hodoTitle">Hodograph</div>
              <p className="hint">Locus of the tracer's velocity-vector tip over one cycle; its radius is the velocity ratio.</p>
              <div className="statGrid">
                <Stat label={`vel ratio max (u/${av})`} value={fmt(m.profile.maxSpeed)} />
                <Stat label={`vel ratio min (u/${av})`} value={fmt(m.profile.minSpeed)} good={m.profile.minSpeed > 1e-3} />
              </div>
              <p className="hint">
                {m.profile.minSpeed < 1e-3
                  ? 'Mechanical advantage → ∞ at a toggle (the tracer stalls, minimum velocity ratio ≈ 0).'
                  : `Mechanical advantage ranges ${fmt(1 / Math.max(m.profile.maxSpeed, 1e-9))}–${fmt(1 / Math.max(m.profile.minSpeed, 1e-9))} (input rate ÷ tracer rate).`}
              </p>
            </div>
          </div>
        </>
      )}
    </section>
  )
}

// --- Dynamics (time-domain physics) -------------------------------------------

export type DynSample = { T: number; V: number; E: number }

export type DynParamsView = { gravity: number; density: number; baseMass: number; damping: number; torque: number }

export type DynView = {
  on: boolean
  unit: 'rad' | 'len'
  params: DynParamsView
  readout: { T: number; V: number; E: number; I: number; omega: number; history: DynSample[] } | null
  onToggle: () => void
  onReset: () => void
  onChange: (patch: Partial<DynParamsView>) => void
}

// The energy trace: kinetic (cyan) and potential (violet) trade off while total
// (white) stays flat — the visual proof the integrator conserves energy. Each curve
// is normalised to the common min/max of all three across the window, so their
// relative levels read truthfully. Pure inline SVG.
function EnergyPlot({ history }: { history: DynSample[] }) {
  const W = 232
  const H = 72
  const pad = 4
  const n = history.length
  if (n < 2) return <div className="energyPlaceholder">Run the simulation to see the energy exchange.</div>
  let lo = Infinity
  let hi = -Infinity
  for (const s of history) {
    lo = Math.min(lo, s.T, s.V, s.E)
    hi = Math.max(hi, s.T, s.V, s.E)
  }
  const span = hi - lo || 1
  const path = (pick: (s: DynSample) => number) =>
    history
      .map((s, i) => {
        const x = pad + ((W - 2 * pad) * i) / (n - 1)
        const y = H - pad - ((H - 2 * pad) * (pick(s) - lo)) / span
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
      })
      .join(' ')
  return (
    <svg className="motionPlot" viewBox={`0 0 ${W} ${H}`} width="100%" preserveAspectRatio="none">
      <rect x="0" y="0" width={W} height={H} fill="#0b1017" />
      <path d={path((s) => s.V)} fill="none" stroke="#c792ea" strokeWidth="1.3" />
      <path d={path((s) => s.T)} fill="none" stroke="#57e6c9" strokeWidth="1.3" />
      <path d={path((s) => s.E)} fill="none" stroke="#ffffff" strokeWidth="1.6" strokeOpacity="0.9" />
    </svg>
  )
}

function DynSlider(props: { label: string; value: number; min: number; max: number; step: number; suffix?: string; onChange: (v: number) => void }) {
  return (
    <label className="dynSlider">
      <span className="dynSliderLabel">
        {props.label}
        <em>
          {props.value.toFixed(props.step < 0.01 ? 3 : props.step < 1 ? 2 : 0)}
          {props.suffix ?? ''}
        </em>
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
  )
}

function DynamicsSection({ dyn }: { dyn: DynView }) {
  const r = dyn.readout
  const rate = dyn.unit === 'rad' ? 'rad/s' : 'u/s'
  return (
    <section className="pSection">
      <h3>Dynamics</h3>
      <div className="chipRow">
        <button className={`chip ${dyn.on ? 'on' : ''}`} onClick={dyn.onToggle}>
          {dyn.on ? '■ Release ▸ held' : '▸ Release & run'}
        </button>
        <button className="chip" onClick={dyn.onReset} disabled={!dyn.on}>
          Reset motion
        </button>
      </div>
      <p className="hint">
        Let go of the driver and give the links mass: the mechanism runs under its own physics. One-DOF Lagrangian
        (Eksergian) equation of motion, marched by RK4 — <strong>I(θ)θ̈ + ½I′θ̇² = τ − cθ̇ − V′</strong>, with the
        generalized inertia I(θ)=Σmᵢ|xᵢ′|² built from the exact kinematic coefficients.
      </p>
      <DynSlider label="Gravity g" value={dyn.params.gravity} min={0} max={800} step={10} onChange={(v) => dyn.onChange({ gravity: v })} />
      <DynSlider label="Link density ρ" value={dyn.params.density} min={0} max={0.06} step={0.002} onChange={(v) => dyn.onChange({ density: v })} />
      <DynSlider label="Damping c" value={dyn.params.damping} min={0} max={0.6} step={0.01} onChange={(v) => dyn.onChange({ damping: v })} />
      <DynSlider label="Drive torque τ" value={dyn.params.torque} min={-400} max={400} step={10} onChange={(v) => dyn.onChange({ torque: v })} />
      <div className="statGrid">
        <Stat label="kinetic T" value={r ? fmt(r.T) : '—'} />
        <Stat label="potential V" value={r ? fmt(r.V) : '—'} />
        <Stat label="total E" value={r ? fmt(r.E) : '—'} />
        <Stat label={`rate θ̇ (${rate})`} value={r ? fmt(r.omega) : '—'} />
      </div>
      <EnergyPlot history={r?.history ?? []} />
      <div className="plotLegend">
        <span><span className="swatch v" /> kinetic</span>
        <span><span className="swatch a" /> potential</span>
        <span className="muted">total (white) stays flat ⇒ energy conserved</span>
      </div>
    </section>
  )
}

export function InfoPanel(props: {
  dof: DofReport
  solveInfo: SolveResult | null
  selected: Entity[]
  constraints: Constraint[]
  redundant: Set<number>
  motion?: MotionData | null
  dynamics?: DynView | null
  canExportCsv?: boolean
  onExport?: (fmt: 'svg' | 'dxf' | 'csv') => void
  onRemoveConstraint: (id: number) => void
  onHoverConstraint: (id: number | null) => void
}) {
  const { dof } = props
  const statusText =
    dof.status === 'well'
      ? 'Fully constrained'
      : dof.status === 'under'
        ? `Under-constrained · ${dof.dof} DOF`
        : dof.status === 'over'
          ? `Over-constrained · ${dof.redundant} redundant`
          : 'Empty sketch'

  return (
    <aside className="panel">
      {props.dynamics && <DynamicsSection dyn={props.dynamics} />}
      {props.motion && <MotionSection motion={props.motion} />}
      <section className="pSection">
        <h3>Degrees of Freedom</h3>
        <div className="dofBadge" style={{ borderColor: statusColor(dof.status), color: statusColor(dof.status) }}>
          {statusText}
        </div>
        <div className="statGrid">
          <Stat label="Parameters" value={dof.params} />
          <Stat label="Equations" value={dof.equations} />
          <Stat label="Independent" value={dof.rank} />
          <Stat label="Free DOF" value={dof.dof} />
        </div>
        {dof.redundant > 0 && (
          <p className="hint warn">
            {dof.redundant} constraint equation{dof.redundant > 1 ? 's are' : ' is'} redundant — the specific culprit
            {props.redundant.size > 1 ? 's are' : ' is'} flagged <span className="conflictWord">in red</span> below and on
            the canvas. Remove one if the sketch fights back.
          </p>
        )}
      </section>

      <section className="pSection">
        <h3>Solver</h3>
        {props.solveInfo ? (
          <div className="statGrid">
            <Stat label="Iterations" value={props.solveInfo.iterations} />
            <Stat label="Converged" value={props.solveInfo.converged ? 'yes' : 'no'} good={props.solveInfo.converged} />
            <Stat label="Max residual" value={props.solveInfo.maxResidual.toExponential(1)} />
            <Stat label="‖r‖" value={props.solveInfo.residualNorm.toExponential(1)} />
          </div>
        ) : (
          <p className="hint">Solve results appear here.</p>
        )}
      </section>

      {props.onExport && (
        <section className="pSection">
          <h3>Export</h3>
          <div className="chipRow">
            <button className="chip" onClick={() => props.onExport!('svg')}>
              SVG
            </button>
            <button className="chip" onClick={() => props.onExport!('dxf')}>
              DXF
            </button>
            <button className="chip" onClick={() => props.onExport!('csv')} disabled={!props.canExportCsv} title={props.canExportCsv ? 'Motion profile as CSV' : 'Drive a mechanism first'}>
              CSV
            </button>
          </div>
          <p className="hint">
            The solved sketch as vector <strong>SVG</strong> (exact Béziers &amp; arcs) or a real{' '}
            <strong>DXF</strong> (LINE / CIRCLE / ARC, opens in any CAD); the driven mechanism's velocity/acceleration
            profile as <strong>CSV</strong>.
          </p>
        </section>
      )}

      <section className="pSection grow">
        <h3>
          Constraints <span className="count">{props.constraints.length}</span>
        </h3>
        <ul className="cList">
          {props.constraints.length === 0 && <li className="empty">No constraints yet.</li>}
          {props.constraints.map((c) => {
            const isRedundant = props.redundant.has(c.id)
            return (
              <li
                key={c.id}
                className={`${c.driver ? 'driver' : ''} ${isRedundant ? 'redundant' : ''}`}
                onMouseEnter={() => props.onHoverConstraint(c.id)}
                onMouseLeave={() => props.onHoverConstraint(null)}
              >
                <span className="cName">
                  {c.driver && <span className="drvDot" title="Driver" />}
                  {isRedundant && <span className="redDot" title="Redundant / conflicting" />} {describeConstraint(c)}
                </span>
                <button className="xBtn" onClick={() => props.onRemoveConstraint(c.id)} title="Remove">
                  ×
                </button>
              </li>
            )
          })}
        </ul>
      </section>

      <section className="pSection">
        <h3>Selection</h3>
        {props.selected.length === 0 ? (
          <p className="hint">Nothing selected. Shift-click to multi-select.</p>
        ) : (
          <ul className="selList">
            {props.selected.map((e) => (
              <li key={e.id}>
                <span className="tag">{e.kind}</span> #{e.id}
                {e.kind === 'point' && e.fixed && <span className="tag fixed">anchored</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  )
}

function Stat(props: { label: string; value: number | string; good?: boolean }) {
  return (
    <div className="stat">
      <div className={`statVal ${props.good ? 'good' : ''}`}>{props.value}</div>
      <div className="statLbl">{props.label}</div>
    </div>
  )
}

export function DriverBar(props: {
  spec: DriverSpec
  value: number
  playing: boolean
  onPlay: () => void
  onScrub: (v: number) => void
  showTrace: boolean
  onToggleTrace: () => void
  onClearTrace: () => void
}) {
  return (
    <footer className="driverBar">
      <button className={`playBtn ${props.playing ? 'playing' : ''}`} onClick={props.onPlay}>
        {props.playing ? '❚❚ Pause' : '▶ Drive'}
      </button>
      <div className="driverLabel">{props.spec.label}</div>
      <input
        className="driverSlider"
        type="range"
        min={props.spec.min}
        max={props.spec.max}
        step={0.5}
        value={props.value}
        onChange={(e) => props.onScrub(parseFloat(e.target.value))}
      />
      <div className="driverValue">
        {props.value.toFixed(0)}
        {props.spec.unit}
      </div>
      <div className="spacer" />
      <button className={`chip ${props.showTrace ? 'on' : ''}`} onClick={props.onToggleTrace}>
        Trace
      </button>
      <button className="chip" onClick={props.onClearTrace}>
        Clear
      </button>
    </footer>
  )
}

export function ValuePrompt(props: {
  option: ConstraintOption
  onConfirm: (v: number) => void
  onCancel: () => void
}) {
  const [val, setVal] = useState(String(props.option.defaultValue ?? 0))
  const inputRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])
  const unit = props.option.value === 'angle' ? '°' : ''
  const submit = () => {
    const n = parseFloat(val)
    if (isFinite(n)) props.onConfirm(n)
  }
  return (
    <div className="modalScrim" onMouseDown={props.onCancel}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h3>{props.option.label}</h3>
        <p className="hint">Enter the target value.</p>
        <div className="valueRow">
          <input
            ref={inputRef}
            type="number"
            value={val}
            onChange={(e) => setVal(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
              if (e.key === 'Escape') props.onCancel()
            }}
          />
          <span className="unit">{unit || 'units'}</span>
        </div>
        <div className="modalBtns">
          <button className="chip" onClick={props.onCancel}>
            Cancel
          </button>
          <button className="chip primary" onClick={submit}>
            Apply
          </button>
        </div>
      </div>
    </div>
  )
}

export function Diagnostics(props: { tests: TestResult[]; onClose: () => void; onRerun: () => void }) {
  const passed = props.tests.filter((t) => t.pass).length
  const all = props.tests.length
  return (
    <div className="modalScrim" onMouseDown={props.onClose}>
      <div className="modal wide" onMouseDown={(e) => e.stopPropagation()}>
        <h3>
          Solver self-tests{' '}
          <span className={passed === all ? 'allGood' : 'someBad'}>
            {passed}/{all} passing
          </span>
        </h3>
        <p className="hint">
          Each check re-derives a solver claim from an independent reference — distances hit their targets, mechanisms
          stay assembled through a full rotation, and rigid bodies keep their shape.
        </p>
        <ul className="testList">
          {props.tests.map((t) => (
            <li key={t.name} className={t.pass ? 'pass' : 'fail'}>
              <span className="mark">{t.pass ? '✓' : '✕'}</span>
              <span className="tName">{t.name}</span>
              <span className="tDetail">{t.detail}</span>
            </li>
          ))}
        </ul>
        <div className="modalBtns">
          <button className="chip" onClick={props.onRerun}>
            Re-run
          </button>
          <button className="chip primary" onClick={props.onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
