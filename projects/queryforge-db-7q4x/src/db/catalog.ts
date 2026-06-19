// The catalog: tables, their columns, heap storage and secondary indexes.
//
// A Table stores rows in a "heap" keyed by a monotonically increasing rowid
// (the physical address), plus zero or more B+Tree indexes over one *or more*
// columns. This mirrors how a real row-store works: the heap is the source of
// truth, indexes are derived structures the planner may exploit.
//
// Each table also caches optimizer statistics (see ./stats); the cache is
// dropped on any mutation so the next plan sees fresh numbers.
//
// Declarative integrity lives here too: per-row constraints (NOT NULL, CHECK,
// UNIQUE) are enforced by the Table; cross-table referential integrity (FOREIGN
// KEY with ON DELETE/UPDATE actions) is orchestrated by the Database, which owns
// every table and so can cascade across them.

import { BTree, type BTreeStats, type IndexKey } from './storage/btree'
import { gatherTableStats, type TableStat } from './stats'
import { compileExpr, type CompileCtx, type Evaluator } from './eval'
import { SqlError, coerceTo, formatValue, valuesEqual, type ColumnType, type SqlValue } from './types'
import { isTsVector, asTsVector, type GinPostings } from './fts'
import {
  emptyConstraints,
  type CheckConstraint,
  type ColumnDef,
  type ColumnExpr,
  type Expr,
  type ForeignKeyDef,
  type RefAction,
  type SelectStmt,
  type TableConstraints,
} from './ast'

export type Row = SqlValue[]

/** A view: a named query the planner inlines wherever the view name appears.
 *  `select` is a plain-object AST, so it serializes to localStorage untouched. */
export interface ViewDef {
  name: string
  /** Optional output column names. */
  columns?: string[]
  select: SelectStmt
}

export interface IndexMeta {
  name: string
  /** The indexed columns, in order (length 1 for a single-column index). */
  columns: string[]
  /** Positional indexes of `columns` within the table's row. */
  columnIndexes: number[]
  unique: boolean
}

export class IndexHandle {
  readonly meta: IndexMeta
  readonly tree: BTree
  constructor(meta: IndexMeta, tree: BTree) {
    this.meta = meta
    this.tree = tree
  }
  stats(): BTreeStats {
    return this.tree.stats()
  }
  /** Build this index's key tuple from a heap row. */
  keyOf(row: Row): IndexKey {
    return this.meta.columnIndexes.map((i) => row[i])
  }
}

/**
 * A GIN (Generalized INverted) index over a single `tsvector` column: an
 * inverted map from each lexeme to the set of rowids whose document contains it.
 * This is what makes `col @@ query` sublinear — the planner walks the query to a
 * small candidate rowset instead of scanning the whole heap.
 */
export class GinIndexHandle implements GinPostings {
  readonly name: string
  readonly column: string
  readonly columnIndex: number
  /** lexeme -> set of rowids containing it. */
  private readonly postings = new Map<string, Set<number>>()

  constructor(name: string, column: string, columnIndex: number) {
    this.name = name
    this.column = column
    this.columnIndex = columnIndex
  }

  /** The distinct lexemes in a row's indexed cell (or [] if not a tsvector). */
  private lexemesOf(row: Row): string[] {
    const cell = row[this.columnIndex]
    if (cell === null || cell === undefined) return []
    const vec = isTsVector(cell) ? cell : asTsVector(cell)
    return vec ? vec.lex.map((l) => l.word) : []
  }

  addRow(rowid: number, row: Row): void {
    for (const word of this.lexemesOf(row)) {
      let s = this.postings.get(word)
      if (!s) { s = new Set(); this.postings.set(word, s) }
      s.add(rowid)
    }
  }
  removeRow(rowid: number, row: Row): void {
    for (const word of this.lexemesOf(row)) {
      const s = this.postings.get(word)
      if (s) { s.delete(rowid); if (s.size === 0) this.postings.delete(word) }
    }
  }

  // --- GinPostings (read side, used by the planner / GinScan) --------------
  exact(word: string): Set<number> | undefined {
    return this.postings.get(word)
  }
  prefix(word: string): Set<number> {
    const out = new Set<number>()
    for (const [lex, ids] of this.postings) if (lex.startsWith(word)) for (const id of ids) out.add(id)
    return out
  }

