// The what-if Index Advisor.
//
// Given a SELECT, the advisor enumerates *candidate* indexes from the query's
// sargable equalities, range bounds, equijoin keys and ORDER BY columns, then —
// for each candidate — builds the index **hypothetically** (a genuine, backfilled
// B+Tree so the planner costs it for real, but retracted the instant the plan has
// been costed, so your database is never actually changed), re-plans the query,
// and keeps only the candidates the planner *actually adopts* at a lower cost.
//
// This is exactly the loop a DBA's index-tuning tool runs — PostgreSQL's HypoPG,
// SQL Server's Database Engine Tuning Advisor — distilled to its essence. It
// leans entirely on the existing cost-based planner: the advisor never re-implements
// costing, it just asks "what would the optimizer do with this index?" and reads
// the answer off the plan it gets back.

import { parse } from './parser'
import { planSelect } from './planner'
import type { PlanNode } from './operators'
import { Database, Table } from './catalog'
import type { SelectStmt, FromItem, JoinClause, Expr, ColumnExpr } from './ast'

export interface IndexRecommendation {
  /** A ready-to-run `CREATE INDEX` statement. */
  ddl: string
  table: string
  columns: string[]
  /** Why this column-set was a candidate (the predicate shape that suggested it). */
  reason: string
  baselineCost: number
  newCost: number
  /** Percent the estimated plan cost dropped, 0..100. */
  improvementPct: number
  /** Whether the planner actually switched to using the index (we only ever
   *  recommend adopted, cost-lowering indexes). */
  adopted: boolean
  beforePlan: PlanNode
  afterPlan: PlanNode
}

export interface AdviceResult {
  ok: boolean
  /** Set when `ok` is false (e.g. the statement wasn't a single SELECT). */
  message?: string
  sql: string
  baselineCost: number
  baselinePlan: PlanNode
  /** Adopted, cost-lowering recommendations, best improvement first. */
  recommendations: IndexRecommendation[]
  /** How many distinct candidate column-sets were costed. */
  candidatesConsidered: number
  /** Candidate column-sets skipped because an index already covers them. */
  alreadyIndexed: string[]
}

// A base relation in the query: its alias and the underlying Table. Subqueries,
// CTEs and table functions are skipped — you can't index a derived relation.
interface Relation {
  alias: string
  table: Table
}

/** Map every base-table relation in the query to its alias. CTE names shadow base
 *  tables, so a `WITH t AS (…)` reference to `t` is *not* a base relation. */
function baseRelations(stmt: SelectStmt, db: Database): Relation[] {
  const cteNames = new Set((stmt.ctes ?? []).map((c) => c.name.toLowerCase()))
  const out: Relation[] = []
  const consider = (item: FromItem | JoinClause) => {
    if (!item.table || item.subquery || item.tableFunc) return
    if (cteNames.has(item.table.toLowerCase())) return
    if (!db.hasTable(item.table)) return
    out.push({ alias: (item.alias ?? item.table).toLowerCase(), table: db.getTable(item.table) })
  }
  if (stmt.from) consider(stmt.from)
  for (const j of stmt.joins) consider(j)
  return out
}

/** Resolve a column reference to the single base relation that owns it. Qualified
 *  refs use the alias; unqualified refs resolve only when exactly one relation has
 *  the column (otherwise it's ambiguous and we skip it). */
function ownerOf(col: ColumnExpr, rels: Relation[]): Relation | null {
  if (col.table) {
    const r = rels.find((x) => x.alias === col.table!.toLowerCase())
    return r && r.table.columnIndex(col.name) >= 0 ? r : null
  }
  const owners = rels.filter((x) => x.table.columnIndex(col.name) >= 0)
  return owners.length === 1 ? owners[0] : null
}

const SARGABLE_CMP = new Set(['=', '<', '<=', '>', '>='])

function isConst(e: Expr): boolean {
  // A literal, a parameter-free constant, or a negative number literal.
  return (
    e.kind === 'literal' ||
    (e.kind === 'unary' && e.op === '-' && e.expr.kind === 'literal') ||
    e.kind === 'cast'
  )
}

/** Walk an AND-tree of predicates, calling `visit` on each conjunct. */
function conjuncts(e: Expr | undefined, visit: (p: Expr) => void) {
  if (!e) return
  if (e.kind === 'binary' && e.op === 'AND') {
    conjuncts(e.left, visit)
    conjuncts(e.right, visit)
  } else {
    visit(e)
  }
}

