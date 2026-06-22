// The vectorized executor: a second, independent execution engine for the
// supported analytic subset (single table; numeric WHERE / GROUP BY /
// aggregates). It is deliberately *conservative* — `prepareVectorized` returns
// `null` for anything it can't prove it matches, and the caller falls back to
// the Volcano engine — so the vectorized path can never produce a wrong answer.
//
// The pipeline is scan → filter (→ selection vector) → { hash-aggregate |
// project } → order/limit. The hash-aggregate keys groups on the *numeric* key
// tuple via an open-addressing table (no per-row string key), which together
// with the columnar typed-array reads is where most of the speedup comes from.

import type { Expr, SelectItem, SelectStmt, OrderItem } from '../ast'
import { isAggregate } from '../ast'
import type { Database } from '../catalog'
import type { Row } from '../catalog'
import { orderValues, type SqlValue } from '../types'
import { DEFAULT_VECTOR_SIZE, buildColumnStore, type ColumnStore } from './types'
import {
  compileNum,
  compilePred,
  compileValue,
  isNumericExpr,
  isPredExpr,
  isValueExpr,
  type NumEval,
  type ValEval,
} from './kernels'

// --- supported-aggregate description ---------------------------------------
const VEC_AGGS = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX'])
type VAggName = 'COUNT' | 'SUM' | 'AVG' | 'MIN' | 'MAX'

interface VAggSpec {
  name: VAggName
  star: boolean // COUNT(*)
  arg: Expr | null // the (numeric) argument, when not star
}

/** One output column: either a group-key component or an aggregate result. */
type OutSpec = { kind: 'group'; idx: number } | { kind: 'agg'; idx: number }

interface AggregatePlan {
  kind: 'aggregate'
  tableName: string
  where: Expr | null
  groupExprs: Expr[]
  aggs: VAggSpec[]
  outputs: OutSpec[]
  columnNames: string[]
  orderBy: OrderItem[]
  limit?: number
  offset?: number
}

interface ProjectPlan {
  kind: 'project'
  tableName: string
  where: Expr | null
  items: { expr: Expr; name: string }[]
  orderBy: OrderItem[]
  limit?: number
  offset?: number
}

type VecPlan = AggregatePlan | ProjectPlan

export interface VecRunResult {
  rows: Row[]
  columnNames: string[]
  inputRows: number
  outputRows: number
  vectorSize: number
  batches: number
  /** Time to transpose the heap into the columnar store (a real columnar engine
   *  stores columnar, so this is amortized away in practice). */
  buildMs: number
  /** Pure execution time over the prebuilt column store. */
  execMs: number
}

export interface VecPrepared {
  plan: VecPlan
  run(db: Database, vectorSize?: number): VecRunResult
}

// --- analysis helpers -------------------------------------------------------

function exprIsAggregate(e: Expr): boolean {
  return e.kind === 'func' && isAggregate(e.name)
}

function containsAggregate(e: Expr): boolean {
  if (exprIsAggregate(e)) return true
  switch (e.kind) {
    case 'unary':
      return containsAggregate(e.expr)
    case 'binary':
      return containsAggregate(e.left) || containsAggregate(e.right)
    case 'isnull':
      return containsAggregate(e.expr)
    case 'between':
      return containsAggregate(e.expr) || containsAggregate(e.lo) || containsAggregate(e.hi)
    case 'in':
      return containsAggregate(e.expr) || e.list.some(containsAggregate)
    default:
      return false
  }
}

/** Structural equality for the limited expression forms a GROUP BY uses. */
function exprEqual(a: Expr, b: Expr): boolean {
  if (a.kind !== b.kind) return false
  switch (a.kind) {
    case 'column':
      return a.name.toLowerCase() === (b as typeof a).name.toLowerCase()
    case 'literal':
      return a.value === (b as typeof a).value
    case 'unary':
      return a.op === (b as typeof a).op && exprEqual(a.expr, (b as typeof a).expr)
    case 'binary':
      return (
        a.op === (b as typeof a).op &&
        exprEqual(a.left, (b as typeof a).left) &&
        exprEqual(a.right, (b as typeof a).right)
      )
    default:
      return false
  }
}