  /** Distinct-lexeme cardinality — a rough sizing signal for the planner. */
  get lexemeCount(): number {
    return this.postings.size
  }
}

/** A compiled CHECK constraint: its source plus an evaluator over a row. */
interface CompiledCheck {
  def: CheckConstraint
  fn: Evaluator
}

export class Table {
  /** Mutable to support `ALTER TABLE … RENAME`. */
  name: string
  /** Mutable to support `ALTER TABLE … ADD/DROP/RENAME COLUMN`. */
  columns: ColumnDef[]
  /** Declarative constraints (PK / UNIQUE / CHECK / FK), normalized at create. */
  readonly constraints: TableConstraints
  /** rowid -> row. A Map preserves insertion order for stable scans. */
  readonly heap = new Map<number, Row>()
  /** index name (lower-case) -> handle. */
  readonly indexes = new Map<string, IndexHandle>()
  /** GIN index name (lower-case) -> inverted index over a tsvector column. */
  readonly ginIndexes = new Map<string, GinIndexHandle>()
  /** Cached optimizer statistics (null = stale / not yet gathered). */
  private statsCache: TableStat | null = null
  /** Lazily-compiled CHECK evaluators (null = not yet compiled). */
  private checkCache: CompiledCheck[] | null = null
  private nextRowId = 1

  constructor(name: string, columns: ColumnDef[], constraints: TableConstraints = emptyConstraints()) {
    this.name = name
    this.columns = columns
    this.constraints = constraints
  }

  columnIndex(name: string): number {
    return this.columns.findIndex((c) => c.name.toLowerCase() === name.toLowerCase())
  }
  columnType(name: string): ColumnType {
    const i = this.columnIndex(name)
    if (i < 0) throw new SqlError(`no column "${name}" in table "${this.name}"`, 'bind')
    return this.columns[i].type
  }
  requireColumnIndex(name: string): number {
    const i = this.columnIndex(name)
    if (i < 0) throw new SqlError(`no column "${name}" in table "${this.name}"`, 'bind')
    return i
  }

  rowCount(): number {
    return this.heap.size
  }

  // --- mutation -----------------------------------------------------------
  insertRow(row: Row): number {
    this.validateRow(row)
    this.checkUnique(row, null)
    const rowid = this.nextRowId++
    this.heap.set(rowid, row)
    for (const idx of this.indexes.values()) idx.tree.insert(idx.keyOf(row), rowid)
    for (const g of this.ginIndexes.values()) g.addRow(rowid, row)
    this.statsCache = null
    return rowid
  }

  /** Insert a row verbatim (no coercion / constraint checks). Used for
   *  transient relations materialized from query results, and snapshot restore
   *  (the data was already valid when it was snapshotted). */
  insertRawRow(row: Row): number {
    const rowid = this.nextRowId++
    this.heap.set(rowid, row)
    for (const idx of this.indexes.values()) idx.tree.insert(idx.keyOf(row), rowid)
    for (const g of this.ginIndexes.values()) g.addRow(rowid, row)
    this.statsCache = null
    return rowid
  }

  deleteRow(rowid: number): void {
    const row = this.heap.get(rowid)
    if (!row) return
    for (const idx of this.indexes.values()) idx.tree.remove(idx.keyOf(row), rowid)
    for (const g of this.ginIndexes.values()) g.removeRow(rowid, row)
    this.heap.delete(rowid)
    this.statsCache = null
  }

  /** Empty the heap and every index in one shot (TRUNCATE). With
   *  `restartIdentity` the rowid counter resets to 1; otherwise it continues. */
  truncate(restartIdentity: boolean): void {
    const idxMetas = [...this.indexes.values()].map((h) => ({ name: h.meta.name, columns: h.meta.columns.slice(), unique: h.meta.unique }))
    const ginMetas = [...this.ginIndexes.values()].map((g) => ({ name: g.name, column: g.column }))
    this.heap.clear()
    this.indexes.clear()
    this.ginIndexes.clear()
    // Rebuild the (now empty) index structures so their identity/shape is kept.
    for (const m of idxMetas) this.createIndex(m.name, m.columns, m.unique)
    for (const m of ginMetas) this.createGinIndex(m.name, m.column)
    if (restartIdentity) this.nextRowId = 1
    this.statsCache = null
  }