// Per-relation collected columns, kept distinct and tagged by how they'd be used:
// equalities first (the most selective, and the prefix of any composite), then
// range/order columns (useful as a trailing index column).
interface ColumnBag {
  eq: Set<string>
  range: Set<string>
  order: Set<string>
  join: Set<string>
}

function emptyBag(): ColumnBag {
  return { eq: new Set(), range: new Set(), order: new Set(), join: new Set() }
}

/** Collect, per relation alias, the columns that could benefit from an index. */
function collectColumns(stmt: SelectStmt, rels: Relation[]): Map<string, ColumnBag> {
  const bags = new Map<string, ColumnBag>()
  const bagFor = (r: Relation) => {
    let b = bags.get(r.alias)
    if (!b) bags.set(r.alias, (b = emptyBag()))
    return b
  }
  const note = (col: ColumnExpr, kind: keyof ColumnBag) => {
    const r = ownerOf(col, rels)
    if (r) bagFor(r)[kind].add(col.name.toLowerCase())
  }

  // WHERE + JOIN ON conjuncts.
  const predicates: Expr[] = []
  conjuncts(stmt.where, (p) => predicates.push(p))
  for (const j of stmt.joins) conjuncts(j.on, (p) => predicates.push(p))

  for (const p of predicates) {
    if (p.kind === 'binary' && SARGABLE_CMP.has(p.op)) {
      const l = p.left
      const r = p.right
      if (l.kind === 'column' && r.kind === 'column') {
        // An equijoin key on both sides — index either side's key.
        if (p.op === '=') {
          note(l, 'join')
          note(r, 'join')
        }
      } else if (l.kind === 'column' && isConst(r)) {
        note(l, p.op === '=' ? 'eq' : 'range')
      } else if (r.kind === 'column' && isConst(l)) {
        note(r, p.op === '=' ? 'eq' : 'range')
      }
    } else if (p.kind === 'between' && p.expr.kind === 'column') {
      note(p.expr, 'range')
    } else if (p.kind === 'in' && !p.negated && p.expr.kind === 'column') {
      // `x IN (1,2,3)` is a disjunction of equalities — an index on x helps.
      note(p.expr, 'eq')
    }
  }

  // ORDER BY leading columns — an index can supply the sort order for free.
  for (const o of stmt.orderBy) if (o.expr.kind === 'column') note(o.expr, 'order')

  return bags
}

/** Does any existing index on `table` lead with exactly `columns` (as a prefix)? */
function alreadyCovered(table: Table, columns: string[]): boolean {
  const want = columns.map((c) => c.toLowerCase())
  for (const idx of table.allIndexes()) {
    const have = idx.meta.columns.map((c) => c.toLowerCase())
    if (have.length >= want.length && want.every((c, i) => have[i] === c)) return true
  }
  return false
}

/** Build the candidate column-sets for one relation from its collected columns:
 *  each single column, plus a couple of leading-equality composites (the classic
 *  "equality columns first, then a range/order column" shape). */
function candidateColumnSets(bag: ColumnBag): { columns: string[]; reason: string }[] {
  const out: { columns: string[]; reason: string }[] = []
  const seen = new Set<string>()
  const push = (columns: string[], reason: string) => {
    const key = columns.join(',')
    if (columns.length === 0 || seen.has(key)) return
    seen.add(key)
    out.push({ columns, reason })
  }

  const eq = [...bag.eq]
  const range = [...bag.range]
  const order = [...bag.order]
  const join = [...bag.join]

  for (const c of eq) push([c], `equality filter on ${c}`)
  for (const c of join) push([c], `equijoin key ${c}`)
  for (const c of range) push([c], `range filter on ${c}`)
  for (const c of order) push([c], `ORDER BY ${c}`)

  // Composite: all equality columns together (covers a multi-equality predicate
  // in one B+Tree probe), and equality-prefix + one range/order column.
  if (eq.length >= 2) push(eq.slice(0, 3), `multi-equality on (${eq.slice(0, 3).join(', ')})`)
  if (eq.length >= 1 && range.length >= 1) {
    push([...eq.slice(0, 2), range[0]], `equality on ${eq[0]} then range on ${range[0]}`)
  }
  if (eq.length >= 1 && order.length >= 1 && !eq.includes(order[0])) {
    push([...eq.slice(0, 2), order[0]], `equality on ${eq[0]} then ORDER BY ${order[0]}`)
  }
  return out
}

let hypoCounter = 0

/**
 * Recommend indexes for a SELECT. Returns the baseline plan/cost and, for every
 * candidate the planner would actually adopt at a lower cost, a recommendation
 * with the before/after plans and the cost delta.
 */
