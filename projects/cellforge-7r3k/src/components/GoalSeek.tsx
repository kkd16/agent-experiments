import { useState } from 'react'
import type { Workbook } from '../engine/workbook'
import type { Coord } from '../engine/address'
import { parseRef, coordToA1 } from '../engine/address'
import { formatNumber } from '../engine/values'

interface Props {
  wb: Workbook
  sheetId: string
  /** A1 of the cell selected when the dialog opened — a sensible default target. */
  initialTarget: string
  onApply: (changing: Coord, value: number) => void
  onGoto: (c: Coord) => void
  onClose: () => void
}

interface Outcome {
  found: boolean
  changing: Coord
  x: number
  achieved: number
  iterations: number
}

/** What-if analysis: vary one input cell until a formula cell hits a target value.
 *  Backed by the engine's hybrid secant/bisection solver, run over real recalcs. */
export default function GoalSeek({ wb, sheetId, initialTarget, onApply, onGoto, onClose }: Props) {
  const [targetRef, setTargetRef] = useState(initialTarget)
  const [targetVal, setTargetVal] = useState('0')
  const [changeRef, setChangeRef] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<Outcome | null>(null)

  const run = () => {
    setOutcome(null)
    const target = parseRef(targetRef.trim())
    const changing = parseRef(changeRef.trim())
    const goal = Number(targetVal.trim())
    if (!target) return setError('Set cell must be a reference like B5.')
    if (!changing) return setError('By changing cell must be a reference like A1.')
    if (!Number.isFinite(goal)) return setError('Target value must be a number.')
    if (target.row === changing.row && target.col === changing.col) return setError('The two cells must be different.')
    if (!wb.isFormula({ row: target.row, col: target.col }, sheetId)) {
      return setError('The “Set cell” should hold a formula that depends on the changing cell.')
    }
    setError(null)
    const res = wb.goalSeek(
      { row: target.row, col: target.col },
      goal,
      { row: changing.row, col: changing.col },
      sheetId,
    )
    setOutcome({ found: res.found, changing: { row: changing.row, col: changing.col }, x: res.x, achieved: res.achieved, iterations: res.iterations })
  }

  const apply = () => {
    if (!outcome) return
    onApply(outcome.changing, outcome.x)
    onClose()
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal goalseek" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Goal Seek</h3>
          <button className="modal-x" onClick={onClose}>
            ✕
          </button>
        </div>

        <p className="modal-hint">
          Find the input that produces the result you want. The solver sets the changing cell, recalculates the whole
          workbook, and homes in on the target — secant first, bisection as a safety net.
        </p>

        <div className="gs-grid">
          <label>Set cell</label>
          <input className="name-in mono" value={targetRef} onChange={(e) => setTargetRef(e.target.value)} spellCheck={false} placeholder="B5" />
          <label>To value</label>
          <input className="name-in mono" value={targetVal} onChange={(e) => setTargetVal(e.target.value)} spellCheck={false} placeholder="100" />
          <label>By changing cell</label>
          <input className="name-in mono" value={changeRef} onChange={(e) => setChangeRef(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && run()} spellCheck={false} placeholder="A1" />
        </div>

        {error ? <div className="name-error">{error}</div> : null}

        {outcome ? (
          <div className={'gs-result' + (outcome.found ? '' : ' miss')}>
            {outcome.found ? (
              <>
                <div>
                  Set <button className="linkref" onClick={() => onGoto(outcome.changing)}>{coordToA1(outcome.changing.row, outcome.changing.col)}</button> to{' '}
                  <strong className="mono">{formatNumber(outcome.x)}</strong>
                </div>
                <div className="muted">
                  target reaches <span className="mono">{formatNumber(outcome.achieved)}</span> · {outcome.iterations} iterations
                </div>
              </>
            ) : (
              <div>No solution found — the target may be unreachable from that cell. Closest: <span className="mono">{formatNumber(outcome.achieved)}</span></div>
            )}
          </div>
        ) : null}

        <div className="gs-actions">
          <button className="btn" onClick={run}>
            Solve
          </button>
          <button className="btn primary" onClick={apply} disabled={!outcome || !outcome.found}>
            Apply
          </button>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