  updateRow(rowid: number, newRow: Row): void {
    this.validateRow(newRow)
    this.checkUnique(newRow, rowid)
    const old = this.heap.get(rowid)
    if (!old) return
    for (const idx of this.indexes.values()) idx.tree.remove(idx.keyOf(old), rowid)
    for (const g of this.ginIndexes.values()) g.removeRow(rowid, old)
    this.heap.set(rowid, newRow)
    for (const idx of this.indexes.values()) idx.tree.insert(idx.keyOf(newRow), rowid)
    for (const g of this.ginIndexes.values()) g.addRow(rowid, newRow)
    this.statsCache = null
  }

  /** Coerce a row into declared types and enforce NOT NULL + CHECK (mutates). */
  validateRow(row: Row): void {
    for (let i = 0; i < this.columns.length; i++) {
      const col = this.columns[i]
      if (row[i] === null && col.notNull) {
        throw new SqlError(`NOT NULL constraint violated on "${this.name}.${col.name}"`, 'constraint')
      }
      row[i] = coerceTo(col.type, row[i], col.scale, col.elemType)
    }
    for (const chk of this.compiledChecks()) {
      const v = chk.fn(row)
      // SQL semantics: a CHECK is violated only when it evaluates to FALSE;
      // NULL (unknown) passes.
      if (v === false) {
        const label = chk.def.name ? `"${chk.def.name}"` : `on "${this.name}"`
        throw new SqlError(`CHECK constraint ${label} violated`, 'constraint')
      }
    }
  }

  /** Enforce every UNIQUE/PK index, ignoring `exceptRowid` (the row being updated). */
  private checkUnique(row: Row, exceptRowid: number | null): void {
    for (const idx of this.indexes.values()) {
      if (!idx.meta.unique) continue
      const key = idx.keyOf(row)
      if (key.some((k) => k === null)) continue // a NULL component never collides
      const hits = idx.tree.search(key).filter((id) => id !== exceptRowid)
      if (hits.length > 0) {
        throw new SqlError(`UNIQUE constraint violated on "${this.name}.${idx.meta.columns.join(', ')}"`, 'constraint')
      }
    }
  }

  private compiledChecks(): CompiledCheck[] {
    if (this.checkCache) return this.checkCache
    const ctx: CompileCtx = { resolve: (_t, n) => this.requireColumnIndex(n) }
    this.checkCache = this.constraints.checks.map((def) => ({ def, fn: compileExpr(def.expr, ctx) }))
    return this.checkCache
  }
  /** Drop cached compiled checks (after the constraint set changes). */
  invalidateChecks(): void {
    this.checkCache = null
  }

  // --- statistics ---------------------------------------------------------
  /** Return cached stats, gathering them lazily if stale. */
  ensureStats(): TableStat {
    if (!this.statsCache) {
      this.statsCache = gatherTableStats(
        this.heap.values(),
        this.columns.map((c) => ({ name: c.name, type: c.type })),
      )
    }
    return this.statsCache
  }
  /** Force a fresh stats gather (ANALYZE). */
  analyze(): TableStat {
    this.statsCache = null
    return this.ensureStats()
  }
  hasStats(): boolean {
    return this.statsCache !== null
  }

  // --- indexes ------------------------------------------------------------
  createIndex(name: string, columns: string[], unique: boolean): IndexHandle {
    const columnIndexes = columns.map((c) => {
      const i = this.columnIndex(c)
      if (i < 0) throw new SqlError(`no column "${c}" to index on "${this.name}"`, 'bind')
      return i
    })
    const tree = new BTree()
    const handle = new IndexHandle({ name, columns, columnIndexes, unique }, tree)
    // Backfill existing rows.
    for (const [rowid, row] of this.heap) tree.insert(handle.keyOf(row), rowid)
    this.indexes.set(name.toLowerCase(), handle)
    return handle
  }

  /** Build a GIN inverted index over a single tsvector column. */
  createGinIndex(name: string, column: string): GinIndexHandle {
    const ci = this.columnIndex(column)
    if (ci < 0) throw new SqlError(`no column "${column}" to index on "${this.name}"`, 'bind')
    const handle = new GinIndexHandle(name, column, ci)
    // Backfill existing rows into the inverted index.
    for (const [rowid, row] of this.heap) handle.addRow(rowid, row)
    this.ginIndexes.set(name.toLowerCase(), handle)
    return handle
  }

