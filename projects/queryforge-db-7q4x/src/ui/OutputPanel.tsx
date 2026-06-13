// Renders the list of results from a run: tables for SELECT, status lines for
// DDL/DML, and a plan tree for EXPLAIN. Errors render with their phase.

import { formatValue, type SqlValue } from '../db/types'
import type { QueryResult, RowsResult } from '../db/engine'
import type { RunError } from './useEngine'
import { PlanTree } from './PlanTree'

function Cell({ v }: { v: SqlValue }) {
  if (v === null) return <span className="cell-null">NULL</span>
  if (typeof v === 'boolean') return <span className="cell-bool">{v ? 'true' : 'false'}</span>
  if (typeof v === 'number') return <span className="cell-num">{formatValue(v)}</span>
  return <span className="cell-text">{v}</span>
}

function Grid({ res }: { res: RowsResult }) {
  return (
    <div className="result-block">
      <div className="grid-wrap">
        <table className="grid">
          <thead>
            <tr>
              <th className="grid-rownum">#</th>
              {res.columns.map((c, i) => (
                <th key={i}>
                  <span className="col-name">{c.name}</span>
                  <span className="col-type">{c.type}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {res.rows.map((row, r) => (
              <tr key={r}>
                <td className="grid-rownum">{r + 1}</td>
                {row.map((v, c) => (
                  <td key={c}>
                    <Cell v={v} />
                  </td>
                ))}
              </tr>
            ))}
            {res.rows.length === 0 && (
              <tr>
                <td className="grid-empty" colSpan={res.columns.length + 1}>
                  no rows
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="result-foot">
        {res.rowCount} row{res.rowCount === 1 ? '' : 's'} · {res.elapsedMs.toFixed(2)} ms
      </div>
    </div>
  )
}

function ResultView({ res }: { res: QueryResult }) {
  if (res.kind === 'rows') return <Grid res={res} />
  if (res.kind === 'message') {
    return (
      <div className="result-block">
        <div className="result-message">
          <span className="ok-dot" /> {res.message}
          <span className="result-foot inline">{res.elapsedMs.toFixed(2)} ms</span>
        </div>
      </div>
    )
  }
  // explain
  return (
    <div className="result-block">
      <div className="explain-head">
        Query plan {res.analyze ? '(ANALYZE — actually executed)' : '(estimated)'} · {res.elapsedMs.toFixed(2)} ms
      </div>
      <PlanTree plan={res.plan} analyze={res.analyze} />
    </div>
  )
}

export function OutputPanel({ results, error }: { results: QueryResult[]; error: RunError | null }) {
  if (error) {
    return (
      <div className="output">
        <div className="result-block">
          <div className="result-error">
            <span className="err-phase">{error.phase}</span>
            {error.message}
          </div>
        </div>
      </div>
    )
  }
  if (results.length === 0) {
    return (
      <div className="output output-empty">
        Run a query to see results. Try <kbd>⌘</kbd>/<kbd>Ctrl</kbd> + <kbd>Enter</kbd>.
      </div>
    )
  }
  return (
    <div className="output">
      {results.map((r, i) => (
        <ResultView key={i} res={r} />
      ))}
    </div>
  )
}
