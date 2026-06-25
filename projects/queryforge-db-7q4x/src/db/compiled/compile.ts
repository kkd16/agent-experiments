// The query COMPILER: a third, independent execution path for QueryForge.
//
// Where the Volcano engine *interprets* a physical plan (a tree of operators
// pulled one tuple at a time through virtual `next()` calls) and the vectorized
// engine processes columnar *batches*, this path takes the data-centric
// "compiling query plans" road (Neumann, VLDB 2011 — the HyPer model): it walks
// the plan ONCE and emits a single, straight-line **JavaScript function** that
// fuses the whole pipeline — scan → hash-join probes → filter → group/aggregate
// — into one loop with no per-operator dispatch, no intermediate tuple
// materialization, and the join hash tables and aggregate accumulators inlined
// as local variables. We then `new Function(...)` that source, so the browser's
// own JIT compiles it down to machine code. The generated source is a readable
// artifact the CompileLab puts on screen.
//
// Like the vectorized engine, this path is deliberately *conservative*:
// `prepareCompiled` returns a `{ reason }` for anything it can't prove it
// matches, and the caller falls back to Volcano — so the compiled path can
// never produce a wrong answer. Its supported subset is: a base-table FROM with
// zero or more INNER joins (equi-join on plain columns, left-deep, build on the
// joined relations / probe from FROM), an arbitrary scalar WHERE, GROUP BY with
// COUNT / SUM / AVG / MIN / MAX, projection of arbitrary scalar expressions, and
// ORDER BY / LIMIT / OFFSET. Expression *leaves* reuse the canonical compiled
// evaluator from `eval.ts` (captured as closures), so three-valued logic and the
// full type system are byte-for-byte identical to the interpreter; what this
// module compiles is the *operator pipeline* around them.

import type { Expr, SelectStmt, SelectItem, OrderItem } from '../ast'
import { isAggregate } from '../ast'
import type { Database, Row } from '../catalog'
import { type SqlValue, type ColumnType, orderValues, hashKey } from '../types'
import { compileExpr, type Evaluator, type CompileCtx } from '../eval'

// --- the matched plan -------------------------------------------------------

/** One relation participating in the (left-deep) join pipeline. */
export interface CompiledRelation {
  /** Base table name. */
  table: string
  /** Effective name used to qualify columns (alias ?? table), lowercased. */
  alias: string
  /** Lowercased column names, in table order. */
  columnNames: string[]
  columnTypes: ColumnType[]
  /** Where this relation's columns start in the combined row layout. */
  offset: number
  width: number
}

/** One equi-join, hashing `buildIdx` columns of the relation and probing with
 *  `probeIdx` columns (combined-layout indices over already-bound relations). */
interface JoinSpec {
  rel: number // index into `relations` of the build side
  buildIdx: number[] // column indices within the build relation's own row
  probeIdx: number[] // combined-layout indices for the probe key
}

type AggName = 'COUNT' | 'SUM' | 'AVG' | 'MIN' | 'MAX'

interface AggSpec {
  name: AggName
  star: boolean
  /** Evaluator for the (combined-row) argument; null for COUNT(*). */
  arg: Evaluator | null
}

/** One output column: a grouping-key component or an aggregate result. */
type OutSpec = { kind: 'group'; idx: number } | { kind: 'agg'; idx: number }

interface AggregatePlan {
  kind: 'aggregate'
  groupKeys: Evaluator[]
  aggs: AggSpec[]
  outputs: OutSpec[]
}

interface ProjectPlan {
  kind: 'project'
  projs: Evaluator[]
}

/** The runtime bag the generated function closes over (expression closures +
 *  helpers). Captured at compile time; never re-resolved per row. */
export interface Runtime {
  hk: (vs: SqlValue[]) => string
  cmp: (a: SqlValue, b: SqlValue) => number
  where: Evaluator | null
  /** Probe-key extractors are inlined as index reads; agg/group/proj closures
   *  are looked up positionally from these arrays by the generated code. */
  groupKey: Evaluator[]
  aggArg: (Evaluator | null)[]
  proj: Evaluator[]
}

/** Per-relation row arrays, gathered from the heaps at run time. */
export interface RelData {
  rows: Row[]
}

type CompiledFn = (rels: RelData[], R: Runtime) => Row[]