  /** A GIN index on exactly `column`, if one exists. */
  ginIndexForColumn(column: string): GinIndexHandle | undefined {
    const lc = column.toLowerCase()
    for (const g of this.ginIndexes.values()) if (g.column.toLowerCase() === lc) return g
    return undefined
  }

  /** A single-column index on exactly `column`, if one exists. */
  indexForColumn(column: string): IndexHandle | undefined {
    const lc = column.toLowerCase()
    for (const idx of this.indexes.values()) {
      if (idx.meta.columns.length === 1 && idx.meta.columns[0].toLowerCase() === lc) return idx
    }
    return undefined
  }

  /** A UNIQUE index whose columns are exactly `columns` (order-sensitive). */
  uniqueIndexOn(columns: string[]): IndexHandle | undefined {
    const want = columns.map((c) => c.toLowerCase())
    for (const idx of this.indexes.values()) {
      if (!idx.meta.unique) continue
      const have = idx.meta.columns.map((c) => c.toLowerCase())
      if (have.length === want.length && have.every((c, i) => c === want[i])) return idx
    }
    return undefined
  }

  /** All indexes whose *leading* column is `column` (single or composite). */
  indexesLeadingWith(column: string): IndexHandle[] {
    const lc = column.toLowerCase()
    const out: IndexHandle[] = []
    for (const idx of this.indexes.values()) {
      if (idx.meta.columns[0]?.toLowerCase() === lc) out.push(idx)
    }
    return out
  }

  allIndexes(): IndexHandle[] {
    return [...this.indexes.values()]
  }
  hasIndexNamed(name: string): boolean {
    return this.indexes.has(name.toLowerCase()) || this.ginIndexes.has(name.toLowerCase())
  }

  /** rowids whose values in `columnIndexes` all equal `values` (none NULL). */
  findRowsMatching(columnIndexes: number[], values: SqlValue[]): number[] {
    const out: number[] = []
    outer: for (const [rowid, row] of this.heap) {
      for (let i = 0; i < columnIndexes.length; i++) {
        if (!valuesEqual(row[columnIndexes[i]], values[i])) continue outer
      }
      out.push(rowid)
    }
    return out
  }

  // --- schema evolution (ALTER TABLE) -------------------------------------
  /** Append a column, backfilling existing rows with its DEFAULT (or NULL). */
  addColumn(col: ColumnDef): void {
    if (this.columnIndex(col.name) >= 0) throw new SqlError(`column "${col.name}" already exists in "${this.name}"`, 'ddl')
    const fill = col.default ? coerceTo(col.type, evalColumnDefault(col), col.scale, col.elemType) : null
    if (col.notNull && fill === null && this.heap.size > 0) {
      throw new SqlError(`cannot add NOT NULL column "${col.name}" without a DEFAULT to non-empty table "${this.name}"`, 'ddl')
    }
    this.columns.push(col)
    for (const row of this.heap.values()) row.push(fill)
    this.statsCache = null
    this.checkCache = null
  }

  /** Is `column` referenced by any index, constraint, or CHECK expression? */
  columnDependents(column: string): string[] {
    const lc = column.toLowerCase()
    const used: string[] = []
    if (this.constraints.primaryKey?.some((c) => c.toLowerCase() === lc)) used.push('PRIMARY KEY')
    if (this.constraints.uniques.some((u) => u.some((c) => c.toLowerCase() === lc))) used.push('a UNIQUE constraint')
    if (this.constraints.foreignKeys.some((fk) => fk.columns.some((c) => c.toLowerCase() === lc))) used.push('a FOREIGN KEY')
    for (const chk of this.constraints.checks) {
      let hit = false
      walkExprColumns(chk.expr, (c) => {
        if (c.name.toLowerCase() === lc) hit = true
      })
      if (hit) {
        used.push('a CHECK constraint')
        break
      }
    }
    for (const idx of this.indexes.values()) {
      if (idx.meta.columns.some((c) => c.toLowerCase() === lc)) {
        used.push(`index "${idx.meta.name}"`)
        break
      }
    }
    return used
  }

  /** Remove a column (caller guarantees no dependents); rebuild indexes. */
  dropColumn(column: string): void {
    const di = this.requireColumnIndex(column)
    if (this.columns.length === 1) throw new SqlError(`cannot drop the last column of "${this.name}"`, 'ddl')
    const metas = [...this.indexes.values()].map((h) => ({ name: h.meta.name, columns: h.meta.columns.slice(), unique: h.meta.unique }))
    this.columns.splice(di, 1)
    for (const row of this.heap.values()) row.splice(di, 1)
    this.indexes.clear()
    for (const m of metas) this.createIndex(m.name, m.columns, m.unique)
    this.statsCache = null
    this.checkCache = null
  }

