// CSV import: paste or upload a CSV, infer a schema, and create + populate a
// table in one step — then jump to the playground to query it.

import { useRef, useState } from 'react'
import { csvToSql, type CsvImportResult } from '../db/csv'
import type { RunOutcome } from './useEngine'

interface Props {
  onRun: (sql: string) => RunOutcome
  onPreview: (sql: string) => void
}

const SAMPLE_CSV = `city,country,population,founded,coastal
Tokyo,Japan,37400068,1457,false
Delhi,India,32900000,1052,false
Shanghai,China,28500000,1291,true
Lagos,Nigeria,15400000,1860,true
Reykjavik,Iceland,131000,874,true`

export function CsvImport({ onRun, onPreview }: Props) {
  const [csv, setCsv] = useState('')
  const [tableName, setTableName] = useState('imported')
  const [hasHeader, setHasHeader] = useState(true)
  const [preview, setPreview] = useState<CsvImportResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ table: string; rows: number; previewSql: string } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const build = (): CsvImportResult | null => {
    setError(null)
    try {
      const result = csvToSql(csv, { tableName, hasHeader })
      setPreview(result)
      return result
    } catch (err) {
      setPreview(null)
      setError(err instanceof Error ? err.message : String(err))
      return null
    }
  }

  const doImport = () => {
    const result = preview ?? build()
    if (!result) return
    const outcome = onRun(result.sql)
    if (outcome.error) {
      setError(`${outcome.error.phase}: ${outcome.error.message}`)
      setDone(null)
      return
    }
    setError(null)
    setDone({ table: result.tableName, rows: result.rowCount, previewSql: result.previewSql })
  }

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const base = file.name.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_]+/g, '_') || 'imported'
    setTableName(base)
    const reader = new FileReader()
    reader.onload = () => {
      setCsv(String(reader.result ?? ''))
      setDone(null)
      setPreview(null)
    }
    reader.readAsText(file)
  }

  return (
    <div className="doc csv-import">
      <h1>Import CSV</h1>
      <p className="doc-lead">
        Paste a CSV or load a file. QueryForge infers each column’s type, then generates and runs a{' '}
        <code>CREATE TABLE</code> + bulk <code>INSERT</code> — the data lands in a real table you can query,
        index, join and chart.
      </p>

      <div className="csv-controls">
        <label className="csv-field">
          <span>Table name</span>
          <input value={tableName} onChange={(e) => setTableName(e.target.value)} spellCheck={false} />
        </label>
        <label className="csv-check">
          <input type="checkbox" checked={hasHeader} onChange={(e) => setHasHeader(e.target.checked)} />
          First row is a header
        </label>
        <input ref={fileRef} type="file" accept=".csv,text/csv,text/plain" onChange={onFile} hidden />
        <button className="btn ghost" onClick={() => fileRef.current?.click()}>
          Load file…
        </button>
        <button
          className="btn ghost"
          onClick={() => {
            setCsv(SAMPLE_CSV)
            setTableName('cities')
            setDone(null)
            setPreview(null)
          }}
        >
          Use sample
        </button>
      </div>

      <textarea
        className="csv-textarea"
        value={csv}
        onChange={(e) => {
          setCsv(e.target.value)
          setPreview(null)
          setDone(null)
        }}
        placeholder={'name,score\nAda,99\nGrace,97'}
        spellCheck={false}
      />

      <div className="csv-actions">
        <button className="btn ghost" onClick={build} disabled={!csv.trim()}>
          Infer schema
        </button>
        <button className="btn run" onClick={doImport} disabled={!csv.trim()}>
          Create table &amp; import ▸
        </button>
      </div>

      {error && <div className="result-error csv-msg"><span className="err-phase">import</span>{error}</div>}

      {preview && !done && (
        <div className="csv-preview">
          <h3>Inferred schema for “{preview.tableName}” ({preview.rowCount} rows)</h3>
          <div className="csv-schema">
            {preview.columns.map((c) => (
              <span key={c.name} className="csv-col">
                <span className="csv-col-name">{c.name}</span>
                <span className="schema-col-type">{c.type}</span>
              </span>
            ))}
          </div>
          <details className="csv-sql">
            <summary>Generated SQL</summary>
            <pre>{preview.sql.length > 4000 ? preview.sql.slice(0, 4000) + '\n… (truncated)' : preview.sql}</pre>
          </details>
        </div>
      )}

      {done && (
        <div className="csv-done">
          <div className="result-message">
            <span className="ok-dot" /> Imported {done.rows} row{done.rows === 1 ? '' : 's'} into{' '}
            <code>{done.table}</code>.
          </div>
          <button className="btn run" onClick={() => onPreview(done.previewSql)}>
            Query it in the playground ▸
          </button>
        </div>
      )}
    </div>
  )
}
