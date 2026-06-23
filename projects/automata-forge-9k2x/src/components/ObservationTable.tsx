// The observation table — the beating heart of L*. Rows are access strings (the upper S block) and
// their one-symbol extensions (the lower S·Σ boundary block); columns are experiments E. Each cell
// is a membership bit. Rows are coloured by their *signature* (their bit-vector over E): rows that
// share a colour are, so far, the same state. A boundary row whose colour matches no S-row is a
// closedness defect — it is flagged, because it is about to be promoted into S.

import type { LearnEvent, TableSnapshot } from '../engine/learn/lstar'
import type { Sym } from '../engine/types'
import { showWord } from '../engine/types'
import './ObservationTable.css'

const wkey = (w: Sym[]): string => w.join('')

interface Props {
  table: TableSnapshot
  event: LearnEvent
}

export default function ObservationTable({ table, event }: Props) {
  // Derive what the latest step touched, so we can spotlight it.
  const promotedKey = event.kind === 'close' ? wkey(event.promoted) : null
  const addedRowKeys = new Set(
    event.kind === 'counterexample' && event.addedRows ? event.addedRows.map(wkey) : [],
  )
  let addedCol = -1
  if (event.kind === 'consistent') addedCol = indexOfWord(table.E, event.added)
  else if (event.kind === 'counterexample' && event.addedSuffix)
    addedCol = indexOfWord(table.E, event.addedSuffix)

  const sRows = table.rows.filter((r) => r.section === 'S')
  const bRows = table.rows.filter((r) => r.section === 'boundary')

  const renderRow = (r: (typeof table.rows)[number], key: string) => {
    const colorClass = r.classIndex >= 0 ? `obs-c${r.classIndex % 8}` : 'obs-defect'
    const k = wkey(r.row)
    const rowCls = [
      'obs-row',
      colorClass,
      k === promotedKey ? 'obs-promoted' : '',
      addedRowKeys.has(k) ? 'obs-added-row' : '',
    ]
      .filter(Boolean)
      .join(' ')
    return (
      <tr key={key} className={rowCls}>
        <th scope="row" className="obs-rowhead">
          <span className="obs-chip" aria-hidden />
          <code>{showWord(r.row)}</code>
          {r.classIndex < 0 && <span className="obs-flag" title="closedness defect — promoted to S">↑</span>}
        </th>
        {r.cells.map((c, i) => (
          <td key={i} className={`obs-cell${c ? ' yes' : ' no'}${i === addedCol ? ' obs-newcol' : ''}`}>
            {c ? '1' : '0'}
          </td>
        ))}
      </tr>
    )
  }

  return (
    <div className="obs-wrap">
      <table className="obs-table">
        <thead>
          <tr>
            <th className="obs-corner">
              T<span className="obs-corner-sub">S · E</span>
            </th>
            {table.E.map((e, i) => (
              <th key={i} className={`obs-exphead${i === addedCol ? ' obs-newcol' : ''}`}>
                <code>{showWord(e)}</code>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sRows.map((r, i) => renderRow(r, 'S' + i))}
          <tr className="obs-divider">
            <td colSpan={table.E.length + 1}>
              <span>S · Σ &nbsp;(boundary — where transitions land)</span>
            </td>
          </tr>
          {bRows.map((r, i) => renderRow(r, 'B' + i))}
        </tbody>
      </table>
    </div>
  )
}

function indexOfWord(words: Sym[][], target: Sym[]): number {
  const k = wkey(target)
  return words.findIndex((w) => wkey(w) === k)
}