function itemName(item: SelectItem, fallback: number): string {
  if (item.alias) return item.alias
  if (item.expr.kind === 'column') return item.expr.name
  if (item.expr.kind === 'func') return item.expr.name.toLowerCase()
  return `column${fallback + 1}`
}

/** Resolve an ORDER BY term to an output-column index (a positional ordinal, or
 *  a term structurally equal to a select item / its alias). Returns -1 if it
 *  can't be resolved against the output (⇒ unsupported, fall back). */
function orderTargetIndex(term: Expr, items: SelectItem[]): number {
  if (term.kind === 'literal' && typeof term.value === 'number' && Number.isInteger(term.value)) {
    const ord = term.value - 1
    return ord >= 0 && ord < items.length ? ord : -1
  }
  for (let i = 0; i < items.length; i++) {
    if (items[i].alias && term.kind === 'column' && term.name.toLowerCase() === items[i].alias!.toLowerCase())
      return i
    if (exprEqual(term, items[i].expr)) return i
  }
  return -1
}

// --- the analyzer -----------------------------------------------------------

/** Decide whether `stmt` is in the vectorized engine's supported subset. On
 *  success returns a prepared plan; otherwise `{ reason }`. */
export function prepareVectorized(
  stmt: SelectStmt,
  db: Database,
): { prepared: VecPrepared } | { reason: string } {
  // Structural gates: a plain single-table SELECT, nothing exotic.
  if (stmt.setOps && stmt.setOps.length) return { reason: 'set operations (UNION/INTERSECT/EXCEPT)' }
  if (stmt.ctes && stmt.ctes.length) return { reason: 'CTEs (WITH)' }
  if (stmt.distinct) return { reason: 'SELECT DISTINCT' }
  if (stmt.joins.length) return { reason: 'joins' }
  if (stmt.windows && stmt.windows.length) return { reason: 'window functions' }
  if (stmt.qualify) return { reason: 'QUALIFY' }
  if (stmt.having) return { reason: 'HAVING' }
  if (stmt.groupingSets) return { reason: 'GROUPING SETS / ROLLUP / CUBE' }
  if (!stmt.from || !stmt.from.table) return { reason: 'FROM must be a single base table' }

  const tableName = stmt.from.table
  if (!db.hasTable(tableName)) return { reason: `unknown table "${tableName}"` }
  const table = db.getTable(tableName)

  // A lightweight store-shaped view (names + types only) for support checks; the
  // real store (with data) is built at run time.
  const schemaStore: ColumnStore = {
    columns: table.columns.map((c) => ({ kind: 'gen', type: c.type, data: [] })),
    names: table.columns.map((c) => c.name.toLowerCase()),
    rowCount: 0,
  }
  // `isNumericExpr` / `isPredExpr` / `isValueExpr` only consult column *types*
  // (`store.columns[idx].type`), which `schemaStore` carries — so the support
  // testers work with no data present.
  const numericOk = (e: Expr): boolean => isNumericExpr(e, schemaStore)
  const predOk = (e: Expr): boolean => isPredExpr(e, schemaStore)
  const valueOk = (e: Expr): boolean => isValueExpr(e, schemaStore)

  if (stmt.where && !predOk(stmt.where)) return { reason: 'a WHERE clause outside the numeric kernel set' }

  // GROUP BY columns must be numeric (so the native key hash applies).
  for (const g of stmt.groupBy) {
    if (!numericOk(g)) return { reason: 'a non-numeric GROUP BY key' }
  }

  // Expand SELECT * for the projection path.
  const items = stmt.columns
  const hasStar = items.some((it) => it.expr.kind === 'star')
  const aggregateQuery = stmt.groupBy.length > 0 || items.some((it) => containsAggregate(it.expr))

  // ORDER BY must be resolvable against the output (so we can sort the result
  // rows). Validated after we know the output items.
  function checkOrderBy(outItems: SelectItem[]): string | null {
    for (const o of stmt.orderBy) {
      if (orderTargetIndex(o.expr, outItems) < 0) return 'an ORDER BY term not in the select list'
    }
    return null
  }

  if (aggregateQuery) {
    if (hasStar) return { reason: 'SELECT * with aggregation' }
    const groupExprs = stmt.groupBy
    const aggs: VAggSpec[] = []
    const outputs: OutSpec[] = []
    const columnNames: string[] = []
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      const e = it.expr
      columnNames.push(itemName(it, i))
      if (e.kind === 'func' && isAggregate(e.name)) {
        const name = e.name.toUpperCase()
        if (!VEC_AGGS.has(name)) return { reason: `aggregate ${name}()` }
        if (e.distinct) return { reason: 'DISTINCT aggregates' }
        if (e.filter) return { reason: 'aggregate FILTER (WHERE …)' }
        if (e.withinGroup) return { reason: 'ordered-set aggregates' }
        if (e.star) {
          if (name !== 'COUNT') return { reason: `${name}(*)` }
          aggs.push({ name: 'COUNT', star: true, arg: null })
        } else {
          if (e.args.length !== 1) return { reason: `${name}() with ${e.args.length} arguments` }
          const arg = e.args[0]
          if (!numericOk(arg)) return { reason: `${name}() over a non-numeric argument` }
          aggs.push({ name: name as VAggName, star: false, arg })
        }
        outputs.push({ kind: 'agg', idx: aggs.length - 1 })
      } else if (containsAggregate(e)) {
        // e.g. SUM(x)+1 — an expression *over* aggregates. Out of scope for v1.
        return { reason: 'expressions computed over aggregate results' }
      } else {
        // Must be one of the grouping expressions (the SQL single-value rule).
        const gi = groupExprs.findIndex((g) => exprEqual(g, e))
        if (gi < 0) return { reason: 'a select item that is neither an aggregate nor a GROUP BY key' }
        outputs.push({ kind: 'group', idx: gi })
      }
    }
    const orderErr = checkOrderBy(items)
    if (orderErr) return { reason: orderErr }
    const plan: AggregatePlan = {
      kind: 'aggregate',
      tableName,
      where: stmt.where ?? null,
      groupExprs,
      aggs,
      outputs,
      columnNames,
      orderBy: stmt.orderBy,
      limit: stmt.limit,
      offset: stmt.offset,
    }
    return { prepared: makePrepared(plan) }
  }

  // Projection-only path.
  const projItems: { expr: Expr; name: string }[] = []
  if (hasStar) {
    for (const it of items) {
      if (it.expr.kind === 'star') {
        if (it.expr.table) return { reason: 'qualified star (t.*)' }
        for (const c of table.columns) projItems.push({ expr: { kind: 'column', name: c.name }, name: c.name })
      } else {
        if (!valueOk(it.expr)) return { reason: 'a select item outside the value-kernel set' }
        projItems.push({ expr: it.expr, name: itemName(it, projItems.length) })
      }
    }
  } else {
    for (let i = 0; i < items.length; i++) {
      if (!valueOk(items[i].expr)) return { reason: 'a select item outside the value-kernel set' }
      projItems.push({ expr: items[i].expr, name: itemName(items[i], i) })
    }
  }
  // ORDER BY for the projection path resolves against the projected items.
  const orderErr = checkOrderBy(items.filter((it) => it.expr.kind !== 'star'))
  if (orderErr && stmt.orderBy.length) {
    // Allow ORDER BY by a *column that is also projected*; handled by matching
    // projItems below. If still unresolved, bail.
    for (const o of stmt.orderBy) {
      const idx = projItems.findIndex((p) => exprEqual(p.expr, o.expr))
      if (idx < 0) return { reason: 'an ORDER BY term not in the select list' }
    }
  }
  const plan: ProjectPlan = {
    kind: 'project',
    tableName,
    where: stmt.where ?? null,
    items: projItems,
    orderBy: stmt.orderBy,
    limit: stmt.limit,
    offset: stmt.offset,
  }
  return { prepared: makePrepared(plan) }
}

