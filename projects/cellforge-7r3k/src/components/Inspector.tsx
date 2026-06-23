import type { Coord } from '../engine/address'
import { coordToA1 } from '../engine/address'
import type { Workbook } from '../engine/workbook'
import { isError, isSparkline, isBlank } from '../engine/values'

interface Props {
  wb: Workbook
  active: Coord
  // `version` is read by the parent to force re-render; included so the panel
  // recomputes whenever the workbook mutates.
  version: number
}

function kindOf(wb: Workbook, c: Coord): string {
  if (wb.isFormula(c)) return 'formula'
  const v = wb.getValue(c)
  if (isBlank(v)) return 'empty'
  if (isError(v)) return 'error'
  if (isSparkline(v)) return 'sparkline'
  return typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'text'
}

/** Inspects the active cell: its input, computed value, type, and graph edges. */
export default function Inspector({ wb, active, version }: Props) {
  void version
  const a1 = coordToA1(active.row, active.col)
  const raw = wb.getRaw(active)
  const display = wb.getDisplay(active)
  const parseError = wb.parseErrorAt(active)
  const label = (rr: { sheetName: string; sameSheet: boolean; coord: { row: number; col: number } }) =>
    (rr.sameSheet ? '' : `${rr.sheetName}!`) + coordToA1(rr.coord.row, rr.coord.col)
  const precedents = wb.precedentsOf(active).map(label)
  const dependents = wb.dependentsOf(active).map(label)

  return (
    <div className="panel inspector">
      <div className="panel-head">
        <h3>Cell {a1}</h3>
        <span className="badge">{kindOf(wb, active)}</span>
      </div>

      <dl className="kv">
        <dt>Input</dt>
        <dd className="mono">{raw === '' ? <span className="muted">(empty)</span> : raw}</dd>
        <dt>Value</dt>
        <dd className="mono">{display === '' ? <span className="muted">—</span> : display}</dd>
        {parseError ? (
          <>
            <dt>Parse error</dt>
            <dd className="mono err">{parseError}</dd>
          </>
        ) : null}
      </dl>

      <div className="edges">
        <div>
          <h4>Precedents <span className="muted">({precedents.length})</span></h4>
          <div className="reflist">
            {precedents.length ? (
              precedents.slice(0, 60).map((r) => <span key={r} className="reftag in">{r}</span>)
            ) : (
              <span className="muted">none — this cell reads nothing</span>
            )}
            {precedents.length > 60 ? <span className="muted">+{precedents.length - 60} more</span> : null}
          </div>
        </div>
        <div>
          <h4>Dependents <span className="muted">({dependents.length})</span></h4>
          <div className="reflist">
            {dependents.length ? (
              dependents.slice(0, 60).map((r) => <span key={r} className="reftag out">{r}</span>)
            ) : (
              <span className="muted">none — nothing reads this cell</span>
            )}
            {dependents.length > 60 ? <span className="muted">+{dependents.length - 60} more</span> : null}
          </div>
        </div>
      </div>
    </div>
  )
}