  /** Rename a column, updating indexes, constraint column lists, and CHECKs. */
  renameColumn(from: string, to: string): void {
    const i = this.requireColumnIndex(from)
    if (this.columnIndex(to) >= 0) throw new SqlError(`column "${to}" already exists in "${this.name}"`, 'ddl')
    const lc = from.toLowerCase()
    const rn = (c: string) => (c.toLowerCase() === lc ? to : c)
    this.columns[i] = { ...this.columns[i], name: to }
    for (const idx of this.indexes.values()) idx.meta.columns = idx.meta.columns.map(rn)
    if (this.constraints.primaryKey) this.constraints.primaryKey = this.constraints.primaryKey.map(rn)
    this.constraints.uniques = this.constraints.uniques.map((u) => u.map(rn))
    for (const fk of this.constraints.foreignKeys) fk.columns = fk.columns.map(rn)
    for (const chk of this.constraints.checks) walkExprColumns(chk.expr, (c) => {
      if (c.name.toLowerCase() === lc) c.name = to
    })
    this.checkCache = null
  }
}

export class Database {
  readonly tables = new Map<string, Table>()
  /** Views: name (lower-case) -> definition. Resolved lazily by the planner. */
  readonly views = new Map<string, ViewDef>()

  getTable(name: string): Table {
    const t = this.tables.get(name.toLowerCase())
    if (!t) throw new SqlError(`unknown table "${name}"`, 'bind')
    return t
  }
  hasTable(name: string): boolean {
    return this.tables.has(name.toLowerCase())
  }

  // --- views ---------------------------------------------------------------
  getView(name: string): ViewDef | undefined {
    return this.views.get(name.toLowerCase())
  }
  hasView(name: string): boolean {
    return this.views.has(name.toLowerCase())
  }
  /** Define (or redefine) a view. Caller validates the body & name collisions. */
  setView(def: ViewDef): void {
    this.views.set(def.name.toLowerCase(), def)
  }
  dropView(name: string): void {
    this.views.delete(name.toLowerCase())
  }

  createTable(name: string, columns: ColumnDef[], constraints: TableConstraints = emptyConstraints()): Table {
    // Primary-key columns are implicitly NOT NULL (whether declared inline or as
    // a table-level PRIMARY KEY (…)). A *single*-column PK also sets the per-column
    // `primaryKey` flag (so it auto-indexes / shows a PK badge); a composite PK is
    // indexed once over the whole tuple and must NOT mark each column individually
    // (that would build spurious per-column unique indexes).
    if (constraints.primaryKey) {
      const single = constraints.primaryKey.length === 1
      for (const c of constraints.primaryKey) {
        const i = columns.findIndex((col) => col.name.toLowerCase() === c.toLowerCase())
        if (i < 0) throw new SqlError(`PRIMARY KEY references unknown column "${c}"`, 'ddl')
        columns[i] = { ...columns[i], notNull: true, primaryKey: single ? true : columns[i].primaryKey }
      }
    }
    const t = new Table(name, columns, constraints)
    this.tables.set(name.toLowerCase(), t)
    // Materialize a UNIQUE B+Tree for the primary key, every UNIQUE group, and
    // every single-column PK/UNIQUE flag — deduping so we never build two trees
    // over the same column set.
    const made = new Set<string>()
    const ensureUnique = (cols: string[], hint: string) => {
      const key = cols.map((c) => c.toLowerCase()).join(',')
      if (made.has(key) || t.uniqueIndexOn(cols)) {
        made.add(key)
        return
      }
      made.add(key)
      t.createIndex(this.freshIndexName(t, hint), cols, true)
    }
    if (constraints.primaryKey) ensureUnique(constraints.primaryKey, `${name}_pkey`)
    for (const c of columns) {
      if (c.primaryKey || c.unique) ensureUnique([c.name], `${name}_${c.name}_key`)
    }
    for (const u of constraints.uniques) ensureUnique(u, `${name}_uniq`)
    // Validate referential constraints against parents that already exist.
    for (const fk of constraints.foreignKeys) this.validateForeignKey(t, fk)
    return t
  }