// --- execution --------------------------------------------------------------

function resolveOrderColumns(orderBy: OrderItem[], names: string[], plan: VecPlan): { col: number; dir: number }[] {
  const keys: { col: number; dir: number }[] = []
  for (const o of orderBy) {
    let col = -1
    if (o.expr.kind === 'literal' && typeof o.expr.value === 'number' && Number.isInteger(o.expr.value)) {
      col = o.expr.value - 1
    } else if (o.expr.kind === 'column') {
      const want = o.expr.name.toLowerCase()
      col = names.findIndex((n) => n.toLowerCase() === want)
    }
    if (col < 0) {
      // Fall back to a structural match against the source select items.
      if (plan.kind === 'project') col = plan.items.findIndex((p) => exprEqual(p.expr, o.expr))
      else col = plan.groupExprs.findIndex((g) => exprEqual(g, o.expr))
    }
    if (col >= 0 && col < names.length) keys.push({ col, dir: o.dir === 'DESC' ? -1 : 1 })
  }
  return keys
}

function applyOrderLimit(rows: Row[], plan: VecPlan, names: string[]): Row[] {
  if (plan.orderBy.length) {
    const keys = resolveOrderColumns(plan.orderBy, names, plan)
    if (keys.length) {
      const indexed = rows.map((r, i) => ({ r, i }))
      indexed.sort((a, b) => {
        for (const k of keys) {
          const c = orderValues(a.r[k.col], b.r[k.col]) * k.dir
          if (c !== 0) return c
        }
        return a.i - b.i // stable
      })
      rows = indexed.map((x) => x.r)
    }
  }
  const offset = plan.offset ?? 0
  if (offset > 0 || plan.limit !== undefined) {
    const end = plan.limit !== undefined ? offset + plan.limit : rows.length
    rows = rows.slice(offset, end)
  }
  return rows
}

