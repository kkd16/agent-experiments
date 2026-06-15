import { useCallback, useState } from 'react'
import './App.css'
import { useEngine, type RunError } from './ui/useEngine'
import { useHashRoute } from './ui/useHashRoute'
import { Editor } from './ui/Editor'
import { OutputPanel } from './ui/OutputPanel'
import { SchemaPanel } from './ui/SchemaPanel'
import { TestsPanel } from './ui/TestsPanel'
import { Reference } from './ui/Reference'
import { Internals } from './ui/Internals'
import { CsvImport } from './ui/CsvImport'
import { SAMPLE_QUERIES } from './db/sampleData'
import type { QueryResult } from './db/engine'

const DEFAULT_QUERY = SAMPLE_QUERIES[0].sql

function loadLastQuery(): string {
  try {
    return localStorage.getItem('queryforge.query') ?? DEFAULT_QUERY
  } catch {
    return DEFAULT_QUERY
  }
}

const TABS = [
  { id: 'playground', label: 'Playground' },
  { id: 'import', label: 'Import CSV' },
  { id: 'reference', label: 'Reference' },
  { id: 'internals', label: 'Internals' },
  { id: 'tests', label: 'Self-tests' },
]

export default function App() {
  const { schema, views, run, reset } = useEngine()
  const [route, navigate] = useHashRoute()
  const [query, setQuery] = useState(loadLastQuery)
  const [results, setResults] = useState<QueryResult[]>([])
  const [error, setError] = useState<RunError | null>(null)
  const [ran, setRan] = useState(false)

  const setQueryPersisted = useCallback((v: string) => {
    setQuery(v)
    try {
      localStorage.setItem('queryforge.query', v)
    } catch {
      /* ignore */
    }
  }, [])

  const handleRun = useCallback(() => {
    const outcome = run(query)
    setResults(outcome.results)
    setError(outcome.error)
    setRan(true)
  }, [run, query])

  const insertText = useCallback(
    (text: string) => setQueryPersisted(query ? `${query.replace(/\s*$/, '')} ${text}` : text),
    [query, setQueryPersisted],
  )
  const loadSample = useCallback(
    (sql: string) => {
      setQueryPersisted(sql)
      navigate('playground')
    },
    [setQueryPersisted, navigate],
  )
  // Run an imported CSV's preview SELECT in the playground.
  const previewQuery = useCallback(
    (sql: string) => {
      setQueryPersisted(sql)
      const outcome = run(sql)
      setResults(outcome.results)
      setError(outcome.error)
      setRan(true)
      navigate('playground')
    },
    [run, setQueryPersisted, navigate],
  )

  const stmtCount = countStatements(query)

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">⌗</span>
          <div>
            <div className="brand-name">QueryForge</div>
            <div className="brand-sub">an in-browser SQL database engine</div>
          </div>
        </div>
        <nav className="tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`tab ${route === t.id ? 'active' : ''}`}
              onClick={() => navigate(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <button className="btn ghost reset" onClick={reset} title="Drop everything and reseed the sample data">
          Reset DB
        </button>
      </header>

      {route === 'playground' ? (
        <div className="layout">
          <SchemaPanel schema={schema} views={views} onInsert={insertText} onLoadSample={loadSample} />
          <main className="main">
            <div className="editor-bar">
              <span className="editor-label">SQL</span>
              <span className="editor-hint">
                {stmtCount} statement{stmtCount === 1 ? '' : 's'}
              </span>
              <button className="btn run" onClick={handleRun}>
                Run ▸ <span className="kbd-inline">⌘/Ctrl ↵</span>
              </button>
            </div>
            <Editor value={query} onChange={setQueryPersisted} onRun={handleRun} />
            <div className="output-bar">Results</div>
            <OutputPanel results={ran ? results : []} error={error} />
          </main>
        </div>
      ) : (
        <div className="doc-layout">
          {route === 'import' && <CsvImport onRun={run} onPreview={previewQuery} />}
          {route === 'reference' && <Reference />}
          {route === 'internals' && <Internals />}
          {route === 'tests' && <TestsPanel />}
        </div>
      )}

      <footer className="statusbar">
        <span>
          {schema.length} table{schema.length === 1 ? '' : 's'} ·{' '}
          {schema.reduce((n, t) => n + t.rowCount, 0)} rows ·{' '}
          {schema.reduce((n, t) => n + t.indexes.length, 0)} indexes
        </span>
        <span className="status-right">IndexScan · Hash/Merge Join · HashAggregate · Window frames · External Sort · stats · B+Tree</span>
      </footer>
    </div>
  )
}

function countStatements(sql: string): number {
  const stripped = sql
    .replace(/--[^\n]*/g, '')
    .replace(/'(?:[^']|'')*'/g, "''")
    .trim()
  if (!stripped) return 0
  const parts = stripped.split(';').map((s) => s.trim()).filter(Boolean)
  return Math.max(1, parts.length)
}