export interface CompileRunResult {
  rows: Row[]
  columnNames: string[]
  inputRows: number
  outputRows: number
  /** Pure execution time of the generated function (build + probe + aggregate
   *  + order/limit), excluding the one-time codegen. */
  execMs: number
}

export interface CompiledQuery {
  /** The generated JavaScript source — the artifact the Lab displays. */
  source: string
  /** Wall-clock spent generating the source and `new Function`-ing it. */
  compileMs: number
  columnNames: string[]
  relations: CompiledRelation[]
  kind: 'aggregate' | 'project'
  /** Human-readable one-liners describing the fused pipeline (for the Lab). */
  pipeline: string[]
  /** Materialize the source heaps into row arrays — the one-time "load" cost a
   *  real column/row store pays once, kept out of the per-run exec timing. */
  gather(db: Database): RelData[]
  /** Execute the compiled function over pre-gathered relations (the timed core:
   *  hash-table build + probe + aggregate + order/limit). */
  exec(rels: RelData[]): CompileRunResult
  /** Convenience one-shot: gather + exec. */
  run(db: Database): CompileRunResult
}

// --- small expression utilities ---------------------------------------------

/** Structural equality for the limited expression forms ORDER BY / GROUP BY
 *  use (mirrors the vectorized analyzer so the two agree on what they match). */
function exprEqual(a: Expr, b: Expr): boolean {
  if (a.kind !== b.kind) return false
  switch (a.kind) {
    case 'column': {
      const bb = b as typeof a
      return a.name.toLowerCase() === bb.name.toLowerCase() && (a.table ?? '').toLowerCase() === (bb.table ?? '').toLowerCase()
    }
    case 'literal':
      return a.value === (b as typeof a).value
    case 'unary':
      return a.op === (b as typeof a).op && exprEqual(a.expr, (b as typeof a).expr)
    case 'binary': {
      const bb = b as typeof a
      return a.op === bb.op && exprEqual(a.left, bb.left) && exprEqual(a.right, bb.right)
    }
    case 'func': {
      const bb = b as typeof a
      return a.name.toLowerCase() === bb.name.toLowerCase() && a.args.length === bb.args.length && a.args.every((x, i) => exprEqual(x, bb.args[i]))
    }
    default:
      return false
  }
}

function exprIsAggregate(e: Expr): e is Extract<Expr, { kind: 'func' }> {
  return e.kind === 'func' && isAggregate(e.name)
}

/** Does any sub-expression call an aggregate? (used to reject WHERE/keys/joins
 *  that contain one — those belong to a different plan shape). */
function containsAggregate(e: Expr): boolean {
  if (exprIsAggregate(e)) return true
  let found = false
  walk(e, (n) => {
    if (n !== e && exprIsAggregate(n)) found = true
  })
  return found
}

/** Reject the expression forms outside the compiled subset (subqueries, window
 *  functions) — their evaluators need planner-provided hooks we don't wire. */
function hasUnsupported(e: Expr): boolean {
  let bad = false
  walk(e, (n) => {
    switch (n.kind) {
      case 'subquery':
      case 'exists':
      case 'in_subquery':
      case 'quantified':
      case 'window':
        bad = true
        break
    }
  })
  return bad
}

/** A generic pre-order walk over the expression tree's child expressions. */
function walk(e: Expr, visit: (n: Expr) => void): void {
  visit(e)
  const rec = (c: Expr | undefined | null) => {
    if (c) walk(c, visit)
  }
  switch (e.kind) {
    case 'unary':
    case 'isnull':
    case 'cast':
      rec(e.expr)
      break
    case 'binary':
      rec(e.left)
      rec(e.right)
      break
    case 'between':
      rec(e.expr)
      rec(e.lo)
      rec(e.hi)
      break
    case 'in':
      rec(e.expr)
      e.list.forEach(rec)
      break
    case 'like':
      rec(e.expr)
      rec(e.pattern)
      break
    case 'case':
      if (e.operand) rec(e.operand)
      e.whens.forEach((w) => {
        rec(w.when)
        rec(w.then)
      })
      if (e.else) rec(e.else)
      break
    case 'func':
      e.args.forEach(rec)
      break
    case 'array':
      e.elements.forEach(rec)
      break
    case 'subscript':
      rec(e.base)
      if (e.index) rec(e.index)
      if (e.upper) rec(e.upper)
      break
  }
}

// --- analysis: decide support + build the plan ------------------------------