function makePrepared(plan: VecPlan): VecPrepared {
  return {
    plan,
    run(db: Database, vectorSize = DEFAULT_VECTOR_SIZE): VecRunResult {
      const table = db.getTable(plan.tableName)
      const t0 = performance.now()
      const store = buildColumnStore(table)
      const t1 = performance.now()
      const result = plan.kind === 'aggregate' ? runAggregate(plan, store, vectorSize) : runProject(plan, store, vectorSize)
      let rows = result.rows
      rows = applyOrderLimit(rows, plan, result.columnNames)
      const t2 = performance.now()
      return {
        rows,
        columnNames: result.columnNames,
        inputRows: store.rowCount,
        outputRows: rows.length,
        vectorSize,
        batches: result.batches,
        buildMs: t1 - t0,
        execMs: t2 - t1,
      }
    },
  }
}

function runProject(plan: ProjectPlan, store: ColumnStore, vectorSize: number): { rows: Row[]; columnNames: string[]; batches: number } {
  const where = plan.where ? compilePred(plan.where, store) : null
  const evals: ValEval[] = plan.items.map((p) => compileValue(p.expr, store))
  const names = plan.items.map((p) => p.name)
  const rows: Row[] = []
  const n = store.rowCount
  const sel = new Int32Array(vectorSize)
  let batches = 0
  for (let start = 0; start < n; start += vectorSize) {
    const end = Math.min(start + vectorSize, n)
    let k = 0
    if (where) {
      for (let i = start; i < end; i++) if (where(i) === 1) sel[k++] = i
    } else {
      for (let i = start; i < end; i++) sel[k++] = i
    }
    for (let s = 0; s < k; s++) {
      const i = sel[s]
      const row: Row = new Array(evals.length)
      for (let c = 0; c < evals.length; c++) row[c] = evals[c](i)
      rows.push(row)
    }
    batches++
  }
  return { rows, columnNames: names, batches }
}

// Reinterpret-cast buffers for hashing a non-integer double's exact bits.
const HASH_F64 = new Float64Array(1)
const HASH_U32 = new Uint32Array(HASH_F64.buffer)
/** Fold one key component into a rolling hash. Small integers (the common group
 *  key) take a multiply-only fast path; other doubles hash their 64 bits. */
function hashOne(h: number, v: number, isNull: number): number {
  if (isNull) return Math.imul(h ^ 0x9e3779b1, 2654435761)
  const iv = v | 0
  if (iv === v) return Math.imul(h ^ (iv + 0x85ebca6b), 2654435761)
  HASH_F64[0] = v === 0 ? 0 : v // normalize -0
  h = Math.imul(h ^ HASH_U32[0], 2654435761)
  return Math.imul(h ^ HASH_U32[1], 2246822519)
}

/** Native open-addressing hash table over the numeric group-key tuple, with the
 *  per-group aggregate accumulators packed into FLAT typed arrays (indexed
 *  `group*nAggs + agg`) — no arrays-of-arrays, no per-row string key. This is
 *  the engine room of the speedup. */