  private freshIndexName(t: Table, base: string): string {
    let name = base
    let n = 1
    while (t.hasIndexNamed(name)) name = `${base}_${n++}`
    return name
  }

  /** Resolve a FK's referenced columns (defaulting to the parent PK) and verify
   *  they back a UNIQUE/PK index, so the reference is well-defined. */
  validateForeignKey(child: Table, fk: ForeignKeyDef): void {
    const parent = this.tables.get(fk.refTable.toLowerCase())
    if (!parent) throw new SqlError(`FOREIGN KEY references unknown table "${fk.refTable}"`, 'ddl')
    if (fk.refColumns.length === 0) {
      const pk = parent.constraints.primaryKey ?? parent.columns.filter((c) => c.primaryKey).map((c) => c.name)
      if (pk.length === 0) {
        throw new SqlError(`FOREIGN KEY references "${fk.refTable}" which has no PRIMARY KEY`, 'ddl')
      }
      fk.refColumns = pk
    }
    if (fk.columns.length !== fk.refColumns.length) {
      throw new SqlError(`FOREIGN KEY column count (${fk.columns.length}) ≠ referenced count (${fk.refColumns.length})`, 'ddl')
    }
    for (const c of fk.columns) child.requireColumnIndex(c)
    for (const c of fk.refColumns) parent.requireColumnIndex(c)
    if (!parent.uniqueIndexOn(fk.refColumns)) {
      throw new SqlError(`FOREIGN KEY references "${fk.refTable}(${fk.refColumns.join(', ')})" which is not PRIMARY KEY or UNIQUE`, 'ddl')
    }
  }

  dropTable(name: string): void {
    const t = this.tables.get(name.toLowerCase())
    if (!t) return
    // Refuse to drop a table another table still references.
    for (const other of this.tables.values()) {
      if (other === t) continue
      for (const fk of other.constraints.foreignKeys) {
        if (fk.refTable.toLowerCase() === name.toLowerCase()) {
          throw new SqlError(`cannot drop "${name}" — referenced by FOREIGN KEY on "${other.name}"`, 'ddl')
        }
      }
    }
    this.tables.delete(name.toLowerCase())
  }

  // --- referential integrity (cross-table) --------------------------------
  /** Every (childTable, fk) pair whose FK points at `parent`. */
  private referencingForeignKeys(parent: Table): { child: Table; fk: ForeignKeyDef }[] {
    const out: { child: Table; fk: ForeignKeyDef }[] = []
    for (const child of this.tables.values()) {
      for (const fk of child.constraints.foreignKeys) {
        if (fk.refTable.toLowerCase() === parent.name.toLowerCase()) out.push({ child, fk })
      }
    }
    return out
  }

  /** Verify each FK on `table` finds its parent row (NULL components skip — the
   *  standard MATCH SIMPLE semantics). Throws on a dangling reference. */
  checkReferences(table: Table, row: Row): void {
    for (const fk of table.constraints.foreignKeys) this.checkReferencesFor(table, row, fk)
  }

  /** Verify a single FK for one row. */
  checkReferencesFor(table: Table, row: Row, fk: ForeignKeyDef): void {
    const vals = fk.columns.map((c) => row[table.requireColumnIndex(c)])
    if (vals.some((v) => v === null)) return
    const parent = this.getTable(fk.refTable)
    const idx = parent.uniqueIndexOn(fk.refColumns)
    const found = idx
      ? idx.tree.search(vals).length > 0
      : parent.findRowsMatching(fk.refColumns.map((c) => parent.requireColumnIndex(c)), vals).length > 0
    if (!found) {
      const cols = fk.columns.join(', ')
      const ref = `${fk.refTable}(${fk.refColumns.join(', ')})`
      throw new SqlError(`FOREIGN KEY violated: ${table.name}(${cols}) → ${ref} has no matching row for (${vals.map(formatValue).join(', ')})`, 'constraint')
    }
  }

  /** Insert a user row, enforcing this table's FK parents exist. */
  insertChecked(table: Table, row: Row): number {
    const rowid = table.insertRow(row)
    this.checkReferences(table, row)
    return rowid
  }