class Unsupported extends Error {}

function reason(msg: string): never {
  throw new Unsupported(msg)
}

/** Build the combined column→index resolver across all bound relations. */
function makeResolver(relations: CompiledRelation[]): (table: string | undefined, name: string) => number {
  return (table, name) => {
    const lname = name.toLowerCase()
    if (table) {
      const lt = table.toLowerCase()
      const rel = relations.find((r) => r.alias === lt || r.table.toLowerCase() === lt)
      if (!rel) reason(`unknown table "${table}"`)
      const ci = rel.columnNames.indexOf(lname)
      if (ci < 0) reason(`unknown column "${table}.${name}"`)
      return rel.offset + ci
    }
    let found = -1
    for (const rel of relations) {
      const ci = rel.columnNames.indexOf(lname)
      if (ci >= 0) {
        if (found >= 0) reason(`ambiguous column "${name}"`)
        found = rel.offset + ci
      }
    }
    if (found < 0) reason(`unknown column "${name}"`)
    return found
  }
}

/** Which single relation does this column reference belong to? */
function relationOf(relations: CompiledRelation[], col: { table?: string; name: string }): number {
  const lname = col.name.toLowerCase()
  if (col.table) {
    const lt = col.table.toLowerCase()
    const i = relations.findIndex((r) => r.alias === lt || r.table.toLowerCase() === lt)
    if (i < 0) reason(`unknown table "${col.table}"`)
    if (relations[i].columnNames.indexOf(lname) < 0) reason(`unknown column "${col.table}.${col.name}"`)
    return i
  }
  let found = -1
  for (let i = 0; i < relations.length; i++) {
    if (relations[i].columnNames.indexOf(lname) >= 0) {
      if (found >= 0) reason(`ambiguous column "${col.name}"`)
      found = i
    }
  }
  if (found < 0) reason(`unknown column "${col.name}"`)
  return found
}

const NUMERIC = new Set<ColumnType>(['INTEGER', 'REAL'])

function itemName(item: SelectItem, fallback: number): string {
  if (item.alias) return item.alias
  if (item.expr.kind === 'column') return item.expr.name
  if (item.expr.kind === 'func') return item.expr.name.toLowerCase()
  return `column${fallback + 1}`
}

interface Matched {
  relations: CompiledRelation[]
  joins: JoinSpec[]
  where: Evaluator | null
  body: AggregatePlan | ProjectPlan
  columnNames: string[]
  orderBy: OrderItem[]
  limit?: number
  offset?: number
  /** The select items, kept for ORDER BY structural resolution. */
  outItems: SelectItem[]
}

