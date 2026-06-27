// The IVM Lab — watch incremental view maintenance happen.
//
// A materialized view stores a query's result; QueryForge keeps it correct *not*
// by recomputing the query when a base table changes, but by computing the
// *delta* to the view from the *delta* to the base — the DBSP / Z-set model
// (Budiu et al., VLDB 2023). This Lab makes that legible: you mutate the base
// tables a row at a time and watch each view update by just the rows that
// actually changed, while a live verdict re-runs the query from scratch and
// asserts the maintained contents are an identical multiset. The seventh sibling
// of the Optimizer / Execution / Vectorize / Compile / Concurrency / Recovery /
// Storage Labs.

import { useMemo, useRef, useState } from 'react'
import { Engine } from '../db/engine'
import { formatValue, type SqlValue } from '../db/types'
import type { Row } from '../db/catalog'
import { bagDiff } from '../db/ivm/zset'

interface ViewSpec {
  name: string
  /** The defining query (also the from-scratch recompute oracle). */
  query: string
  blurb: string
}

const VIEWS: ViewSpec[] = [
  {
    name: 'big_orders',
    query: 'SELECT id, cid, amt FROM ord WHERE amt >= 50',
    blurb: 'select–project: a filtered, projected slice of one table',
  },
  {
    name: 'by_region',
    query:
      'SELECT c.region, COUNT(*) AS orders, SUM(o.amt) AS revenue, MAX(o.amt) AS biggest ' +
      'FROM cust c JOIN ord o ON o.cid = c.cid GROUP BY c.region',
    blurb: 'join + group-by aggregate: revenue per region across a two-table join',
  },
]

const REGIONS = ['north', 'south', 'east', 'west']
const NAMES = ['Ada', 'Babbage', 'Codd', 'Dijkstra', 'Euler', 'Floyd', 'Gray', 'Hoare']

function seed(): Engine {
  const e = new Engine()
  e.execute('CREATE TABLE cust (cid INTEGER PRIMARY KEY, name TEXT, region TEXT)')
  e.execute('CREATE TABLE ord (id INTEGER PRIMARY KEY, cid INTEGER REFERENCES cust(cid) ON DELETE CASCADE, amt INTEGER)')
  for (let c = 1; c <= 4; c++) e.execute(`INSERT INTO cust VALUES (${c}, '${NAMES[c - 1]}', '${REGIONS[(c - 1) % REGIONS.length]}')`)
  e.execute('INSERT INTO ord VALUES (1,1,30),(2,1,80),(3,2,55),(4,3,12),(5,4,95),(6,2,40)')
  for (const v of VIEWS) e.execute(`CREATE MATERIALIZED VIEW ${v.name} AS ${v.query}`)
  return e
}

interface Grid {
  cols: string[]
  rows: Row[]
}

function readGrid(e: Engine, sql: string): Grid {
  const results = e.execute(sql)
  const last = results[results.length - 1]
  if (!last || last.kind !== 'rows') return { cols: [], rows: [] }
  return { cols: last.columns.map((c) => c.name), rows: last.rows }
}

function rowKey(r: Row): string {
  return r.map((v) => formatValue(v)).join('')
}

interface StepDelta {
  view: string
  added: Row[]
  removed: Row[]
  steps: number
  ok: boolean
}

interface LogEntry {
  sql: string
  label: string
  deltas: StepDelta[]
}

function Cell({ v }: { v: SqlValue }) {
  return <td className={v === null ? 'ivm-null' : ''}>{v === null ? 'NULL' : formatValue(v)}</td>
}