export function adviseIndexes(db: Database, sql: string): AdviceResult {
  let stmt: SelectStmt
  try {
    const stmts = parse(sql)
    if (stmts.length !== 1) {
      return fail(sql, 'Paste exactly one SELECT statement to advise on.')
    }
    let s = stmts[0]
    if (s.kind === 'explain') s = s.statement
    if (s.kind !== 'select') {
      return fail(sql, 'The index advisor only analyzes SELECT statements.')
    }
    stmt = s
  } catch (err) {
    return fail(sql, err instanceof Error ? err.message : String(err))
  }

  // Baseline plan + cost (the plan you get today, with the indexes you have).
  let baselinePlan: PlanNode
  try {
    baselinePlan = planSelect(stmt, db).plan()
  } catch (err) {
    return fail(sql, err instanceof Error ? err.message : String(err))
  }
  const baselineCost = baselinePlan.estCost

  const rels = baseRelations(stmt, db)
  const bags = collectColumns(stmt, rels)

  const recommendations: IndexRecommendation[] = []
  const alreadyIndexed: string[] = []
  let candidatesConsidered = 0

  for (const rel of rels) {
    const bag = bags.get(rel.alias)
    if (!bag) continue
    for (const cand of candidateColumnSets(bag)) {
      if (alreadyCovered(rel.table, cand.columns)) {
        alreadyIndexed.push(`${rel.table.name}(${cand.columns.join(', ')})`)
        continue
      }
      candidatesConsidered++
      const rec = costWithIndex(db, stmt, rel.table, cand.columns, cand.reason, baselineCost, baselinePlan)
      if (rec && rec.adopted && rec.newCost < baselineCost - 1e-9) recommendations.push(rec)
    }
  }

  // Best improvement first; de-duplicate by the index it would create (a column
  // can be reached as both an equality and a join key — keep the better verdict).
  recommendations.sort((a, b) => b.improvementPct - a.improvementPct)
  const deduped: IndexRecommendation[] = []
  const seenDdl = new Set<string>()
  for (const r of recommendations) {
    const key = `${r.table}(${r.columns.join(',')})`
    if (seenDdl.has(key)) continue
    seenDdl.add(key)
    deduped.push(r)
  }

  return {
    ok: true,
    sql,
    baselineCost,
    baselinePlan,
    recommendations: deduped,
    candidatesConsidered,
    alreadyIndexed: [...new Set(alreadyIndexed)],
  }
}

/** Cost the query with one hypothetical index built on `table(columns)`. The
 *  index is created (genuinely, so the planner costs it faithfully), the plan is
 *  read, and the index is dropped — leaving the database exactly as it was. */
function costWithIndex(
  db: Database,
  stmt: SelectStmt,
  table: Table,
  columns: string[],
  reason: string,
  baselineCost: number,
  baselinePlan: PlanNode,
): IndexRecommendation | null {
  const name = `__hypo_${++hypoCounter}`
  let afterPlan: PlanNode
  try {
    table.createIndex(name, columns, false)
  } catch {
    return null // e.g. a column type that can't be indexed — skip the candidate.
  }
  try {
    afterPlan = planSelect(stmt, db).plan()
  } catch {
    return null
  } finally {
    table.dropIndex(name)
  }

  const adopted = planUsesIndex(afterPlan, name)
  const newCost = afterPlan.estCost
  const improvementPct = baselineCost > 0 ? Math.max(0, ((baselineCost - newCost) / baselineCost) * 100) : 0
  return {
    ddl: `CREATE INDEX idx_${table.name}_${columns.join('_')} ON ${table.name} (${columns.join(', ')});`,
    table: table.name,
    columns,
    reason,
    baselineCost,
    newCost,
    improvementPct,
    adopted,
    beforePlan: baselinePlan,
    afterPlan,
  }
}

/** Did the planner actually pick the hypothetical index (by name) anywhere in
 *  the plan tree? We only recommend indexes the optimizer would really use. */
function planUsesIndex(node: PlanNode, indexName: string): boolean {
  const needle = indexName.toLowerCase()
  const hit = (n: PlanNode): boolean => {
    if (n.detail.toLowerCase().includes(needle)) return true
    for (const ex of n.extra) if (ex.toLowerCase().includes(needle)) return true
    return n.children.some(hit)
  }
  return hit(node)
}

function fail(sql: string, message: string): AdviceResult {
  return {
    ok: false,
    message,
    sql,
    baselineCost: 0,
    baselinePlan: { op: 'Result', detail: '', estRows: 0, estCost: 0, actualRows: 0, extra: [], children: [] },
    recommendations: [],
    candidatesConsidered: 0,
    alreadyIndexed: [],
  }
}