function analyze(stmt: SelectStmt, db: Database): Matched {
  // Structural gates — anything exotic falls back to Volcano.
  if (stmt.setOps && stmt.setOps.length) reason('set operations (UNION/INTERSECT/EXCEPT)')
  if (stmt.ctes && stmt.ctes.length) reason('CTEs (WITH)')
  if (stmt.distinct) reason('SELECT DISTINCT')
  if (stmt.windows && stmt.windows.length) reason('window functions')
  if (stmt.qualify) reason('QUALIFY')
  if (stmt.having) reason('HAVING')
  if (stmt.groupingSets) reason('GROUPING SETS / ROLLUP / CUBE')
  if (!stmt.from || !stmt.from.table) reason('FROM must be a single base table')
  if (stmt.from.subquery || stmt.from.tableFunc || stmt.from.lateral) reason('a derived-table / table-function / LATERAL FROM')

  // Build the relation list: FROM (probe/driver) + each INNER JOIN (build side).
  const relations: CompiledRelation[] = []
  const addRelation = (table: string, alias: string | undefined): CompiledRelation => {
    if (!db.hasTable(table)) reason(`unknown table "${table}"`)
    const t = db.getTable(table)
    const offset = relations.reduce((s, r) => s + r.width, 0)
    const rel: CompiledRelation = {
      table,
      alias: (alias ?? table).toLowerCase(),
      columnNames: t.columns.map((c) => c.name.toLowerCase()),
      columnTypes: t.columns.map((c) => c.type),
      offset,
      width: t.columns.length,
    }
    relations.push(rel)
    return rel
  }
  addRelation(stmt.from.table, stmt.from.alias)

  const joins: JoinSpec[] = []
  const residualConjuncts: Expr[] = []
  for (const j of stmt.joins) {
    if (j.type !== 'INNER') reason(`${j.type} JOIN`)
    if (!j.table) reason('a non-base-table JOIN source')
    if (j.lateral) reason('LATERAL JOIN')
    if (!j.on) reason('a JOIN without ON (CROSS-style)')
    const buildRelIndex = relations.length
    addRelation(j.table, j.alias)

    // Split ON into equi-key conjuncts (column = column, sides in distinct
    // relation groups) and residual predicates (re-checked after the probe).
    const conjuncts = splitAnd(j.on)
    const buildIdx: number[] = []
    const probeIdx: number[] = []
    for (const c of conjuncts) {
      const key = asEquiKey(c, relations, buildRelIndex)
      if (key) {
        buildIdx.push(key.buildIdx)
        probeIdx.push(key.probeIdx)
      } else {
        residualConjuncts.push(c)
      }
    }
    if (buildIdx.length === 0) reason('a JOIN with no usable equi-key (column = column)')
    joins.push({ rel: buildRelIndex, buildIdx, probeIdx })
  }

  const resolve = makeResolver(relations)
  const ctx: CompileCtx = { resolve }

  // WHERE = the original predicate AND any residual join conjuncts.
  const whereParts: Expr[] = []
  if (stmt.where) {
    if (hasUnsupported(stmt.where)) reason('a subquery/window in WHERE')
    if (containsAggregate(stmt.where)) reason('an aggregate in WHERE (use HAVING)')
    whereParts.push(stmt.where)
  }
  whereParts.push(...residualConjuncts)
  const where = whereParts.length ? compileExpr(andAll(whereParts), ctx) : null

  // Classify the projection: aggregate query or plain projection.
  const items = stmt.columns
  const hasStar = items.some((it) => it.expr.kind === 'star')
  const aggregateQuery = stmt.groupBy.length > 0 || items.some((it) => containsAggregate(it.expr))

  const columnNames: string[] = []
  let body: AggregatePlan | ProjectPlan

  if (aggregateQuery) {
    if (hasStar) reason('SELECT * with aggregation')
    for (const g of stmt.groupBy) {
      if (hasUnsupported(g) || containsAggregate(g)) reason('an unsupported GROUP BY key')
    }
    const groupKeys = stmt.groupBy.map((g) => compileExpr(g, ctx))
    const aggs: AggSpec[] = []
    const outputs: OutSpec[] = []
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      const e = it.expr
      columnNames.push(itemName(it, i))
      if (e.kind === 'star') reason('a bare * among aggregates')
      if (exprIsAggregate(e)) {
        outputs.push({ kind: 'agg', idx: aggs.length })
        aggs.push(makeAgg(e, relations, ctx))
      } else if (containsAggregate(e)) {
        reason('an expression computed over aggregate results')
      } else {
        const gi = stmt.groupBy.findIndex((g) => exprEqual(g, e))
        if (gi < 0) reason('a select item that is neither an aggregate nor a GROUP BY key')
        outputs.push({ kind: 'group', idx: gi })
      }
    }
    body = { kind: 'aggregate', groupKeys, aggs, outputs }
  } else {
    const projs: Evaluator[] = []
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      if (it.expr.kind === 'star') {
        if (it.expr.table) {
          const lt = it.expr.table.toLowerCase()
          const rel = relations.find((r) => r.alias === lt || r.table.toLowerCase() === lt)
          if (!rel) reason(`unknown table "${it.expr.table}"`)
          for (const c of rel.columnNames) {
            columnNames.push(c)
            projs.push(compileExpr({ kind: 'column', table: rel.alias, name: c }, ctx))
          }
        } else {
          for (const rel of relations) {
            for (const c of rel.columnNames) {
              columnNames.push(c)
              projs.push(compileExpr({ kind: 'column', table: rel.alias, name: c }, ctx))
            }
          }
        }
      } else {
        if (hasUnsupported(it.expr)) reason('a subquery/window in the select list')
        columnNames.push(itemName(it, projs.length))
        projs.push(compileExpr(it.expr, ctx))
      }
    }
    body = { kind: 'project', projs }
  }

  // ORDER BY must resolve to an output column (ordinal or structural match).
  const outItems = items.filter((it) => it.expr.kind !== 'star')
  for (const o of stmt.orderBy) {
    if (resolveOrderTarget(o.expr, columnNames, outItems) < 0) reason('an ORDER BY term not in the select list')
  }

  return {
    relations,
    joins,
    where,
    body,
    columnNames,
    orderBy: stmt.orderBy,
    limit: stmt.limit,
    offset: stmt.offset,
    outItems,
  }
}