class VecAggregator {
  private readonly keyCols: number
  private readonly nAggs: number
  private cap = 16
  size = 0
  private slotMask = 31
  private slots = new Int32Array(32).fill(-1)
  keys: Float64Array
  keyNull: Uint8Array
  cnt: Float64Array
  sum: Float64Array
  mn: Float64Array
  mx: Float64Array
  has: Uint8Array

  constructor(keyCols: number, nAggs: number) {
    this.keyCols = keyCols
    this.nAggs = nAggs
    const kc = Math.max(1, keyCols)
    this.keys = new Float64Array(this.cap * kc)
    this.keyNull = new Uint8Array(this.cap * kc)
    this.cnt = new Float64Array(this.cap * nAggs)
    this.sum = new Float64Array(this.cap * nAggs)
    this.mn = new Float64Array(this.cap * nAggs)
    this.mx = new Float64Array(this.cap * nAggs)
    this.has = new Uint8Array(this.cap * nAggs)
  }

  private growGroups(): void {
    const cap = this.cap * 2
    const kc = Math.max(1, this.keyCols)
    const na = this.nAggs
    const keys = new Float64Array(cap * kc)
    keys.set(this.keys)
    const keyNull = new Uint8Array(cap * kc)
    keyNull.set(this.keyNull)
    const cnt = new Float64Array(cap * na)
    cnt.set(this.cnt)
    const sum = new Float64Array(cap * na)
    sum.set(this.sum)
    const mn = new Float64Array(cap * na)
    mn.set(this.mn)
    const mx = new Float64Array(cap * na)
    mx.set(this.mx)
    const has = new Uint8Array(cap * na)
    has.set(this.has)
    this.cap = cap
    this.keys = keys
    this.keyNull = keyNull
    this.cnt = cnt
    this.sum = sum
    this.mn = mn
    this.mx = mx
    this.has = has
  }

  private growSlots(): void {
    const cap = (this.slotMask + 1) * 2
    const mask = cap - 1
    const slots = new Int32Array(cap).fill(-1)
    const kc = this.keyCols
    for (let g = 0; g < this.size; g++) {
      let h = 0x811c9dc5
      const base = g * kc
      for (let c = 0; c < kc; c++) h = hashOne(h, this.keys[base + c], this.keyNull[base + c])
      let idx = (h >>> 0) & mask
      while (slots[idx] !== -1) idx = (idx + 1) & mask
      slots[idx] = g
    }
    this.slots = slots
    this.slotMask = mask
  }

  /** Find the group for this key, creating it (zeroed) if new. */
  findOrCreate(key: number[], keyNull: number[]): number {
    const kc = this.keyCols
    let h = 0x811c9dc5
    for (let c = 0; c < kc; c++) h = hashOne(h, key[c], keyNull[c])
    const mask = this.slotMask
    const slots = this.slots
    let idx = (h >>> 0) & mask
    for (;;) {
      const g = slots[idx]
      if (g === -1) {
        const ng = this.size++
        const base = ng * kc
        for (let c = 0; c < kc; c++) {
          this.keys[base + c] = keyNull[c] ? 0 : key[c]
          this.keyNull[base + c] = keyNull[c]
        }
        slots[idx] = ng
        if (this.size >= this.cap) this.growGroups()
        if (this.size >= (mask + 1) * 0.7) this.growSlots()
        return ng
      }
      const base = g * kc
      let eq = true
      for (let c = 0; c < kc; c++) {
        const gn = this.keyNull[base + c]
        if (gn !== keyNull[c] || (!gn && this.keys[base + c] !== key[c])) {
          eq = false
          break
        }
      }
      if (eq) return g
      idx = (idx + 1) & mask
    }
  }

  keyAt(g: number, c: number): SqlValue {
    const base = g * this.keyCols
    return this.keyNull[base + c] ? null : this.keys[base + c]
  }
}

// Aggregate-update kinds, hoisted out of the row loop as a typed array so the
// inner switch is a small-integer branch, not an object-property read.
const K_STAR = 0 // COUNT(*)
const K_COUNT = 1 // COUNT(x)
const K_SUM = 2 // SUM / AVG
const K_MIN = 3
const K_MAX = 4

