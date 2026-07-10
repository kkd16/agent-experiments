import { useEffect, useRef, useState } from 'react'
import type { Example, DriverSpec } from '../model/examples'
import type { ConstraintOption } from '../model/constraintRules'
import type { Constraint, Entity } from '../model/types'
import type { DofReport } from '../solver/dof'
import type { SolveResult } from '../solver/solver'
import type { TestResult } from '../solver/selftest'
import { statusColor } from '../render/renderer'

type ToolId = 'select' | 'point' | 'line' | 'circle'

const TOOLS: { id: ToolId; label: string; icon: string; key: string }[] = [
  { id: 'select', label: 'Select / Drag', icon: '⭤', key: 'V' },
  { id: 'point', label: 'Point', icon: '•', key: 'P' },
  { id: 'line', label: 'Line', icon: '╱', key: 'L' },
  { id: 'circle', label: 'Circle', icon: '◯', key: 'C' },
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
  }
  let s = label[c.kind] ?? c.kind
  if (c.value !== undefined && (c.kind === 'distance' || c.kind === 'radius' || c.kind === 'diameter'))
    s += ` = ${c.value.toFixed(0)}`
  else if (c.value !== undefined && c.kind === 'angle') s += ` = ${c.value.toFixed(0)}°`
  return s
}

export function InfoPanel(props: {
  dof: DofReport
  solveInfo: SolveResult | null
  selected: Entity[]
  constraints: Constraint[]
  redundant: Set<number>
  onRemoveConstraint: (id: number) => void
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

      <section className="pSection grow">
        <h3>
          Constraints <span className="count">{props.constraints.length}</span>
        </h3>
        <ul className="cList">
          {props.constraints.length === 0 && <li className="empty">No constraints yet.</li>}
          {props.constraints.map((c) => {
            const isRedundant = props.redundant.has(c.id)
            return (
              <li key={c.id} className={`${c.driver ? 'driver' : ''} ${isRedundant ? 'redundant' : ''}`}>
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
