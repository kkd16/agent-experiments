import { useState } from 'react'
import type { TableDef, SheetMeta } from '../engine/workbook'
import { Workbook } from '../engine/workbook'
import { coordToA1 } from '../engine/address'

interface Props {
  tables: TableDef[]
  sheets: SheetMeta[]
  /** A1 range of the current selection — the default region for a new table. */
  initialRange: string
  onDefine: (name: string, range: string) => boolean
  onDelete: (name: string) => void
  onGoto: (range: string) => void
  onClose: () => void
}

const regionA1 = (t: TableDef): string => `${coordToA1(t.region.top, t.region.left)}:${coordToA1(t.region.bottom, t.region.right)}`

/** Manage structured tables — named rectangular regions whose first row is the header.
 *  Once defined, formulas can reference columns by name: `=SUM(Sales[Amount])`,
 *  `Sales[#Headers]`, `Sales[@Region]` (this-row). */
export default function TableManager({ tables, sheets, initialRange, onDefine, onDelete, onGoto, onClose }: Props) {
  const [name, setName] = useState('')
  const [range, setRange] = useState(initialRange)
  const [error, setError] = useState<string | null>(null)

  const submit = () => {
    if (!Workbook.isValidName(name.trim())) {
      setError('Table name must start with a letter and not look like a cell reference.')
      return
    }
    if (!/^[A-Za-z]+\d+\s*:\s*[A-Za-z]+\d+$/.test(range.trim())) {
      setError('Region should be a range like A1:D20 (its first row is the header).')
      return
    }
    if (!onDefine(name.trim(), range.trim())) {
      setError('Could not define that table (name may clash with a defined name).')
      return
    }
    setName('')
    setError(null)
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Structured tables</h3>
          <button className="modal-x" onClick={onClose}>
            ✕
          </button>
        </div>

        <p className="modal-hint">
          A table is a named region whose first row holds the column headers. Reference columns by name from anywhere:{' '}
          <code>=SUM(Sales[Amount])</code>, <code>Sales[#Headers]</code>, or <code>Sales[@Region]</code> for this row.
        </p>

        <div className="name-table">
          <div className="name-row tbl-row name-head">
            <span>Name</span>
            <span>Region</span>
            <span>Sheet</span>
            <span />
          </div>
          {tables.length === 0 ? (
            <div className="name-empty">No tables yet — select a range with headers, then add one below.</div>
          ) : (
            tables.map((t) => (
              <div className="name-row tbl-row" key={t.name}>
                <span className="mono">{t.name}</span>
                <button className="linkref" onClick={() => onGoto(regionA1(t))}>
                  {regionA1(t)}
                </button>
                <span className="muted">{sheets.find((s) => s.id === t.sheetId)?.name ?? '—'}</span>
                <button className="name-del" title="Delete" onClick={() => onDelete(t.name)}>
                  ✕
                </button>
              </div>
            ))
          )}
        </div>

        <div className="name-form">
          <input className="name-in mono" placeholder="Table name" value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} />
          <input
            className="name-in mono wide"
            placeholder="Region (e.g. A1:D20)"
            value={range}
            onChange={(e) => setRange(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            spellCheck={false}
          />
          <button className="btn" onClick={submit}>
            Define table
          </button>
        </div>
        {error ? <div className="name-error">{error}</div> : null}
      </div>
    </div>
  )
}
