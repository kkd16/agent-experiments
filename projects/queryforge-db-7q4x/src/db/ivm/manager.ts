// The materialized-view manager — the catalog's bridge to the IVM engine.
//
// One `MatViewManager` lives on each `Database`. It owns the compiled
// `MaterializedView`s, indexes them by the base tables they read, and is poked
// by the catalog's three row-level mutators (insert / update / delete) so that
// *every* path that changes a base row — plain DML, UPSERT, MERGE, and even FK
// cascade chains, which all funnel through those mutators — maintains the views
// incrementally with no extra wiring.
//
// Snapshot/restore deliberately serializes only the view *definitions*: on
// restore the views are re-derived from the (already-restored) base tables, so
// there is no incremental state to keep consistent across a rollback. The hot
// path (a successful mutation) pays only the incremental maintenance; the cold
// path (a rollback or a reload) pays one full re-evaluation per view.

import { SqlError } from '../types'
import type { SelectStmt } from '../ast'
import type { Database, Row, Table } from '../catalog'
import { MaterializedView } from './dataflow'
import type { ZSetEntry } from './zset'

/** The serialized form stored in a database snapshot (definition only). */
export interface MatViewSerialized {
  name: string
  select: SelectStmt
}

/** A render-ready summary of one materialized view (for introspection / the UI). */
export interface MatViewInfo {
  name: string
  columns: string[]
  baseTables: string[]
  shape: string
  rowCount: number
  steps: number
  lastInserted: number
  lastDeleted: number
}

export class MatViewManager {
  private readonly db: Database
  private readonly views = new Map<string, MaterializedView>()
  /** Reverse index: base-table (lower) → set of view names that read it. */
  private readonly byTable = new Map<string, Set<string>>()
  /** When true, row events are ignored (used while (re)building views). */
  private suspended = false

  constructor(db: Database) {
    this.db = db
  }

  has(name: string): boolean {
    return this.views.has(name.toLowerCase())
  }
  get(name: string): MaterializedView | undefined {
    return this.views.get(name.toLowerCase())
  }
  list(): MaterializedView[] {
    return [...this.views.values()]
  }
  isEmpty(): boolean {
    return this.views.size === 0
  }

  /** Compile, validate and fully populate a new materialized view. The caller
   *  is responsible for rejecting name collisions with tables / plain views. */
  create(name: string, select: SelectStmt): MaterializedView {
    const lc = name.toLowerCase()
    if (this.views.has(lc)) throw new SqlError(`materialized view "${name}" already exists`, 'ddl')
    const view = MaterializedView.build(this.db, name, select)
    view.initialize(this.db)
    this.views.set(lc, view)
    this.index(view)
    return view
  }

  drop(name: string): void {
    const lc = name.toLowerCase()
    const view = this.views.get(lc)
    if (!view) return
    this.views.delete(lc)
    for (const t of view.baseTables) this.byTable.get(t)?.delete(lc)
  }

  /** Recompute a view from scratch (the `REFRESH MATERIALIZED VIEW` oracle). */
  refresh(name: string): void {
    const view = this.views.get(name.toLowerCase())
    if (!view) throw new SqlError(`materialized view "${name}" does not exist`, 'ddl')
    view.initialize(this.db)
  }

  private index(view: MaterializedView): void {
    for (const t of view.baseTables) {
      let s = this.byTable.get(t)
      if (!s) {
        s = new Set()
        this.byTable.set(t, s)
      }
      s.add(view.name.toLowerCase())
    }
  }

  /** Is `tableLower` read by at least one materialized view? (Guards DROP/ALTER.) */
  isBaseOfSomeView(tableLower: string): boolean {
    const s = this.byTable.get(tableLower)
    return !!s && s.size > 0
  }

  /** The materialized views that read `tableLower`. */
  dependentsOf(tableLower: string): MaterializedView[] {
    const s = this.byTable.get(tableLower)
    if (!s) return []
    const out: MaterializedView[] = []
    for (const n of s) {
      const v = this.views.get(n)
      if (v) out.push(v)
    }
    return out
  }

  // --- row events (called by the catalog's mutators) -----------------------

  onInsert(table: Table, row: Row): void {
    this.deliver(table.name.toLowerCase(), [{ row, weight: 1 }])
  }
  onDelete(table: Table, row: Row): void {
    this.deliver(table.name.toLowerCase(), [{ row, weight: -1 }])
  }
  onUpdate(table: Table, oldRow: Row, newRow: Row): void {
    this.deliver(table.name.toLowerCase(), [
      { row: oldRow, weight: -1 },
      { row: newRow, weight: 1 },
    ])
  }
  /** TRUNCATE clears a heap directly (bypassing per-row deletes); rebuild the
   *  dependents from scratch. */
  onTruncate(tableLower: string): void {
    if (this.suspended) return
    for (const v of this.dependentsOf(tableLower)) v.initialize(this.db)
  }

  private deliver(tableLower: string, delta: ZSetEntry[]): void {
    if (this.suspended) return
    const s = this.byTable.get(tableLower)
    if (!s || s.size === 0) return
    for (const n of s) {
      const v = this.views.get(n)
      if (v) v.applyChange(this.db, tableLower, delta)
    }
  }

  // --- snapshot / restore --------------------------------------------------

  serialize(): MatViewSerialized[] {
    return [...this.views.values()].map((v) => ({ name: v.name, select: v.select }))
  }

  /** Rebuild all views from serialized definitions against the current base
   *  tables. Used by `Database.restore`. Maintenance is suspended during the
   *  rebuild so a half-built manager never reacts to its own initialization. */
  rebuildFrom(defs: MatViewSerialized[]): void {
    this.views.clear()
    this.byTable.clear()
    this.suspended = true
    try {
      for (const d of defs) {
        const view = MaterializedView.build(this.db, d.name, d.select)
        view.initialize(this.db)
        this.views.set(d.name.toLowerCase(), view)
        this.index(view)
      }
    } finally {
      this.suspended = false
    }
  }

  info(): MatViewInfo[] {
    return [...this.views.values()]
      .map((v) => ({
        name: v.name,
        columns: v.outputColumns,
        baseTables: v.baseTables,
        shape: v.shapeLabel,
        rowCount: v.rowCount(),
        steps: v.stats.steps,
        lastInserted: v.stats.lastInserted,
        lastDeleted: v.stats.lastDeleted,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }
}