function makeAgg(e: Extract<Expr, { kind: 'func' }>, relations: CompiledRelation[], ctx: CompileCtx): AggSpec {
  const name = e.name.toUpperCase()
  if (!['COUNT', 'SUM', 'AVG', 'MIN', 'MAX'].includes(name)) reason(`aggregate ${name}()`)
  if (e.distinct) reason('DISTINCT aggregates')
  if (e.filter) reason('aggregate FILTER (WHERE …)')
  if (e.withinGroup) reason('ordered-set aggregates')
  if (e.star) {
    if (name !== 'COUNT') reason(`${name}(*)`)
    return { name: 'COUNT', star: true, arg: null }
  }
  if (e.args.length !== 1) reason(`${name}() with ${e.args.length} arguments`)
  const arg = e.args[0]
  if (hasUnsupported(arg) || containsAggregate(arg)) reason(`an unsupported ${name}() argument`)
  // SUM/AVG must run on a plain INTEGER/REAL column so the float accumulation is
  // byte-for-byte identical to the interpreter (DECIMAL would sum exactly).
  if (name === 'SUM' || name === 'AVG') {
    if (arg.kind !== 'column') reason(`${name}() over a non-column expression`)
    const ri = relationOf(relations, arg)
    const ci = relations[ri].columnNames.indexOf(arg.name.toLowerCase())
    if (!NUMERIC.has(relations[ri].columnTypes[ci])) reason(`${name}() over a non-numeric column`)
  }
  return { name: name as AggName, star: false, arg: compileExpr(arg, ctx) }
}

/** A conjunct usable as an equi-join key, or null. Requires `col = col` with the
 *  two columns in disjoint relation groups (one entirely in already-bound
 *  relations < buildRel, the other entirely in the build relation). */
function asEquiKey(
  c: Expr,
  relations: CompiledRelation[],
  buildRel: number,
): { buildIdx: number; probeIdx: number } | null {
  if (c.kind !== 'binary' || c.op !== '=') return null
  if (c.left.kind !== 'column' || c.right.kind !== 'column') return null
  const lr = relationOf(relations, c.left)
  const rr = relationOf(relations, c.right)
  let buildCol: typeof c.left, probeCol: typeof c.left
  if (lr === buildRel && rr < buildRel) {
    buildCol = c.left
    probeCol = c.right
  } else if (rr === buildRel && lr < buildRel) {
    buildCol = c.right
    probeCol = c.left
  } else {
    return null
  }
  const build = relations[buildRel]
  const bi = build.columnNames.indexOf(buildCol.name.toLowerCase())
  const probeRel = relations[relationOf(relations, probeCol)]
  const pci = probeRel.columnNames.indexOf(probeCol.name.toLowerCase())
  // Key columns must be type-compatible under hashKey equality: both numeric, or
  // both the same non-numeric type. Otherwise fall back (residual recheck).
  const bt = build.columnTypes[bi]
  const pt = probeRel.columnTypes[pci]
  const compatible = (NUMERIC.has(bt) && NUMERIC.has(pt)) || bt === pt
  if (!compatible) return null
  return { buildIdx: bi, probeIdx: probeRel.offset + pci }
}

function splitAnd(e: Expr): Expr[] {
  if (e.kind === 'binary' && e.op === 'AND') return [...splitAnd(e.left), ...splitAnd(e.right)]
  return [e]
}
function andAll(parts: Expr[]): Expr {
  return parts.reduce((a, b) => ({ kind: 'binary', op: 'AND', left: a, right: b }))
}

/** Resolve an ORDER BY term to an output-column index (ordinal, by output name,
 *  or structurally equal to a select item). Returns -1 if unresolved. */
function resolveOrderTarget(term: Expr, columnNames: string[], outItems: SelectItem[]): number {
  if (term.kind === 'literal' && typeof term.value === 'number' && Number.isInteger(term.value)) {
    const ord = term.value - 1
    return ord >= 0 && ord < columnNames.length ? ord : -1
  }
  if (term.kind === 'column' && !term.table) {
    const i = columnNames.indexOf(term.name.toLowerCase())
    if (i >= 0) return i
  }
  for (let i = 0; i < outItems.length; i++) {
    if (outItems[i].alias && term.kind === 'column' && !term.table && term.name.toLowerCase() === outItems[i].alias!.toLowerCase()) return i
    if (exprEqual(term, outItems[i].expr)) return i
  }
  return -1
}

