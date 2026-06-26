import { useState } from 'react'
import type { Workbook, SolverConstraintInput, SolverResult, SolverRhs } from '../engine/workbook'
import type { Relation } from '../engine/optimizer'
import type { Coord } from '../engine/address'
import { parseRef, coordToA1 } from '../engine/address'
import { formatNumber } from '../engine/values'

interface Props {
  wb: Workbook
  sheetId: string
  /** A1 of the cell selected when the dialog opened — a sensible default objective. */
  initialObjective: string
  /** A1 (or range) of the selection — a sensible default for the changing cells. */
  initialVariables: string
  onApply: (entries: Array<{ coord: Coord; raw: string }>, focus: Coord) => void
  onGoto: (c: Coord) => void
  onClose: () => void
}

interface ConstraintRow {
  lhs: string
  rel: Relation
  rhs: string
}

/** Expand a comma/space-separated list of refs and ranges ("A2:A5, B7") into coords. */
function parseCellList(text: string): Coord[] | null {
  const parts = text
    .split(/[,;\s]+/)
    .map((p) => p.trim())
    .filter(Boolean)
  if (!parts.length) return null
  const out: Coord[] = []
  const seen = new Set<string>()
  const push = (r: number, c: number) => {
    const k = `${r},${c}`
    if (!seen.has(k)) {
      seen.add(k)
      out.push({ row: r, col: c })
    }
  }
  for (const part of parts) {
    const m = /^([A-Za-z]+\d+)\s*:\s*([A-Za-z]+\d+)$/.exec(part)
    if (m) {
      const a = parseRef(m[1])
      const b = parseRef(m[2])
      if (!a || !b) return null
      for (let r = Math.min(a.row, b.row); r <= Math.max(a.row, b.row); r++)
        for (let c = Math.min(a.col, b.col); c <= Math.max(a.col, b.col); c++) push(r, c)
    } else {
      const ref = parseRef(part)
      if (!ref) return null
      push(ref.row, ref.col)
    }
  }
  return out
}

/** Parse a constraint RHS: a literal number, or a cell reference. */
function parseRhs(text: string): SolverRhs | null {
  const t = text.trim()
  if (t === '') return null
  const n = Number(t)
  if (Number.isFinite(n) && /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(t)) return { kind: 'num', value: n }
  const ref = parseRef(t)
  if (ref) return { kind: 'cell', coord: { row: ref.row, col: ref.col } }
  return null
}

/**
 * The multi-cell **Solver**. Find values for the changing cells that maximize, minimize,
 * or drive the objective cell to a target, subject to constraints. The engine auto-detects
 * a linear model and solves it *exactly* with the simplex method; otherwise it runs a
 * nonlinear penalty / Nelder–Mead search. All over real workbook recalculations.
 */