function DataGrid({ grid, highlight }: { grid: Grid; highlight?: Set<string> }) {
  if (grid.cols.length === 0) return <div className="ivm-empty">— empty —</div>
  return (
    <table className="ivm-grid">
      <thead>
        <tr>
          {grid.cols.map((c) => (
            <th key={c}>{c}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {grid.rows.map((r, i) => (
          <tr key={i} className={highlight?.has(rowKey(r)) ? 'ivm-row-new' : ''}>
            {r.map((v, j) => (
              <Cell key={j} v={v} />
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function IvmLab() {
  const engineRef = useRef<Engine | null>(null)
  if (engineRef.current === null) engineRef.current = seed()
  const [version, setVersion] = useState(0)
  const [log, setLog] = useState<LogEntry[]>([])
  const [nextOrd, setNextOrd] = useState(7)
  const [nextCust, setNextCust] = useState(5)

  const engine = engineRef.current

  // Re-read everything on each version bump.
  const view = useMemo(() => {
    void version
    const e = engine
    const cust = readGrid(e, 'SELECT cid, name, region FROM cust ORDER BY cid')
    const ord = readGrid(e, 'SELECT id, cid, amt FROM ord ORDER BY id')
    const info = e.db.matviews.info()
    const views = VIEWS.map((spec) => {
      const stored = readGrid(e, `SELECT * FROM ${spec.name}`)
      const recomputed = readGrid(e, spec.query)
      const diff = bagDiff(stored.rows, recomputed.rows)
      const meta = info.find((m) => m.name.toLowerCase() === spec.name.toLowerCase())
      return { spec, stored, ok: diff.onlyA === 0 && diff.onlyB === 0, meta }
    })
    return { cust, ord, views }
  }, [engine, version])

  // The set of view rows added by the most recent step (to flash them).
  const lastAdded = useMemo(() => {
    const m = new Map<string, Set<string>>()
    const entry = log[0]
    if (entry) for (const d of entry.deltas) m.set(d.view, new Set(d.added.map(rowKey)))
    return m
  }, [log])

  function apply(sql: string, label: string) {
    const e = engine
    // Snapshot each view's contents + maintenance counter before the mutation.
    const before = VIEWS.map((v) => ({
      name: v.name,
      rows: readGrid(e, `SELECT * FROM ${v.name}`).rows,
      steps: e.db.matviews.get(v.name)?.stats.steps ?? 0,
    }))
    try {
      e.execute(sql)
    } catch (err) {
      setLog((l) => [{ sql, label: `${label} — error: ${err instanceof Error ? err.message : String(err)}`, deltas: [] }, ...l].slice(0, 8))
      setVersion((v) => v + 1)
      return
    }
    const deltas: StepDelta[] = VIEWS.map((v) => {
      const b = before.find((x) => x.name === v.name)!
      const afterRows = readGrid(e, `SELECT * FROM ${v.name}`).rows
      const recomputed = readGrid(e, v.query).rows
      const beforeCount = new Map<string, number>()
      for (const r of b.rows) beforeCount.set(rowKey(r), (beforeCount.get(rowKey(r)) ?? 0) + 1)
      const afterCount = new Map<string, number>()
      for (const r of afterRows) afterCount.set(rowKey(r), (afterCount.get(rowKey(r)) ?? 0) + 1)
      const added: Row[] = []
      const removed: Row[] = []
      const seen = new Set<string>()
      const consider = (r: Row) => {
        const k = rowKey(r)
        if (seen.has(k)) return
        seen.add(k)
        const d = (afterCount.get(k) ?? 0) - (beforeCount.get(k) ?? 0)
        for (let i = 0; i < d; i++) added.push(r)
        for (let i = 0; i < -d; i++) removed.push(r)
      }
      for (const r of afterRows) consider(r)
      for (const r of b.rows) consider(r)
      const diff = bagDiff(afterRows, recomputed)
      return {
        view: v.name,
        added,
        removed,
        steps: (e.db.matviews.get(v.name)?.stats.steps ?? 0) - b.steps,
        ok: diff.onlyA === 0 && diff.onlyB === 0,
      }
    })
    setLog((l) => [{ sql, label, deltas }, ...l].slice(0, 8))
    setVersion((v) => v + 1)
  }

  function ri(lo: number, hi: number): number {
    return lo + Math.floor(Math.random() * (hi - lo + 1))
  }
  function liveOrderIds(): number[] {
    return readGrid(engine, 'SELECT id FROM ord ORDER BY id').rows.map((r) => r[0] as number)
  }
  function liveCustIds(): number[] {
    return readGrid(engine, 'SELECT cid FROM cust ORDER BY cid').rows.map((r) => r[0] as number)
  }

  const addOrder = (big: boolean) => {
    const custs = liveCustIds()
    if (custs.length === 0) return
    const id = nextOrd
    setNextOrd((n) => n + 1)
    const cid = custs[ri(0, custs.length - 1)]
    const amt = big ? ri(80, 130) : ri(5, 60)
    apply(`INSERT INTO ord VALUES (${id}, ${cid}, ${amt})`, big ? `Add a big order (#${id}, $${amt})` : `Add an order (#${id}, $${amt})`)
  }
  const deleteOrder = () => {
    const ids = liveOrderIds()
    if (ids.length === 0) return
    const id = ids[ri(0, ids.length - 1)]
    apply(`DELETE FROM ord WHERE id = ${id}`, `Delete order #${id}`)
  }
  const updateOrder = () => {
    const ids = liveOrderIds()
    if (ids.length === 0) return
    const id = ids[ri(0, ids.length - 1)]
    const amt = ri(5, 130)
    apply(`UPDATE ord SET amt = ${amt} WHERE id = ${id}`, `Change order #${id} → $${amt}`)
  }
  const moveCustomer = () => {
    const ids = liveCustIds()
    if (ids.length === 0) return
    const cid = ids[ri(0, ids.length - 1)]
    const region = REGIONS[ri(0, REGIONS.length - 1)]
    apply(`UPDATE cust SET region = '${region}' WHERE cid = ${cid}`, `Move customer #${cid} → ${region}`)
  }
  const addCustomer = () => {
    const cid = nextCust
    setNextCust((n) => n + 1)
    const region = REGIONS[ri(0, REGIONS.length - 1)]
    apply(`INSERT INTO cust VALUES (${cid}, '${NAMES[(cid - 1) % NAMES.length]}', '${region}')`, `Add customer #${cid} (${region})`)
  }
  const reset = () => {
    engineRef.current = seed()
    setNextOrd(7)
    setNextCust(5)
    setLog([])
    setVersion((v) => v + 1)
  }

  const allOk = view.views.every((v) => v.ok)

  return (
    <div className="lab ivm-lab">
      <div className="lab-head">
        <h2>IVM Lab — incremental view maintenance</h2>
        <p className="lab-sub">
          A <em>materialized view</em> stores a query's result. Change a base table and watch each view update by just the{' '}
          <em>delta</em> — never a full recompute — using the DBSP / Z-set model. A live oracle re-runs each query from scratch
          and proves the maintained contents are <strong>byte-for-byte identical</strong>.
        </p>
      </div>

      <div className={`ivm-verdict ${allOk ? 'ok' : 'bad'}`}>
        {allOk ? '✓ every materialized view matches a from-scratch recompute' : '✗ a view diverged from its recompute (bug!)'}
      </div>

      <div className="ivm-controls">
        <button onClick={() => addOrder(false)}>+ order</button>
        <button onClick={() => addOrder(true)}>+ big order (≥ $80)</button>
        <button onClick={updateOrder}>~ change an amount</button>
        <button onClick={deleteOrder}>− delete an order</button>
        <button onClick={moveCustomer}>↔ move a customer's region</button>
        <button onClick={addCustomer}>+ customer</button>
        <button className="ivm-reset" onClick={reset}>
          reset
        </button>
      </div>

      <div className="ivm-cols">
        <div className="ivm-base">
          <h3>Base tables</h3>
          <div className="ivm-sub-title">cust</div>
          <DataGrid grid={view.cust} />
          <div className="ivm-sub-title">ord</div>
          <DataGrid grid={view.ord} />
        </div>

        <div className="ivm-views">
          <h3>Materialized views</h3>
          {view.views.map((v) => (
            <div className="ivm-view-card" key={v.spec.name}>
              <div className="ivm-view-head">
                <span className="ivm-view-name">{v.spec.name}</span>
                <span className={`ivm-pill ${v.ok ? 'ok' : 'bad'}`}>{v.ok ? '✓ matches recompute' : '✗ diverged'}</span>
              </div>
              <div className="ivm-view-blurb">{v.spec.blurb}</div>
              <code className="ivm-view-sql">{v.spec.query}</code>
              <DataGrid grid={v.stored} highlight={lastAdded.get(v.spec.name)} />
              {v.meta && (
                <div className="ivm-view-stats">
                  {v.meta.rowCount} row{v.meta.rowCount === 1 ? '' : 's'} · {v.meta.steps} maintenance step
                  {v.meta.steps === 1 ? '' : 's'}
                  {v.meta.steps > 0 && (
                    <>
                      {' '}
                      · last Δ <span className="ivm-plus">+{v.meta.lastInserted}</span>/
                      <span className="ivm-minus">−{v.meta.lastDeleted}</span>
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="ivm-log">
        <h3>Maintenance log</h3>
        {log.length === 0 && <div className="ivm-empty">Mutate a base table above — each view will update incrementally.</div>}
        {log.map((entry, i) => (
          <div className="ivm-log-entry" key={i}>
            <div className="ivm-log-label">{entry.label}</div>
            <code className="ivm-log-sql">{entry.sql}</code>
            <div className="ivm-log-deltas">
              {entry.deltas.map((d) => (
                <span key={d.view} className="ivm-log-delta">
                  <span className="ivm-log-view">{d.view}</span>
                  {d.added.length === 0 && d.removed.length === 0 ? (
                    <span className="ivm-log-none">no change</span>
                  ) : (
                    <>
                      {d.added.length > 0 && <span className="ivm-plus">+{d.added.length}</span>}
                      {d.removed.length > 0 && <span className="ivm-minus">−{d.removed.length}</span>}
                    </>
                  )}
                  {!d.ok && <span className="ivm-log-bad">DIVERGED</span>}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