  /** Update a user row, enforcing child-side FK parents and cascading parent-side
   *  referential actions to any rows that referenced the changed key. */
  updateChecked(table: Table, rowid: number, newRow: Row, depth = 0): void {
    guardDepth(depth)
    const old = table.heap.get(rowid)
    if (!old) return
    const oldSnapshot = old.slice()
    table.updateRow(rowid, newRow)
    this.checkReferences(table, newRow)
    // Parent side: a referenced key may have moved.
    for (const { child, fk } of this.referencingForeignKeys(table)) {
      const refIdx = fk.refColumns.map((c) => table.requireColumnIndex(c))
      const oldKey = refIdx.map((i) => oldSnapshot[i])
      const newKey = refIdx.map((i) => newRow[i])
      if (oldKey.some((v) => v === null)) continue
      if (oldKey.every((v, i) => valuesEqual(v, newKey[i]))) continue // key unchanged
      const childIdx = fk.columns.map((c) => child.requireColumnIndex(c))
      const matches = child.findRowsMatching(childIdx, oldKey)
      if (matches.length === 0) continue
      this.applyAction(child, fk, childIdx, matches, fk.onUpdate, newKey, depth)
    }
  }

  /** Delete a user row, applying ON DELETE actions to referencing children first. */
  deleteChecked(table: Table, rowid: number, depth = 0): void {
    guardDepth(depth)
    const row = table.heap.get(rowid)
    if (!row) return
    for (const { child, fk } of this.referencingForeignKeys(table)) {
      const refIdx = fk.refColumns.map((c) => table.requireColumnIndex(c))
      const key = refIdx.map((i) => row[i])
      if (key.some((v) => v === null)) continue
      const childIdx = fk.columns.map((c) => child.requireColumnIndex(c))
      const matches = child.findRowsMatching(childIdx, key)
      if (matches.length === 0) continue
      this.applyAction(child, fk, childIdx, matches, fk.onDelete, null, depth)
    }
    table.deleteRow(rowid)
  }

  /** Apply a referential action to the `matches` child rows of `child`. */
  private applyAction(
    child: Table,
    fk: ForeignKeyDef,
    childIdx: number[],
    matches: number[],
    action: RefAction,
    newKey: SqlValue[] | null,
    depth: number,
  ): void {
    switch (action) {
      case 'NO ACTION':
      case 'RESTRICT':
        throw new SqlError(`${action} on "${child.name}" — ${matches.length} dependent row${matches.length === 1 ? '' : 's'} via FOREIGN KEY (${fk.columns.join(', ')})`, 'constraint')
      case 'CASCADE':
        if (newKey) {
          // ON UPDATE CASCADE: move the child key to the parent's new value.
          for (const id of matches) {
            const next = child.heap.get(id)!.slice()
            childIdx.forEach((ci, k) => (next[ci] = newKey[k]))
            this.updateChecked(child, id, next, depth + 1)
          }
        } else {
          // ON DELETE CASCADE: delete the dependent rows (recursing).
          for (const id of matches) this.deleteChecked(child, id, depth + 1)
        }
        break
      case 'SET NULL':
        for (const id of matches) {
          const next = child.heap.get(id)!.slice()
          childIdx.forEach((ci) => (next[ci] = null))
          this.updateChecked(child, id, next, depth + 1)
        }
        break
      case 'SET DEFAULT':
        for (const id of matches) {
          const next = child.heap.get(id)!.slice()
          childIdx.forEach((ci) => (next[ci] = child.columns[ci].default ? evalColumnDefault(child.columns[ci]) : null))
          this.updateChecked(child, id, next, depth + 1)
        }
        break
    }
  }

  /** Deep snapshot for transactions / persistence. */
  snapshot(): SerializedDb {
    const tables: SerializedTable[] = []
    for (const t of this.tables.values()) {
      tables.push({
        name: t.name,
        columns: t.columns,
        constraints: t.constraints,
        rows: [...t.heap.values()].map((r) => r.slice()),
        indexes: [...t.indexes.values()].map((i) => ({
          name: i.meta.name,
          columns: i.meta.columns,
          unique: i.meta.unique,
        })),
        ginIndexes: [...t.ginIndexes.values()].map((g) => ({ name: g.name, column: g.column })),
      })
    }
    const views: ViewDef[] = [...this.views.values()].map((v) => ({
      name: v.name,
      columns: v.columns,
      select: v.select,
    }))
    return { version: 5, tables, views }
  }

