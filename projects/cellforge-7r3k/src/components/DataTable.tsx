import { useState } from 'react'
import type { Workbook } from '../engine/workbook'
import type { Coord } from '../engine/address'
import { parseRef, coordToA1 } from '../engine/address'

interface Props {
  wb: Workbook
  sheetId: string
  initialFormula: string
  initialAnchor: string
  onApply: (entries: Array<{ coord: Coord; raw: string }>) => void
  onClose: () => void
}

/** Parse "A2:A12" and return the raw strings of every cell, row-major. */
function rangeRaws(wb: Workbook, sheetId: string, text: string): string[] | null {
  const m = /^\s*([A-Za-z]+\d+)\s*:\s*([A-Za-z]+\d+)\s*$/.exec(text)
  if (!m) return null
  const a = parseRef(m[1])
  const b = parseRef(m[2])
  if (!a || !b) return null
  const top = Math.min(a.row, b.row)
  const bottom = Math.max(a.row, b.row)
  const left = Math.min(a.col, b.col)
  const right = Math.max(a.col, b.col)
  const out: string[] = []
  for (let r = top; r <= bottom; r++) for (let c = left; c <= right; c++) out.push(wb.getRaw({ row: r, col: c }, sheetId))
  return out
}

/** A one- or two-variable Data Table (sensitivity analysis). For every substituted
 *  input value the model recalculates and the formula's result is captured into a
 *  materialized grid — the classic "what happens to profit as price and volume vary"
 *  table, computed over real recalcs by the engine. */
export default function DataTableDialog({ wb, sheetId, initialFormula, initialAnchor, onApply, onClose }: Props) {
  const [formulaRef, setFormulaRef] = useState(initialFormula)
  const [colInput, setColInput] = useState('')
  const [colVals, setColVals] = useState('')
  const [rowInput, setRowInput] = useState('')
  const [rowVals, setRowVals] = useState('')
  const [anchorText, setAnchorText] = useState(initialAnchor)
  const [error, setError] = useState<string | null>(null)

  const run = () => {
    const formula = parseRef(formulaRef.trim())
    const anchor = parseRef(anchorText.trim())
    const cInput = parseRef(colInput.trim())
    const rInput = rowInput.trim() ? parseRef(rowInput.trim()) : null
    if (!formula) return setError('Formula cell should be a reference like B10.')
    if (!anchor) return setError('Output cell should be a reference like A20.')
    if (!cInput) return setError('Column input cell is required (e.g. B1).')
    if (rowInput.trim() && !rInput) return setError('Row input cell looks invalid.')

    const cValues = rangeRaws(wb, sheetId, colVals)
    if (!cValues || !cValues.length) return setError('Column values should be a range like A2:A12.')
    let rValues: string[] = []
    if (rInput) {
      const rv = rangeRaws(wb, sheetId, rowVals)
      if (!rv || !rv.length) return setError('With a row input cell, give a row-values range too.')
      rValues = rv
    }
    if (cValues.length * Math.max(1, rValues.length) > 5000) return setError('That table is too large — keep it under 5000 cells.')
    setError(null)

    const grid = wb.computeDataTable(
      { row: formula.row, col: formula.col },
      { row: cInput.row, col: cInput.col },
      cValues,
      rInput ? { row: rInput.row, col: rInput.col } : null,
      rValues,
      sheetId,
    )

    const entries: Array<{ coord: Coord; raw: string }> = []
    const a0 = { row: anchor.row, col: anchor.col }
    if (rInput) {
      // Two-variable: corner shows the live model value, headers down the top + left.
      entries.push({ coord: a0, raw: '=' + coordToA1(formula.row, formula.col) })
      rValues.forEach((rv, j) => entries.push({ coord: { row: a0.row, col: a0.col + 1 + j }, raw: rv }))
      cValues.forEach((cv, i) => entries.push({ coord: { row: a0.row + 1 + i, col: a0.col }, raw: cv }))
      grid.forEach((line, i) =>
        line.forEach((res, j) => entries.push({ coord: { row: a0.row + 1 + i, col: a0.col + 1 + j }, raw: res })),
      )
    } else {
      // One-variable: a labeled two-column block (input → result).
      entries.push({ coord: a0, raw: 'Input' })
      entries.push({ coord: { row: a0.row, col: a0.col + 1 }, raw: 'Result' })
      cValues.forEach((cv, i) => {
        entries.push({ coord: { row: a0.row + 1 + i, col: a0.col }, raw: cv })
        entries.push({ coord: { row: a0.row + 1 + i, col: a0.col + 1 }, raw: grid[i][0] })
      })
    }
    onApply(entries)
    onClose()
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal datatable" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Data Table</h3>
          <button className="modal-x" onClick={onClose}>
            ✕
          </button>
        </div>

        <p className="modal-hint">
          See how a result responds as one or two inputs vary. Cellforge substitutes each value into the input cell(s),
          recalculates the whole model, and lays the answers out as a grid. Leave the row input blank for a simple
          one-variable table.
        </p>

        <div className="gs-grid">
          <label>Formula cell</label>
          <input className="name-in mono" value={formulaRef} onChange={(e) => setFormulaRef(e.target.value)} spellCheck={false} placeholder="B10" />
          <label>Column input cell</label>
          <input className="name-in mono" value={colInput} onChange={(e) => setColInput(e.target.value)} spellCheck={false} placeholder="B1" />
          <label>Column values</label>
          <input className="name-in mono" value={colVals} onChange={(e) => setColVals(e.target.value)} spellCheck={false} placeholder="A2:A12" />
          <label>Row input cell</label>
          <input className="name-in mono" value={rowInput} onChange={(e) => setRowInput(e.target.value)} spellCheck={false} placeholder="(optional) B2" />
          <label>Row values</label>
          <input className="name-in mono" value={rowVals} onChange={(e) => setRowVals(e.target.value)} spellCheck={false} placeholder="(optional) C1:G1" />
          <label>Output cell</label>
          <input className="name-in mono" value={anchorText} onChange={(e) => setAnchorText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && run()} spellCheck={false} placeholder="A20" />
        </div>

        {error ? <div className="name-error">{error}</div> : null}

        <div className="gs-actions">
          <button className="btn primary" onClick={run}>
            Build table
          </button>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
