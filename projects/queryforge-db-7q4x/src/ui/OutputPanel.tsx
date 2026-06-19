// Renders the list of results from a run: tables for SELECT, status lines for
// DDL/DML, and a plan tree for EXPLAIN. Errors render with their phase.

import { useState } from 'react'
import { formatValue, type SqlValue } from '../db/types'
import { isTemporal } from '../db/temporal'
import { isDecimal } from '../db/decimal'
import { isJson } from '../db/json'
import { isTsVector, isTsQuery } from '../db/fts'
import { isArray } from '../db/array'
import type { QueryResult, RowsResult } from '../db/engine'
import type { RunError } from './useEngine'
import { PlanTree } from './PlanTree'
import { ChartView } from './Chart'

function Cell({ v }: { v: SqlValue }) {
  if (v === null) return <span className="cell-null">NULL</span>
  if (typeof v === 'boolean') return <span className="cell-bool">{v ? 'true' : 'false'}</span>
  if (typeof v === 'number') return <span className="cell-num">{formatValue(v)}</span>
  if (isDecimal(v)) return <span className="cell-num cell-decimal">{formatValue(v)}</span>
  if (isTemporal(v)) return <span className="cell-temporal">{formatValue(v)}</span>
  if (isJson(v)) return <span className="cell-json">{formatValue(v)}</span>
  if (isTsVector(v)) return <span className="cell-json cell-tsvector">{formatValue(v)}</span>
  if (isTsQuery(v)) return <span className="cell-json cell-tsquery">{formatValue(v)}</span>
  if (isArray(v)) return <span className="cell-json cell-array">{formatValue(v)}</span>
  return <span className="cell-text">{v}</span>
}

// RFC-4180-ish CSV: quote when a field contains a comma, quote, or newline.
function csvField(v: SqlValue): string {
  if (v === null) return ''
  const s =
    typeof v === 'boolean'
      ? v
        ? 'true'
        : 'false'
      : isTemporal(v) || isDecimal(v) || isJson(v) || isArray(v)
        ? formatValue(v)
        : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
function toCsv(res: RowsResult): string {
  const header = res.columns.map((c) => csvField(c.name)).join(',')
  const body = res.rows.map((r) => r.map(csvField).join(',')).join('\n')
  return res.rows.length ? `${header}\n${body}` : header
}

function CopyCsvButton({ res }: { res: RowsResult }) {
  const [done, setDone] = useState(false)
  const copy = () => {
    const csv = toCsv(res)
    const ok = () => {
      setDone(true)
      window.setTimeout(() => setDone(false), 1400)
    }
    try {
      navigator.clipboard?.writeText(csv).then(ok, ok)
    } catch {
      ok()
    }
  }
  return (
    <button className="btn ghost csv-btn" onClick={copy} title="Copy these rows as CSV">
      {done ? 'Copied ✓' : 'Copy CSV'}
    </button>
  )
}

function hasNumericColumn(res: RowsResult): boolean {
  return res.columns.some((c) => c.type === 'INTEGER' || c.type === 'REAL') && res.rows.length > 0
}

function RowsView({ res }: { res: RowsResult }) {
  const [mode, setMode] = useState<'table' | 'chart'>('table')
  const chartable = hasNumericColumn(res)
  return (
    <div className="result-block">
      {chartable && (
        <div className="view-switch">
          <button className={`view-tab ${mode === 'table' ? 'active' : ''}`} onClick={() => setMode('table')}>
            Table
          </button>
          <button className={`view-tab ${mode === 'chart' ? 'active' : ''}`} onClick={() => setMode('chart')}>
            Chart
          </button>
        </div>
      )}
      {mode === 'chart' && chartable ? <ChartView res={res} /> : <GridBody res={res} />}
    </div>
  )
}

function GridBody({ res }: { res: RowsResult }) {
  return (
    <>
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
        <span>
          {res.rowCount} row{res.rowCount === 1 ? '' : 's'} · {res.elapsedMs.toFixed(2)} ms
        </span>
        {res.rowCount > 0 && <CopyCsvButton res={res} />}
      </div>
    </>
  )
}

function ResultView({ res }: { res: QueryResult }) {
  if (res.kind === 'rows') return <RowsView res={res} />
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