// --- code generation --------------------------------------------------------

function genSource(m: Matched): { source: string; pipeline: string[] } {
  const L: string[] = []
  const pipeline: string[] = []
  const combinedWidth = m.relations.reduce((s, r) => s + r.width, 0)
  const drive = m.relations[0]

  L.push('// === generated query pipeline (data-centric / push model) ===')
  L.push('const out = [];')
  L.push(`const cr = new Array(${combinedWidth}); // reusable combined-row buffer`)
  L.push('')

  // 1. Build a hash table for each joined relation.
  m.joins.forEach((j, k) => {
    const rel = m.relations[j.rel]
    pipeline.push(`Build hash table H${k} on ${rel.table}(${j.buildIdx.map((i) => rel.columnNames[i]).join(', ')}) — ${j.buildIdx.length === 1 ? 'single' : 'composite'} key`)
    L.push(`// --- build H${k}: hash ${rel.table} on its join key ---`)
    L.push(`const H${k} = new Map();`)
    L.push(`{`)
    L.push(`  const rows = rels[${j.rel}].rows;`)
    L.push(`  for (let i = 0; i < rows.length; i++) {`)
    L.push(`    const row = rows[i];`)
    L.push(`    const key = [${j.buildIdx.map((i) => `row[${i}]`).join(', ')}];`)
    L.push(`    if (${j.buildIdx.map((_, n) => `key[${n}] === null`).join(' || ')}) continue; // NULL never equi-joins`)
    L.push(`    const hk = R.hk(key);`)
    L.push(`    let b = H${k}.get(hk);`)
    L.push(`    if (b === undefined) { b = []; H${k}.set(hk, b); }`)
    L.push(`    b.push(row);`)
    L.push(`  }`)
    L.push(`}`)
    L.push('')
  })

  pipeline.push(`Scan ${drive.table} (driver) — ${m.joins.length} probe${m.joins.length === 1 ? '' : 's'} fused into the scan loop`)

  // 2. The driving scan + nested probes, indentation tracking the real brace
  //    depth: each join's probe loop nests one level deeper, so the body sits at
  //    the centre of all of them. (Left-deep: drive=depth 2, join k=depth 2+k.)
  const scan: string[] = []
  scan.push(`// --- drive: scan ${drive.table}, probe + fuse the rest ---`)
  scan.push(`{`)
  scan.push(`${ind(1)}const driveRows = rels[0].rows;`)
  scan.push(`${ind(1)}for (let i0 = 0; i0 < driveRows.length; i0++) {`)
  scan.push(`${ind(2)}const r0 = driveRows[i0];`)
  scan.push(`${ind(2)}for (let c = 0; c < ${drive.width}; c++) cr[${drive.offset} + c] = r0[c];`)

  m.joins.forEach((j, k) => {
    const rel = m.relations[j.rel]
    const d = 2 + k
    scan.push(`${ind(d)}// probe H${k}`)
    scan.push(`${ind(d)}const pk${k} = [${j.probeIdx.map((i) => `cr[${i}]`).join(', ')}];`)
    scan.push(`${ind(d)}if (${j.probeIdx.map((_, n) => `pk${k}[${n}] === null`).join(' || ')}) continue;`)
    scan.push(`${ind(d)}const m${k} = H${k}.get(R.hk(pk${k}));`)
    scan.push(`${ind(d)}if (m${k} === undefined) continue;`)
    scan.push(`${ind(d)}for (let j${k} = 0; j${k} < m${k}.length; j${k}++) {`)
    scan.push(`${ind(d + 1)}const rr${k} = m${k}[j${k}];`)
    scan.push(`${ind(d + 1)}for (let c = 0; c < ${rel.width}; c++) cr[${rel.offset} + c] = rr${k}[c];`)
  })

  const body: string[] = []
  if (m.where) {
    pipeline.push('Filter — WHERE re-checked on the joined row (predicate === TRUE)')
    body.push(`// WHERE (and any residual join predicate)`)
    body.push(`if (R.where(cr) !== true) continue;`)
  }

  if (m.body.kind === 'project') {
    pipeline.push(`Project ${m.body.projs.length} column${m.body.projs.length === 1 ? '' : 's'} → emit row`)
    const cols = m.body.projs.map((_, i) => `R.proj[${i}](cr)`).join(', ')
    body.push(`out.push([${cols}]);`)
  } else {
    pipeline.push(`Hash-aggregate — ${m.body.aggs.length} accumulator${m.body.aggs.length === 1 ? '' : 's'} over ${m.body.groupKeys.length} group key${m.body.groupKeys.length === 1 ? '' : 's'}`)
    body.push(...genAggregateBody(m.body))
  }

  // Body at depth (2 + njoins); then close each probe loop, the i0 loop, the block.
  const bodyDepth = 2 + m.joins.length
  for (const b of body) scan.push(b === '' ? '' : ind(bodyDepth) + b)
  for (let k = m.joins.length - 1; k >= 0; k--) scan.push(`${ind(2 + k)}}`)
  scan.push(`${ind(1)}}`)
  scan.push(`}`)

  const lines = [...L, ...scan]

  // 3. Aggregate finalize (runs after the scan loop closes).
  if (m.body.kind === 'aggregate') {
    lines.push('')
    lines.push(...genAggregateFinalize(m.body))
  }

  lines.push('')
  lines.push('return out;')
  return { source: lines.join('\n'), pipeline }
}