  static restore(snap: SerializedDb): Database {
    const db = new Database()
    for (const t of snap.tables) {
      const constraints = normalizeConstraints(t.constraints)
      const table = db.createTable(t.name, t.columns, constraints)
      for (const row of t.rows) table.insertRawRow(row.slice())
      for (const idx of t.indexes) {
        // Back-compat: v1 snapshots stored a single `column`.
        const columns = idx.columns ?? (idx.column ? [idx.column] : [])
        if (columns.length && !table.hasIndexNamed(idx.name)) table.createIndex(idx.name, columns, idx.unique)
      }
      for (const g of t.ginIndexes ?? []) {
        if (!table.hasIndexNamed(g.name)) table.createGinIndex(g.name, g.column)
      }
    }
    // Views (added in snapshot v4; absent in older snapshots).
    for (const v of snap.views ?? []) db.setView({ name: v.name, columns: v.columns, select: v.select })
    return db
  }
}

const MAX_CASCADE_DEPTH = 64
function guardDepth(depth: number): void {
  if (depth > MAX_CASCADE_DEPTH) {
    throw new SqlError('referential cascade too deep (possible constraint cycle)', 'constraint')
  }
}

/** Visit every column reference inside an expression (used by ALTER guards
 *  and column rename). Subquery bodies are intentionally not traversed —
 *  CHECK/DEFAULT expressions never contain them. */
function walkExprColumns(e: Expr, visit: (c: ColumnExpr) => void): void {
  const walk = (x: Expr) => walkExprColumns(x, visit)
  switch (e.kind) {
    case 'column':
      visit(e)
      return
    case 'literal':
    case 'star':
    case 'subquery':
    case 'exists':
      return
    case 'unary':
      walk(e.expr)
      return
    case 'binary':
      walk(e.left)
      walk(e.right)
      return
    case 'between':
      walk(e.expr)
      walk(e.lo)
      walk(e.hi)
      return
    case 'in':
      walk(e.expr)
      e.list.forEach(walk)
      return
    case 'like':
      walk(e.expr)
      walk(e.pattern)
      return
    case 'isnull':
      walk(e.expr)
      return
    case 'func':
      e.args.forEach(walk)
      if (e.filter) walk(e.filter)
      return
    case 'case':
      if (e.operand) walk(e.operand)
      for (const w of e.whens) {
        walk(w.when)
        walk(w.then)
      }
      if (e.else) walk(e.else)
      return
    case 'cast':
      walk(e.expr)
      return
    case 'in_subquery':
    case 'quantified':
      walk(e.expr)
      return
    case 'quantified_array':
      walk(e.expr)
      walk(e.array)
      return
    case 'array':
      e.elements.forEach(walk)
      return
    case 'subscript':
      walk(e.base)
      if (e.index) walk(e.index)
      if (e.upper) walk(e.upper)
      return
    case 'window':
      e.args.forEach(walk)
      return
  }
}

/** Evaluate a column's DEFAULT expression (used by ON … SET DEFAULT). */
function evalColumnDefault(col: ColumnDef): SqlValue {
  if (!col.default) return null
  const fn = compileExpr(col.default, {
    resolve: () => {
      throw new SqlError('column references are not allowed in DEFAULT', 'bind')
    },
  })
  return coerceTo(col.type, fn([]), col.scale, col.elemType)
}

/** Fill in missing fields on a (possibly older) serialized constraint set. */
function normalizeConstraints(c: TableConstraints | undefined): TableConstraints {
  if (!c) return emptyConstraints()
  return {
    primaryKey: c.primaryKey,
    uniques: c.uniques ?? [],
    checks: c.checks ?? [],
    foreignKeys: c.foreignKeys ?? [],
  }
}

export interface SerializedIndex {
  name: string
  columns?: string[]
  /** Legacy single-column form (v1 snapshots). */
  column?: string
  unique: boolean
}
export interface SerializedTable {
  name: string
  columns: ColumnDef[]
  /** Declarative constraints (added in snapshot v3; absent in older snapshots). */
  constraints?: TableConstraints
  rows: Row[]
  indexes: SerializedIndex[]
  /** GIN indexes (added in snapshot v5; absent in older snapshots). */
  ginIndexes?: { name: string; column: string }[]
}
export interface SerializedDb {
  version: number
  tables: SerializedTable[]
  /** Views (added in snapshot v4; absent in older snapshots). */
  views?: ViewDef[]
}

export type { CheckConstraint, ForeignKeyDef }