function runAggregate(plan: AggregatePlan, store: ColumnStore, vectorSize: number): { rows: Row[]; columnNames: string[]; batches: number } {
  const where = plan.where ? compilePred(plan.where, store) : null
  const groupEvals: NumEval[] = plan.groupExprs.map((g) => compileNum(g, store))
  const keyCols = groupEvals.length
  const nAggs = plan.aggs.length
  const argEvals: NumEval[] = plan.aggs.map((a) => (a.arg ? compileNum(a.arg, store) : () => null))
  const kinds = new Int8Array(nAggs)
  for (let a = 0; a < nAggs; a++) {
    const s = plan.aggs[a]
    kinds[a] = s.star
      ? K_STAR
      : s.name === 'COUNT'
        ? K_COUNT
        : s.name === 'SUM' || s.name === 'AVG'
          ? K_SUM
          : s.name === 'MIN'
            ? K_MIN
            : K_MAX
  }
  const agg = new VecAggregator(keyCols, nAggs)

  // No GROUP BY ⇒ a single implicit group, present even over zero rows.
  if (keyCols === 0) agg.findOrCreate([], [])

  const scratchKey = new Array<number>(keyCols)
  const scratchNull = new Array<number>(keyCols)
  const n = store.rowCount
  const sel = new Int32Array(vectorSize)
  let batches = 0
  for (let start = 0; start < n; start += vectorSize) {
    const end = Math.min(start + vectorSize, n)
    // Filter → selection vector.
    let k = 0
    if (where) {
      for (let i = start; i < end; i++) if (where(i) === 1) sel[k++] = i
    } else {
      for (let i = start; i < end; i++) sel[k++] = i
    }
    // Aggregate the selected rows.
    for (let s = 0; s < k; s++) {
      const i = sel[s]
      let g: number
      if (keyCols === 0) {
        g = 0
      } else {
        for (let c = 0; c < keyCols; c++) {
          const v = groupEvals[c](i)
          if (v === null) {
            scratchNull[c] = 1
            scratchKey[c] = 0
          } else {
            scratchNull[c] = 0
            scratchKey[c] = v
          }
        }
        g = agg.findOrCreate(scratchKey, scratchNull)
      }
      // Re-fetch the accumulator arrays (a grow inside findOrCreate may have
      // reallocated them) — cheap field loads, then tight typed-array updates.
      const cnt = agg.cnt
      const sum = agg.sum
      const mn = agg.mn
      const mx = agg.mx
      const has = agg.has
      const base = g * nAggs
      for (let a = 0; a < nAggs; a++) {
        const kind = kinds[a]
        const idx = base + a
        if (kind === K_STAR) {
          cnt[idx]++
          continue
        }
        const v = argEvals[a](i)
        if (v === null) continue
        cnt[idx]++
        if (kind === K_SUM) sum[idx] += v
        else if (kind === K_MIN) {
          if (!has[idx] || v < mn[idx]) mn[idx] = v
        } else if (kind === K_MAX) {
          if (!has[idx] || v > mx[idx]) mx[idx] = v
        }
        has[idx] = 1
      }
    }
    batches++
  }

  // Finalize each group into an output row.
  const rows: Row[] = []
  for (let g = 0; g < agg.size; g++) {
    const base = g * nAggs
    const row: Row = new Array(plan.outputs.length)
    for (let o = 0; o < plan.outputs.length; o++) {
      const spec = plan.outputs[o]
      if (spec.kind === 'group') {
        row[o] = agg.keyAt(g, spec.idx)
      } else {
        const a = spec.idx
        const idx = base + a
        switch (plan.aggs[a].name) {
          case 'COUNT':
            row[o] = agg.cnt[idx]
            break
          case 'SUM':
            row[o] = agg.has[idx] ? agg.sum[idx] : null
            break
          case 'AVG':
            row[o] = agg.has[idx] ? agg.sum[idx] / agg.cnt[idx] : null
            break
          case 'MIN':
            row[o] = agg.has[idx] ? agg.mn[idx] : null
            break
          case 'MAX':
            row[o] = agg.has[idx] ? agg.mx[idx] : null
            break
        }
      }
    }
    rows.push(row)
  }
  return { rows, columnNames: plan.columnNames, batches }
}