function genAggregateBody(plan: AggregatePlan): string[] {
  const b: string[] = []
  const noGroups = plan.groupKeys.length === 0
  if (noGroups) {
    // Single implicit group — created up front so an empty input still yields a
    // row (COUNT(*) = 0, SUM = NULL), matching the interpreter.
    b.push(`const g = G0;`)
  } else {
    b.push(`const gk = R.hk([${plan.groupKeys.map((_, i) => `R.groupKey[${i}](cr)`).join(', ')}]);`)
    b.push(`let g = groups.get(gk);`)
    b.push(`if (g === undefined) {`)
    b.push(`  g = newGroup([${plan.groupKeys.map((_, i) => `R.groupKey[${i}](cr)`).join(', ')}]);`)
    b.push(`  groups.set(gk, g); order.push(g);`)
    b.push(`}`)
  }
  plan.aggs.forEach((a, i) => {
    if (a.star) {
      b.push(`g.cnt${i}++; // COUNT(*)`)
    } else {
      b.push(`{ const v = R.aggArg[${i}](cr); if (v !== null) {`)
      switch (a.name) {
        case 'COUNT':
          b.push(`  g.cnt${i}++;`)
          break
        case 'SUM':
          b.push(`  g.sum${i} += +v; g.hv${i} = true;`)
          break
        case 'AVG':
          b.push(`  g.sum${i} += +v; g.cnt${i}++; g.hv${i} = true;`)
          break
        case 'MIN':
          b.push(`  if (!g.hv${i}) { g.mn${i} = v; g.hv${i} = true; } else if (R.cmp(v, g.mn${i}) < 0) g.mn${i} = v;`)
          break
        case 'MAX':
          b.push(`  if (!g.hv${i}) { g.mx${i} = v; g.hv${i} = true; } else if (R.cmp(v, g.mx${i}) > 0) g.mx${i} = v;`)
          break
      }
      b.push(`} }`)
    }
  })
  return b
}

function genAggregateFinalize(plan: AggregatePlan): string[] {
  const f: string[] = []
  const noGroups = plan.groupKeys.length === 0
  // Output-row assembly for one group `g`.
  const cells = plan.outputs.map((o) => {
    if (o.kind === 'group') return `g.k[${o.idx}]`
    const a = plan.aggs[o.idx]
    const i = o.idx
    switch (a.name) {
      case 'COUNT':
        return `g.cnt${i}`
      case 'SUM':
        return `(g.hv${i} ? g.sum${i} : null)`
      case 'AVG':
        return `(g.hv${i} ? g.sum${i} / g.cnt${i} : null)`
      case 'MIN':
        return `(g.hv${i} ? g.mn${i} : null)`
      case 'MAX':
        return `(g.hv${i} ? g.mx${i} : null)`
    }
  })
  if (noGroups) {
    f.push(`// finalize the single implicit group`)
    f.push(`{ const g = G0; out.push([${cells.join(', ')}]); }`)
  } else {
    f.push(`// finalize groups in first-seen order`)
    f.push(`for (let gi = 0; gi < order.length; gi++) { const g = order[gi]; out.push([${cells.join(', ')}]); }`)
  }
  return f
}

