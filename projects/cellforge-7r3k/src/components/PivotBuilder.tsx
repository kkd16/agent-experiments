import { useMemo, useState } from 'react'
import type { Workbook } from '../engine/workbook'
import type { Coord } from '../engine/address'
import { parseRef, coordToA1, colToLetters } from '../engine/address'

interface Props {
  wb: Workbook
  sheetId: string
  /** The selection when the dialog opened — the default source range. */
  initialRange: string
  /** A free cell below/right of the selection — the default output anchor. */
  initialAnchor: string
  onInsert: (anchor: Coord, formula: string) => void
  onClose: () => void
}

type Role = 'none' | 'row' | 'col' | 'value'
type Agg = 'SUM' | 'AVERAGE' | 'COUNT' | 'MIN' | 'MAX'

interface Field {
  col: number // absolute column index
  label: string
}

const AGGS: Agg[] = ['SUM', 'AVERAGE', 'COUNT', 'MIN', 'MAX']

/** A pivot-table builder. The user maps each source field to Rows / Columns / Values,
 *  and the dialog emits a single spilling GROUPBY / PIVOTBY formula — a *live* pivot
 *  that recomputes whenever the underlying data changes. */
export default function PivotBuilder({ wb, sheetId, initialRange, initialAnchor, onInsert, onClose }: Props) {
  const [rangeText, setRangeText] = useState(initialRange)
  const [hasHeader, setHasHeader] = useState(true)
  const [anchorText, setAnchorText] = useState(initialAnchor)
  const [agg, setAgg] = useState<Agg>('SUM')
  const [roles, setRoles] = useState<Record<number, Role>>({})
  const [error, setError] = useState<string | null>(null)

  // Parse "A1:D20" into a box and read the header row for field labels.
  const parsed = useMemo(() => {
    const m = /^\s*([A-Za-z]+\d+)\s*:\s*([A-Za-z]+\d+)\s*$/.exec(rangeText)
    if (!m) return null
    const a = parseRef(m[1])
    const b = parseRef(m[2])
    if (!a || !b) return null
    const top = Math.min(a.row, b.row)
    const bottom = Math.max(a.row, b.row)
    const left = Math.min(a.col, b.col)
    const right = Math.max(a.col, b.col)
    const dataTop = top + (hasHeader ? 1 : 0)
    if (dataTop > bottom) return null
    const fields: Field[] = []
    for (let c = left; c <= right; c++) {
      const label = hasHeader ? wb.getDisplay({ row: top, col: c }, sheetId) || colToLetters(c) : `Column ${colToLetters(c)}`
      fields.push({ col: c, label })
    }
    return { top, bottom, left, right, dataTop, fields }
  }, [rangeText, hasHeader, wb, sheetId])

  const setRole = (col: number, role: Role) => setRoles((r) => ({ ...r, [col]: role }))
  const roleOf = (col: number): Role => roles[col] ?? 'none'

  const build = (): { anchor: Coord; formula: string } | string => {
    if (!parsed) return 'Source range should look like A1:D20.'
    const anchor = parseRef(anchorText.trim())
    if (!anchor) return 'Output cell should be a reference like F1.'
    const rowCols = parsed.fields.filter((f) => roleOf(f.col) === 'row').map((f) => f.col)
    const colCols = parsed.fields.filter((f) => roleOf(f.col) === 'col').map((f) => f.col)
    const valCols = parsed.fields.filter((f) => roleOf(f.col) === 'value').map((f) => f.col)
    if (!rowCols.length) return 'Pick at least one Row field.'
    if (valCols.length !== 1) return 'Pick exactly one Value field.'
    if (colCols.length > 1) return 'A pivot supports a single Column field.'

    const colRange = (c: number) => `${coordToA1(parsed.dataTop, c)}:${coordToA1(parsed.bottom, c)}`
    const rowFieldsExpr = rowCols.length === 1 ? colRange(rowCols[0]) : `HSTACK(${rowCols.map(colRange).join(',')})`
    const valueExpr = colRange(valCols[0])

    const formula =
      colCols.length === 1
        ? `=PIVOTBY(${rowFieldsExpr},${colRange(colCols[0])},${valueExpr},${agg})`
        : `=GROUPBY(${rowFieldsExpr},${valueExpr},${agg})`
    return { anchor: { row: anchor.row, col: anchor.col }, formula }
  }

  const insert = () => {
    const res = build()
    if (typeof res === 'string') return setError(res)
    setError(null)
    onInsert(res.anchor, res.formula)
    onClose()
  }

  const preview = (() => {
    const res = build()
    return typeof res === 'string' ? null : res.formula
  })()

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal pivot" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Pivot Table</h3>
          <button className="modal-x" onClick={onClose}>
            ✕
          </button>
        </div>

        <p className="modal-hint">
          Summarize a table by grouping its rows. Map each field to <strong>Rows</strong>, an optional{' '}
          <strong>Columns</strong>, and one <strong>Values</strong> field. Cellforge writes a single spilling{' '}
          <code>GROUPBY</code>/<code>PIVOTBY</code> formula — a live pivot that recomputes as the data changes.
        </p>

        <div className="gs-grid">
          <label>Source range</label>
          <input className="name-in mono" value={rangeText} onChange={(e) => setRangeText(e.target.value)} spellCheck={false} placeholder="A1:D20" />
          <label>Header row</label>
          <label className="pv-check">
            <input type="checkbox" checked={hasHeader} onChange={(e) => setHasHeader(e.target.checked)} /> first row holds field names
          </label>
          <label>Aggregate</label>
          <select className="name-in" value={agg} onChange={(e) => setAgg(e.target.value as Agg)}>
            {AGGS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <label>Output cell</label>
          <input className="name-in mono" value={anchorText} onChange={(e) => setAnchorText(e.target.value)} spellCheck={false} placeholder="F1" />
        </div>

        {parsed ? (
          <div className="pv-fields">
            {parsed.fields.map((f) => (
              <div className="pv-field" key={f.col}>
                <span className="pv-name" title={f.label}>
                  {f.label}
                </span>
                <div className="pv-roles">
                  {(['none', 'row', 'col', 'value'] as Role[]).map((role) => (
                    <button
                      key={role}
                      className={'pv-role' + (roleOf(f.col) === role ? ' on' : '')}
                      onClick={() => setRole(f.col, role)}
                    >
                      {role === 'none' ? '—' : role === 'row' ? 'Rows' : role === 'col' ? 'Cols' : 'Values'}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="name-error">Enter a source range like A1:D20.</div>
        )}

        {preview ? <div className="pv-preview mono">{preview}</div> : null}
        {error ? <div className="name-error">{error}</div> : null}

        <div className="gs-actions">
          <button className="btn primary" onClick={insert}>
            Insert pivot
          </button>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
