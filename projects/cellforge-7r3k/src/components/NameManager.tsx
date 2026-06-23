import { useState } from 'react'
import type { DefinedName, SheetMeta } from '../engine/workbook'
import { Workbook } from '../engine/workbook'

interface Props {
  names: DefinedName[]
  sheets: SheetMeta[]
  activeSheetId: string
  onAdd: (name: string, formula: string, scopeSheetId: string) => boolean
  onDelete: (name: string) => void
  onClose: () => void
}

/** Manage workbook-global defined names (e.g. `Tax = 0.0825`, `Sales = Sheet1!B2:B13`). */
export default function NameManager({ names, sheets, activeSheetId, onAdd, onDelete, onClose }: Props) {
  const [name, setName] = useState('')
  const [formula, setFormula] = useState('')
  const [scope, setScope] = useState(activeSheetId)
  const [error, setError] = useState<string | null>(null)

  const submit = () => {
    if (!Workbook.isValidName(name.trim())) {
      setError('Name must start with a letter and not look like a cell reference (e.g. A1).')
      return
    }
    if (formula.trim() === '') {
      setError('Give the name a definition, e.g. 0.0825 or Sheet1!A1:A10.')
      return
    }
    const ok = onAdd(name.trim(), formula.trim(), scope)
    if (!ok) {
      setError('Could not define that name.')
      return
    }
    setName('')
    setFormula('')
    setError(null)
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Named ranges</h3>
          <button className="modal-x" onClick={onClose}>
            ✕
          </button>
        </div>

        <p className="modal-hint">
          Names work anywhere a value or range is expected — in any sheet, even inside other names. Try{' '}
          <code>Tax = 0.0825</code> then <code>=Subtotal*(1+Tax)</code>.
        </p>

        <div className="name-table">
          <div className="name-row name-head">
            <span>Name</span>
            <span>Definition</span>
            <span>Scope</span>
            <span />
          </div>
          {names.length === 0 ? (
            <div className="name-empty">No names yet.</div>
          ) : (
            names.map((n) => (
              <div className="name-row" key={n.name}>
                <span className="mono">{n.name}</span>
                <span className={'mono' + (n.parseError ? ' err' : '')} title={n.parseError ?? undefined}>
                  ={n.formula}
                </span>
                <span className="muted">{sheets.find((s) => s.id === n.scopeSheetId)?.name ?? '—'}</span>
                <button className="name-del" title="Delete" onClick={() => onDelete(n.name)}>
                  ✕
                </button>
              </div>
            ))
          )}
        </div>

        <div className="name-form">
          <input className="name-in mono" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} />
          <input
            className="name-in mono wide"
            placeholder="Definition (e.g. Sheet1!A1:A10 or 42)"
            value={formula}
            onChange={(e) => setFormula(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            spellCheck={false}
          />
          <select className="name-in" value={scope} onChange={(e) => setScope(e.target.value)}>
            {sheets.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <button className="btn" onClick={submit}>
            Add / update
          </button>
        </div>
        {error ? <div className="name-error">{error}</div> : null}
      </div>
    </div>
  )
}