/** The group-state factory + the groups map, prepended before the scan loop. */
function genAggregatePrelude(plan: AggregatePlan): string[] {
  const inits = (keyArg: string): string => {
    const parts = [`k: ${keyArg}`]
    plan.aggs.forEach((a, i) => {
      if (a.name === 'COUNT' || a.name === 'AVG') parts.push(`cnt${i}: 0`)
      if (a.name === 'SUM' || a.name === 'AVG') parts.push(`sum${i}: 0`)
      if (a.name !== 'COUNT') parts.push(`hv${i}: false`)
      if (a.name === 'MIN') parts.push(`mn${i}: null`)
      if (a.name === 'MAX') parts.push(`mx${i}: null`)
    })
    return `{ ${parts.join(', ')} }`
  }
  const p: string[] = []
  p.push(`function newGroup(k) { return ${inits('k')}; }`)
  if (plan.groupKeys.length === 0) {
    p.push(`const G0 = newGroup([]);`)
  } else {
    p.push(`const groups = new Map();`)
    p.push(`const order = [];`)
  }
  p.push('')
  return p
}

function ind(depth: number): string {
  return '  '.repeat(depth)
}

// --- the public entry point -------------------------------------------------

export function prepareCompiled(stmt: SelectStmt, db: Database): { prepared: CompiledQuery } | { reason: string } {
  let m: Matched
  try {
    m = analyze(stmt, db)
  } catch (e) {
    if (e instanceof Unsupported) return { reason: e.message }
    return { reason: e instanceof Error ? e.message : String(e) }
  }

  const t0 = performance.now()
  const gen = genSource(m)
  // Splice the aggregate prelude (state factory + maps) in right after the
  // buffer declaration so the generated source reads top-to-bottom.
  let source = gen.source
  if (m.body.kind === 'aggregate') {
    const prelude = genAggregatePrelude(m.body).join('\n')
    source = source.replace('// === generated query pipeline (data-centric / push model) ===\n', `// === generated query pipeline (data-centric / push model) ===\n${prelude}\n`)
  }

  let fn: CompiledFn
  try {
    fn = new Function('rels', 'R', source) as unknown as CompiledFn
  } catch (e) {
    return { reason: `codegen produced invalid JS: ${e instanceof Error ? e.message : String(e)}` }
  }
  const compileMs = performance.now() - t0

  const runtime: Runtime = {
    hk: hashKey,
    cmp: orderValues,
    where: m.where,
    groupKey: m.body.kind === 'aggregate' ? m.body.groupKeys : [],
    aggArg: m.body.kind === 'aggregate' ? m.body.aggs.map((a) => a.arg) : [],
    proj: m.body.kind === 'project' ? m.body.projs : [],
  }

  const prepared: CompiledQuery = {
    source,
    compileMs,
    columnNames: m.columnNames,
    relations: m.relations,
    kind: m.body.kind,
    pipeline: gen.pipeline,
    gather(database: Database): RelData[] {
      return m.relations.map((r) => ({ rows: [...database.getTable(r.table).heap.values()] }))
    },
    exec(rels: RelData[]): CompileRunResult {
      const t1 = performance.now()
      let rows = fn(rels, runtime)
      rows = applyOrderLimit(rows, m)
      const execMs = performance.now() - t1
      const inputRows = rels.reduce((s, r) => s + r.rows.length, 0)
      return { rows, columnNames: m.columnNames, inputRows, outputRows: rows.length, execMs }
    },
    run(database: Database): CompileRunResult {
      return this.exec(this.gather(database))
    },
  }
  return { prepared }
}

function applyOrderLimit(rows: Row[], m: Matched): Row[] {
  if (m.orderBy.length) {
    const keys = m.orderBy
      .map((o) => ({ col: resolveOrderTarget(o.expr, m.columnNames, m.outItems), dir: o.dir === 'DESC' ? -1 : 1 }))
      .filter((k) => k.col >= 0)
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
  const offset = m.offset ?? 0
  if (offset > 0 || m.limit !== undefined) {
    const end = m.limit !== undefined ? offset + m.limit : rows.length
    rows = rows.slice(offset, end)
  }
  return rows
}