export default function Solver({ wb, sheetId, initialObjective, initialVariables, onApply, onGoto, onClose }: Props) {
  const [objective, setObjective] = useState(initialObjective)
  const [sense, setSense] = useState<'max' | 'min' | 'value'>('max')
  const [target, setTarget] = useState('0')
  const [variables, setVariables] = useState(initialVariables)
  const [nonNegative, setNonNegative] = useState(true)
  const [constraints, setConstraints] = useState<ConstraintRow[]>([{ lhs: '', rel: '<=', rhs: '' }])
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<SolverResult | null>(null)

  const setRow = (i: number, patch: Partial<ConstraintRow>) =>
    setConstraints((rows) => rows.map((r, k) => (k === i ? { ...r, ...patch } : r)))
  const addRow = () => setConstraints((rows) => [...rows, { lhs: '', rel: '<=', rhs: '' }])
  const removeRow = (i: number) => setConstraints((rows) => rows.filter((_, k) => k !== i))

  const run = () => {
    setResult(null)
    const obj = parseRef(objective.trim())
    if (!obj) return setError('Objective should be a cell reference like B5.')
    const vars = parseCellList(variables)
    if (!vars) return setError('Changing cells should be references or ranges, e.g. "B2:B4" or "A1, A2".')
    if (vars.length > 30) return setError('Keep it to 30 or fewer changing cells.')
    const goal = Number(target.trim())
    if (sense === 'value' && !Number.isFinite(goal)) return setError('Target value must be a number.')

    const parsed: SolverConstraintInput[] = []
    for (const row of constraints) {
      const hasAny = row.lhs.trim() || row.rhs.trim()
      if (!hasAny) continue // skip blank rows
      const lhs = parseRef(row.lhs.trim())
      if (!lhs) return setError(`Constraint left side "${row.lhs}" is not a valid cell.`)
      const rhs = parseRhs(row.rhs)
      if (!rhs) return setError(`Constraint right side "${row.rhs}" must be a number or a cell.`)
      parsed.push({ lhs: { row: lhs.row, col: lhs.col }, rel: row.rel, rhs })
    }

    setError(null)
    const res = wb.solve({
      objective: { row: obj.row, col: obj.col },
      sense,
      target: goal,
      variables: vars,
      nonNegative,
      constraints: parsed,
      sheetId,
    })
    if (res.status === 'error') return setError(res.message ?? 'The model could not be solved.')
    setResult(res)
  }

  const apply = () => {
    if (!result) return
    const entries = result.variables.map((v) => ({ coord: v.coord, raw: formatNumber(v.value) }))
    onApply(entries, result.variables[0]?.coord ?? { row: 0, col: 0 })
    onClose()
  }

  const statusLabel: Record<string, string> = {
    optimal: 'Optimal solution found',
    feasible: 'Feasible solution found',
    infeasible: 'No feasible solution',
    unbounded: 'Objective is unbounded',
    error: 'Could not solve',
  }

  const ok = result && (result.status === 'optimal' || result.status === 'feasible') && result.feasible

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal solver" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Solver</h3>
          <button className="modal-x" onClick={onClose}>
            ✕
          </button>
        </div>

        <p className="modal-hint">
          Optimize a model: find the changing cells that <strong>maximize</strong>, <strong>minimize</strong>, or
          drive the objective to a <strong>target</strong>, subject to constraints. A linear model is solved{' '}
          <em>exactly</em> with the simplex method; anything nonlinear falls back to a derivative-free search — all over
          real recalculations.
        </p>

        <div className="gs-grid">
          <label>Objective cell</label>
          <input className="name-in mono" value={objective} onChange={(e) => setObjective(e.target.value)} spellCheck={false} placeholder="B5" />

          <label>Goal</label>
          <div className="sv-sense">
            <label className="sv-radio">
              <input type="radio" checked={sense === 'max'} onChange={() => setSense('max')} /> Max
            </label>
            <label className="sv-radio">
              <input type="radio" checked={sense === 'min'} onChange={() => setSense('min')} /> Min
            </label>
            <label className="sv-radio">
              <input type="radio" checked={sense === 'value'} onChange={() => setSense('value')} /> Value
            </label>
            {sense === 'value' ? (
              <input className="name-in mono sv-target" value={target} onChange={(e) => setTarget(e.target.value)} spellCheck={false} placeholder="100" />
            ) : null}
          </div>

          <label>Changing cells</label>
          <input className="name-in mono" value={variables} onChange={(e) => setVariables(e.target.value)} spellCheck={false} placeholder="B2:B4" />
        </div>

        <div className="sv-constraints">
          <div className="sv-cons-head">
            <span>Constraints</span>
            <button className="btn ghost sv-add" onClick={addRow}>
              + Add
            </button>
          </div>
          {constraints.map((row, i) => (
            <div className="sv-cons-row" key={i}>
              <input
                className="name-in mono"
                value={row.lhs}
                onChange={(e) => setRow(i, { lhs: e.target.value })}
                spellCheck={false}
                placeholder="C2"
              />
              <select className="name-in mono sv-rel" value={row.rel} onChange={(e) => setRow(i, { rel: e.target.value as Relation })}>
                <option value="<=">≤</option>
                <option value="=">=</option>
                <option value=">=">≥</option>
              </select>
              <input
                className="name-in mono"
                value={row.rhs}
                onChange={(e) => setRow(i, { rhs: e.target.value })}
                onKeyDown={(e) => e.key === 'Enter' && run()}
                spellCheck={false}
                placeholder="10 or D2"
              />
              <button className="sv-del" title="Remove" onClick={() => removeRow(i)}>
                ✕
              </button>
            </div>
          ))}
          <label className="pv-check sv-nonneg">
            <input type="checkbox" checked={nonNegative} onChange={(e) => setNonNegative(e.target.checked)} />
            Make changing cells non-negative (≥ 0)
          </label>
        </div>

        {error ? <div className="name-error">{error}</div> : null}

        {result ? (
          <div className={'gs-result' + (ok ? '' : ' miss')}>
            <div>
              <strong>{statusLabel[result.status]}</strong>
              <span className="muted">
                {' '}
                · {result.method === 'simplex' ? 'simplex (exact)' : 'nonlinear search'} · {result.iterations} iters
              </span>
            </div>
            {ok ? (
              <>
                <div className="muted">
                  objective <span className="mono">{formatNumber(result.objective)}</span>
                </div>
                <div className="sv-vars">
                  {result.variables.map((v) => (
                    <span className="sv-var" key={`${v.coord.row},${v.coord.col}`}>
                      <button className="linkref" onClick={() => onGoto(v.coord)}>
                        {coordToA1(v.coord.row, v.coord.col)}
                      </button>
                      <span className="mono"> = {formatNumber(v.value)}</span>
                    </span>
                  ))}
                </div>
                {result.constraints.length ? (
                  <div className="sv-cons-report muted">
                    {result.constraints.map((c, i) => (
                      <span key={i} className={'sv-creport ' + (c.satisfied ? 'ok' : 'bad')}>
                        {c.satisfied ? '✓' : '✗'} {formatNumber(c.lhs)} {c.rel} {formatNumber(c.rhs)}
                      </span>
                    ))}
                  </div>
                ) : null}
              </>
            ) : (
              <div className="muted">
                {result.status === 'unbounded'
                  ? 'The objective can grow without limit — add a bounding constraint.'
                  : 'Try relaxing the constraints, adjusting bounds, or a different starting point.'}
              </div>
            )}
          </div>
        ) : null}

        <div className="gs-actions">
          <button className="btn" onClick={run}>
            Solve
          </button>
          <button className="btn primary" onClick={apply} disabled={!ok}>
            Keep solution
          </button>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
