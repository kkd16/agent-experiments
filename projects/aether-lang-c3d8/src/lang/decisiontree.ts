// Aether — compiling pattern matching to *good decision trees* (Maranget, 2008).
//
// The naive `match` compiler (see `compiler.ts`) lowers each arm independently:
// it flattens the arm's pattern into a flat list of tests and re-navigates the
// scrutinee from scratch, so two arms that share a constructor prefix
// (`Cons a (Cons b r)` then `Cons a Nil`) **re-test that outer `Cons` twice**.
//
// This pass rewrites a multi-arm, nested `match` into an equivalent **decision
// tree** that tests each scrutinee position *once*, sharing the decision across
// every arm that needs it. Crucially it is a **core-to-core** transformation —
// it lowers a complex `match` into a tree of *single-column* `match`es (one head
// test per node) plus `let`-bound join-points for shared arm bodies — so the
// bytecode VM, the JavaScript backend and the WebAssembly backend all compile
// the result with **zero changes**, and the project's byte-for-byte equivalence
// checks re-prove that the answer never changed.
//
// Algorithm (Maranget's "Compiling Pattern Matching to Good Decision Trees"):
// a pattern *matrix* whose columns are aligned with a vector of *occurrences*
// (core expressions — here always variables — naming the sub-values matched so
// far). `compile(occs, rows)`:
//   • no rows                        ⇒ failure (a `match` that runs to MATCH_FAIL)
//   • row 0 all-irrefutable          ⇒ a leaf: bind its vars and run its body
//                                       (a `when` guard falls through to the rest)
//   • otherwise                      ⇒ pick a column whose row-0 pattern is
//                                       refutable (the one tested by the most rows,
//                                       to maximise sharing) and **switch** on its
//                                       occurrence: one arm per head constructor
//                                       present, the matrix *specialized* for each.
//
// Guards keep the naive "first matching, guard-passing arm wins" semantics: a
// guarded leaf becomes `if g then body else <compile the rest>`, and a
// non-exhaustive switch is emitted *without* a default arm so it MATCH_FAILs at
// runtime exactly where the source would.

import type { Expr, MatchCase, Pattern } from './ast.ts'
import type { Span } from './lexer.ts'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Per-match statistics, accumulated across every `match` the pass rewrites. */
export interface DtStats {
  /** matches rewritten into decision trees */
  matchesCompiled: number
  /** total switch (head-test) nodes generated */
  switches: number
  /** leaf (arm-body) nodes generated */
  leaves: number
  /** shared arm bodies lifted into join-point lambdas (avoiding code blow-up) */
  joinPoints: number
  /** pattern tests the *naive* compiler would perform (one per refutable node,
   *  summed over arms — tuples don't test, only navigate) */
  naiveTests: number
  /** decision-tree test nodes (switches that actually test a tag/literal) */
  treeTests: number
}

/** A serializable view of one compiled match's decision tree, for the UI. */
export interface DtView {
  span: Span
  arms: number
  naiveTests: number
  treeTests: number
  root: DtViewNode
}
export type DtViewNode =
  | { t: 'switch'; occ: string; tests: boolean; arms: DtViewArm[]; fallback: DtViewNode | null }
  | { t: 'leaf'; row: number; guard: boolean; binds: [string, string][] }
  | { t: 'fail' }
export interface DtViewArm {
  label: string
  sub: string[]
  child: DtViewNode
}

export interface DecisionTreeResult {
  expr: Expr
  changed: boolean
  stats: DtStats
  /** one entry per rewritten match, in source order */
  views: DtView[]
}

export interface DtContext {
  /** ctorName -> arity (every constructor declared in the program) */
  ctors: Map<string, number>
  /** ctorName -> the full set of sibling constructor names of its type */
  siblings: Map<string, Set<string>>
}

/** Build the constructor → sibling-set map from every `type` declaration. */
export function collectSiblings(root: Expr): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>()
  const walk = (e: Expr): void => {
    if (e.kind === 'typedecl') {
      const names = new Set(e.ctors.map((c) => c.name))
      for (const c of e.ctors) m.set(c.name, names)
    }
    for (const c of childrenOf(e)) walk(c)
  }
  walk(root)
  return m
}

/**
 * Rewrite every "worthwhile" `match` in `root` into a decision tree. Bottom-up,
 * so a match nested inside an arm body is compiled before the match that
 * contains it. Returns the new program plus stats and per-match tree views.
 */
export function compileMatches(root: Expr, ctx: DtContext): DecisionTreeResult {
  fresh = 0
  const stats: DtStats = {
    matchesCompiled: 0,
    switches: 0,
    leaves: 0,
    joinPoints: 0,
    naiveTests: 0,
    treeTests: 0,
  }
  const views: DtView[] = []
  const compiler = new MatchCompiler(ctx, stats)

  const rec = (e: Expr): Expr => {
    // first rewrite children (bottom-up)
    const e2 = mapChildren(e, rec)
    if (e2.kind === 'match' && worthDecisionTree(e2.cases, ctx)) {
      const out = compiler.lowerMatch(e2)
      if (out) {
        stats.matchesCompiled++
        views.push(out.view)
        return out.expr
      }
    }
    return e2
  }

  const expr = rec(root)
  return { expr, changed: stats.matchesCompiled > 0, stats, views }
}

// ---------------------------------------------------------------------------
// Heuristic: is a decision tree worth building for this match?
// ---------------------------------------------------------------------------
//
// The naive compiler is already optimal for a *flat* match — distinct
// single-level head patterns, no nesting (a plain `Option`/enum dispatch). A
// decision tree only saves work when arms **share a head constructor** (so the
// naive compiler re-tests it) or a pattern is **nested** (so a sub-value is
// re-navigated). Skipping the rest avoids needless churn (and keeps the prelude's
// simple matches byte-identical to before).

function worthDecisionTree(cases: MatchCase[], ctx: DtContext): boolean {
  // nesting: a refutable pattern directly inside a constructor/cons/tuple pattern
  for (const c of cases) if (hasNestedRefutable(c.pattern)) return true
  // shared head: two arms whose top pattern tests the same constructor
  const heads = new Map<string, number>()
  for (const c of cases) {
    const k = topHeadKey(c.pattern)
    if (k === null) continue // irrefutable top (a later catch-all) — not a test
    heads.set(k, (heads.get(k) ?? 0) + 1)
    if (heads.get(k)! >= 2) return true
  }
  // a constructor whose type has > 1 sibling but only one arm here is still flat;
  // genuine sharing requires the conditions above.
  void ctx
  return false
}

function isRefutable(p: Pattern): boolean {
  return p.kind !== 'pwild' && p.kind !== 'pvar' && p.kind !== 'punit'
}

function hasNestedRefutable(p: Pattern): boolean {
  switch (p.kind) {
    case 'pcons':
      return isRefutable(p.head) || isRefutable(p.tail)
    case 'ptuple':
      return p.elements.some(isRefutable)
    case 'pcon':
      return p.args.some(isRefutable)
    default:
      return false
  }
}

/** A stable key for a pattern's top head constructor (null if irrefutable). */
function topHeadKey(p: Pattern): string | null {
  switch (p.kind) {
    case 'pwild':
    case 'pvar':
    case 'punit':
      return null
    case 'pint':
      return 'i' + p.value
    case 'pfloat':
      return 'f' + p.value
    case 'pbool':
      return 'b' + p.value
    case 'pstr':
      return 's' + JSON.stringify(p.value)
    case 'pnil':
      return 'nil'
    case 'pcons':
      return 'cons'
    case 'ptuple':
      return 'tuple' + p.elements.length
    case 'pcon':
      return 'C' + p.name
  }
}

// ---------------------------------------------------------------------------
// Fresh occurrence / join-point names. `$`-prefixed identifiers can't be
// produced by the lexer, so they never collide with source; the `dt`/`arm`/`grd`
// infixes keep them distinct from the optimizer's `$opt_` and the elaborator's
// `$d_`. Reset per pass for deterministic output.
// ---------------------------------------------------------------------------

let fresh = 0
function gensym(base: string): string {
  return `$${base}_${fresh++}`
}

const SYNTH: Span = { start: 0, end: 0, line: 0, col: 0 }
const v = (name: string, span: Span = SYNTH): Expr => ({ kind: 'var', name, span })
const pv = (name: string, span: Span = SYNTH): Pattern => ({ kind: 'pvar', name, span })

// ---------------------------------------------------------------------------
// The matrix compiler
// ---------------------------------------------------------------------------

/** A description of a column's head constructor, used to group & specialize. */
type Head =
  | { sort: 'con'; key: string; name: string; arity: number }
  | { sort: 'cons'; key: 'cons'; arity: 2 }
  | { sort: 'nil'; key: 'nil'; arity: 0 }
  | { sort: 'tuple'; key: string; arity: number }
  | { sort: 'lit'; key: string; pat: Pattern; arity: 0 }

/** A matrix row: one pattern per current column, plus the bindings accumulated
 *  so far (source pattern-var ↦ occurrence variable) and the originating arm. */
interface Row {
  cols: Pattern[]
  binds: [string, string][]
  index: number
}

/** The abstract decision tree (lowered to core by `lower`). */
type Tree =
  | { kind: 'fail' }
  | { kind: 'leaf'; row: number; binds: [string, string][]; guarded: boolean; fallback: Tree | null }
  | { kind: 'switch'; occ: string; tests: boolean; arms: TreeArm[]; fallback: Tree | null }
interface TreeArm {
  head: Head
  subOccs: string[]
  child: Tree
}

class MatchCompiler {
  /** per-arm guard / body / parameter order, indexed by arm number */
  private arms: { guard?: Expr; body: Expr; params: string[] }[] = []
  private ctx: DtContext
  private stats: DtStats

  constructor(ctx: DtContext, stats: DtStats) {
    this.ctx = ctx
    this.stats = stats
  }

  lowerMatch(e: Extract<Expr, { kind: 'match' }>): { expr: Expr; view: DtView } | null {
    this.arms = e.cases.map((c) => ({
      guard: c.guard,
      body: c.body,
      params: patternVarOrder(c.pattern),
    }))
    const o0 = gensym('m')
    const rows: Row[] = e.cases.map((c, i) => ({ cols: [c.pattern], binds: [], index: i }))
    const tree = this.compile([o0], rows)

    // count how many leaves reference each arm, so a body reached from a single
    // leaf is inlined and a body reached from several is shared via a join-point.
    const uses = new Map<number, number>()
    countRowUses(tree, uses)

    // lower the tree to core
    const lowered = this.lower(tree, uses)

    // bind the scrutinee once (it must be evaluated exactly once), then the
    // shared-arm join-points, then the tree.
    let body = lowered
    for (const [i, jp] of this.joinPoints) {
      body = { kind: 'let', name: jpName(i), value: jp, body, recursive: false, span: e.span }
      this.stats.joinPoints++
    }
    if (this.guardPoints.size > 0) {
      for (const [i, jp] of this.guardPoints) {
        body = { kind: 'let', name: grdName(i), value: jp, body, recursive: false, span: e.span }
      }
    }
    body = { kind: 'let', name: o0, value: e.scrutinee, body, recursive: false, span: e.span }

    // statistics + a serializable view for the panel
    const naiveTests = e.cases.reduce((n, c) => n + refutableCount(c.pattern), 0)
    this.stats.naiveTests += naiveTests
    const view: DtView = {
      span: e.span,
      arms: e.cases.length,
      naiveTests,
      treeTests: countSwitches(tree, true),
      root: viewOf(tree),
    }
    this.stats.treeTests += view.treeTests
    this.joinPoints.clear()
    this.guardPoints.clear()
    return { expr: body, view }
  }

  // join-point lambdas keyed by arm index (only for arms shared by >1 leaf)
  private joinPoints = new Map<number, Expr>()
  private guardPoints = new Map<number, Expr>()

  /** The Maranget matrix algorithm. */
  private compile(occs: string[], rows: Row[]): Tree {
    if (rows.length === 0) return { kind: 'fail' }

    const row0 = rows[0]
    // base case: row 0 matches unconditionally (every column irrefutable).
    if (row0.cols.every((p) => !isRefutable(p))) {
      const binds = [...row0.binds]
      row0.cols.forEach((p, i) => {
        if (p.kind === 'pvar') binds.push([p.name, occs[i]])
      })
      const guarded = this.arms[row0.index].guard !== undefined
      this.stats.leaves++
      return {
        kind: 'leaf',
        row: row0.index,
        binds,
        guarded,
        // a failing guard falls through to the rest of the (still-live) matrix
        fallback: guarded ? this.compile(occs, rows.slice(1)) : null,
      }
    }

    // choose the column to switch on: among columns where row 0 is refutable,
    // the one with the most refutable rows (Maranget's "branching"/sharing
    // heuristic), breaking ties leftmost.
    const i = this.chooseColumn(occs, rows)
    const occ = occs[i]

    // gather the distinct head constructors present in column i (source order).
    const order: string[] = []
    const headByKey = new Map<string, Head>()
    for (const r of rows) {
      const p = r.cols[i]
      if (!isRefutable(p)) continue
      const h = this.headOf(p)
      if (!headByKey.has(h.key)) {
        headByKey.set(h.key, h)
        order.push(h.key)
      }
    }

    const arms: TreeArm[] = []
    let testsTag = false
    for (const key of order) {
      const h = headByKey.get(key)!
      if (h.sort !== 'tuple') testsTag = true
      const subOccs: string[] = []
      for (let k = 0; k < h.arity; k++) subOccs.push(gensym('o'))
      const newOccs = splice(occs, i, subOccs)
      const spec = this.specialize(rows, i, h, occ, subOccs.length)
      arms.push({ head: h, subOccs, child: this.compile(newOccs, spec) })
    }

    // default matrix: rows with a var/wildcard in column i (column removed).
    const def: Row[] = []
    for (const r of rows) {
      const p = r.cols[i]
      if (isRefutable(p)) continue
      const binds = p.kind === 'pvar' ? [...r.binds, [p.name, occ] as [string, string]] : r.binds
      def.push({ cols: removeAt(r.cols, i), binds, index: r.index })
    }

    const complete = this.signatureComplete(order, headByKey)
    let fallback: Tree | null
    if (complete) {
      // every value hits a constructor arm (default rows already propagated into
      // each via specialization) — no default arm needed.
      fallback = null
    } else {
      const ftree = this.compile(removeAt(occs, i), def)
      // a `fail` fallback ⇒ omit the default arm so the lowered switch is
      // non-exhaustive and MATCH_FAILs at runtime exactly as the source did.
      fallback = ftree.kind === 'fail' ? null : ftree
    }

    this.stats.switches++
    return { kind: 'switch', occ, tests: testsTag, arms, fallback }
  }

  private chooseColumn(occs: string[], rows: Row[]): number {
    const row0 = rows[0]
    let best = -1
    let bestScore = -1
    for (let i = 0; i < occs.length; i++) {
      if (!isRefutable(row0.cols[i])) continue
      let score = 0
      for (const r of rows) if (isRefutable(r.cols[i])) score++
      if (score > bestScore) {
        bestScore = score
        best = i
      }
    }
    return best
  }

  /** The head descriptor of a refutable pattern. */
  private headOf(p: Pattern): Head {
    switch (p.kind) {
      case 'pcon':
        return { sort: 'con', key: 'C' + p.name, name: p.name, arity: p.args.length }
      case 'pcons':
        return { sort: 'cons', key: 'cons', arity: 2 }
      case 'pnil':
        return { sort: 'nil', key: 'nil', arity: 0 }
      case 'ptuple':
        return { sort: 'tuple', key: 'tuple' + p.elements.length, arity: p.elements.length }
      case 'pint':
        return { sort: 'lit', key: 'i' + p.value, pat: p, arity: 0 }
      case 'pfloat':
        return { sort: 'lit', key: 'f' + p.value, pat: p, arity: 0 }
      case 'pbool':
        return { sort: 'lit', key: 'b' + p.value, pat: p, arity: 0 }
      case 'pstr':
        return { sort: 'lit', key: 's' + JSON.stringify(p.value), pat: p, arity: 0 }
      default:
        throw new Error('decisiontree: irrefutable pattern has no head')
    }
  }

  /** Specialize the matrix for head `h` at column `i`. */
  private specialize(rows: Row[], i: number, h: Head, occ: string, arity: number): Row[] {
    const out: Row[] = []
    for (const r of rows) {
      const p = r.cols[i]
      if (!isRefutable(p)) {
        // var/wildcard: matches this head; expand to `arity` wildcards.
        const binds =
          p.kind === 'pvar' ? [...r.binds, [p.name, occ] as [string, string]] : r.binds
        out.push({ cols: splice(r.cols, i, wildcards(arity, p.span)), binds, index: r.index })
        continue
      }
      if (this.headOf(p).key !== h.key) continue // a different head — drop
      out.push({ cols: splice(r.cols, i, subPatterns(p)), binds: r.binds, index: r.index })
    }
    return out
  }

  /** Does the set of present heads cover the whole type of the column? */
  private signatureComplete(order: string[], heads: Map<string, Head>): boolean {
    if (order.length === 0) return false
    const first = heads.get(order[0])!
    switch (first.sort) {
      case 'tuple':
        return true // a tuple type has exactly one shape
      case 'lit':
        // booleans are the only finite literal signature
        if (first.key === 'b' + true || first.key === 'b' + false) {
          return heads.has('b' + true) && heads.has('b' + false)
        }
        return false // ints / floats / strings: effectively infinite
      case 'nil':
      case 'cons':
        return heads.has('nil') && heads.has('cons')
      case 'con': {
        const sibs = this.ctx.siblings.get(first.name)
        if (!sibs) return false
        for (const s of sibs) if (!heads.has('C' + s)) return false
        return true
      }
    }
  }

  // -------------------------------------------------------------------------
  // Lowering the abstract tree to core
  // -------------------------------------------------------------------------

  private lower(t: Tree, uses: Map<number, number>): Expr {
    switch (t.kind) {
      case 'fail':
        return failExpr()
      case 'leaf': {
        const action = this.leafAction(t.row, t.binds, uses)
        if (!t.guarded) return action
        const guard = this.leafGuard(t.row, t.binds, uses)
        const fallthrough = t.fallback ? this.lower(t.fallback, uses) : failExpr()
        return { kind: 'if', cond: guard, then: action, else: fallthrough, span: SYNTH }
      }
      case 'switch': {
        const cases: MatchCase[] = t.arms.map((a) => ({
          pattern: this.armPattern(a),
          body: this.lower(a.child, uses),
        }))
        if (t.fallback) {
          cases.push({ pattern: { kind: 'pwild', span: SYNTH }, body: this.lower(t.fallback, uses) })
        }
        return { kind: 'match', scrutinee: v(t.occ), cases, span: SYNTH }
      }
    }
  }

  /** The constructor pattern for a switch arm, binding the sub-occurrences. */
  private armPattern(a: TreeArm): Pattern {
    const h = a.head
    switch (h.sort) {
      case 'con':
        return { kind: 'pcon', name: h.name, args: a.subOccs.map((o) => pv(o)), span: SYNTH }
      case 'cons':
        return { kind: 'pcons', head: pv(a.subOccs[0]), tail: pv(a.subOccs[1]), span: SYNTH }
      case 'nil':
        return { kind: 'pnil', span: SYNTH }
      case 'tuple':
        return { kind: 'ptuple', elements: a.subOccs.map((o) => pv(o)), span: SYNTH }
      case 'lit':
        return h.pat
    }
  }

  /** Run arm `row`'s body, binding its pattern variables to their occurrences.
   *  Single-use bodies are inlined (the trivial `let v = occ` copy-props away);
   *  shared bodies are called through a join-point lambda so they appear once. */
  private leafAction(row: number, binds: [string, string][], uses: Map<number, number>): Expr {
    const arm = this.arms[row]
    if ((uses.get(row) ?? 0) <= 1) return wrapBinds(binds, arm.body)
    if (!this.joinPoints.has(row)) this.joinPoints.set(row, abstractOver(arm.params, arm.body))
    return callJoin(jpName(row), arm.params, binds)
  }

  private leafGuard(row: number, binds: [string, string][], uses: Map<number, number>): Expr {
    const arm = this.arms[row]
    const guard = arm.guard!
    if ((uses.get(row) ?? 0) <= 1) return wrapBinds(binds, guard)
    if (!this.guardPoints.has(row)) this.guardPoints.set(row, abstractOver(arm.params, guard))
    return callJoin(grdName(row), arm.params, binds)
  }
}

// ---------------------------------------------------------------------------
// Lowering helpers
// ---------------------------------------------------------------------------

const jpName = (i: number): string => `$arm_${i}`
const grdName = (i: number): string => `$grd_${i}`

/** `let v1 = occ1 in … let vk = occk in body`. */
function wrapBinds(binds: [string, string][], body: Expr): Expr {
  let out = body
  for (let i = binds.length - 1; i >= 0; i--) {
    const [name, occ] = binds[i]
    out = { kind: 'let', name, value: v(occ), body: out, recursive: false, span: SYNTH }
  }
  return out
}

/** `fn p1 -> … fn pk -> body` (a thunk `fn $u -> body` when there are no vars).*/
function abstractOver(params: string[], body: Expr): Expr {
  if (params.length === 0) return { kind: 'lambda', param: gensym('u'), body, span: SYNTH }
  let out = body
  for (let i = params.length - 1; i >= 0; i--) {
    out = { kind: 'lambda', param: params[i], body: out, span: SYNTH }
  }
  return out
}

/** `f arg1 … argk` where each `argj` is the occurrence bound to param `pj`. */
function callJoin(fn: string, params: string[], binds: [string, string][]): Expr {
  const map = new Map(binds)
  let out: Expr = v(fn)
  if (params.length === 0) {
    return { kind: 'app', fn: out, arg: { kind: 'unit', span: SYNTH }, span: SYNTH }
  }
  for (const p of params) {
    out = { kind: 'app', fn: out, arg: v(map.get(p) ?? p), span: SYNTH }
  }
  return out
}

/** A guaranteed `MATCH_FAIL` at runtime, built from an ordinary non-exhaustive
 *  match every backend already compiles (only ever reached when the source match
 *  itself would have failed — i.e. a guard fell through with no live arms). */
function failExpr(): Expr {
  return {
    kind: 'match',
    scrutinee: { kind: 'bool', value: true, span: SYNTH },
    cases: [{ pattern: { kind: 'pbool', value: false, span: SYNTH }, body: { kind: 'unit', span: SYNTH } }],
    span: SYNTH,
  }
}

// ---------------------------------------------------------------------------
// Pattern / list utilities
// ---------------------------------------------------------------------------

/** The sub-patterns a constructor pattern exposes as new columns. */
function subPatterns(p: Pattern): Pattern[] {
  switch (p.kind) {
    case 'pcon':
      return p.args
    case 'pcons':
      return [p.head, p.tail]
    case 'pnil':
      return []
    case 'ptuple':
      return p.elements
    default:
      return [] // literals have no sub-fields
  }
}

function wildcards(n: number, span: Span): Pattern[] {
  const out: Pattern[] = []
  for (let i = 0; i < n; i++) out.push({ kind: 'pwild', span })
  return out
}

/** Replace element `i` of `arr` with the elements of `repl`. */
function splice<T>(arr: T[], i: number, repl: T[]): T[] {
  return [...arr.slice(0, i), ...repl, ...arr.slice(i + 1)]
}

function removeAt<T>(arr: T[], i: number): T[] {
  return [...arr.slice(0, i), ...arr.slice(i + 1)]
}

/** The source pattern variables of a pattern, left-to-right (a join-point's
 *  parameter order and the order occurrences are passed at a call site). */
function patternVarOrder(p: Pattern): string[] {
  const out: string[] = []
  const walk = (q: Pattern): void => {
    switch (q.kind) {
      case 'pvar':
        out.push(q.name)
        break
      case 'pcons':
        walk(q.head)
        walk(q.tail)
        break
      case 'ptuple':
        for (const s of q.elements) walk(s)
        break
      case 'pcon':
        for (const s of q.args) walk(s)
        break
      default:
        break
    }
  }
  walk(p)
  return out
}

/** The number of refutable nodes in a pattern (≈ the tests the naive compiler
 *  emits for that arm — `ptuple` only navigates, so it doesn't count). */
function refutableCount(p: Pattern): number {
  switch (p.kind) {
    case 'pint':
    case 'pfloat':
    case 'pbool':
    case 'pstr':
    case 'pnil':
      return 1
    case 'pcons':
      return 1 + refutableCount(p.head) + refutableCount(p.tail)
    case 'pcon':
      return 1 + p.args.reduce((n, s) => n + refutableCount(s), 0)
    case 'ptuple':
      return p.elements.reduce((n, s) => n + refutableCount(s), 0)
    default:
      return 0
  }
}

// ---------------------------------------------------------------------------
// Tree traversal: row-use counting, switch counting, view building
// ---------------------------------------------------------------------------

function countRowUses(t: Tree, acc: Map<number, number>): void {
  switch (t.kind) {
    case 'fail':
      return
    case 'leaf':
      acc.set(t.row, (acc.get(t.row) ?? 0) + 1)
      if (t.fallback) countRowUses(t.fallback, acc)
      return
    case 'switch':
      for (const a of t.arms) countRowUses(a.child, acc)
      if (t.fallback) countRowUses(t.fallback, acc)
      return
  }
}

function countSwitches(t: Tree, onlyTesting: boolean): number {
  switch (t.kind) {
    case 'fail':
    case 'leaf':
      return t.kind === 'leaf' && t.fallback ? countSwitches(t.fallback, onlyTesting) : 0
    case 'switch': {
      const here = onlyTesting && !t.tests ? 0 : 1
      let n = here
      for (const a of t.arms) n += countSwitches(a.child, onlyTesting)
      if (t.fallback) n += countSwitches(t.fallback, onlyTesting)
      return n
    }
  }
}

function viewOf(t: Tree): DtViewNode {
  switch (t.kind) {
    case 'fail':
      return { t: 'fail' }
    case 'leaf':
      return { t: 'leaf', row: t.row, guard: t.guarded, binds: t.binds }
    case 'switch':
      return {
        t: 'switch',
        occ: t.occ,
        tests: t.tests,
        arms: t.arms.map((a) => ({ label: headLabel(a.head), sub: a.subOccs, child: viewOf(a.child) })),
        fallback: t.fallback ? viewOf(t.fallback) : null,
      }
  }
}

function headLabel(h: Head): string {
  switch (h.sort) {
    case 'con':
      return h.name
    case 'cons':
      return '_ :: _'
    case 'nil':
      return '[]'
    case 'tuple':
      return '(' + Array(h.arity).fill('_').join(', ') + ')'
    case 'lit':
      return litLabel(h.pat)
  }
}

function litLabel(p: Pattern): string {
  switch (p.kind) {
    case 'pint':
    case 'pfloat':
      return String(p.value)
    case 'pbool':
      return String(p.value)
    case 'pstr':
      return JSON.stringify(p.value)
    default:
      return '?'
  }
}

// ---------------------------------------------------------------------------
// Generic core walks (bottom-up child mapping)
// ---------------------------------------------------------------------------

function mapChildren(e: Expr, f: (x: Expr) => Expr): Expr {
  switch (e.kind) {
    case 'int':
    case 'float':
    case 'bool':
    case 'str':
    case 'unit':
    case 'var':
      return e
    case 'lambda':
      return { ...e, body: f(e.body) }
    case 'app':
      return { ...e, fn: f(e.fn), arg: f(e.arg) }
    case 'let':
      return { ...e, value: f(e.value), body: f(e.body) }
    case 'letrec':
      return {
        ...e,
        bindings: e.bindings.map((b) => ({ name: b.name, value: f(b.value) })),
        body: f(e.body),
      }
    case 'if':
      return { ...e, cond: f(e.cond), then: f(e.then), else: f(e.else) }
    case 'binop':
      return { ...e, left: f(e.left), right: f(e.right) }
    case 'unop':
      return { ...e, operand: f(e.operand) }
    case 'list':
    case 'tuple':
      return { ...e, elements: e.elements.map(f) }
    case 'seq':
      return { ...e, first: f(e.first), rest: f(e.rest) }
    case 'match':
      return {
        ...e,
        scrutinee: f(e.scrutinee),
        cases: e.cases.map((c) => ({
          pattern: c.pattern,
          guard: c.guard ? f(c.guard) : undefined,
          body: f(c.body),
        })),
      }
    case 'typedecl':
      return { ...e, body: f(e.body) }
    case 'record':
      return { ...e, fields: e.fields.map((fl) => ({ label: fl.label, value: f(fl.value) })) }
    case 'field':
      return { ...e, record: f(e.record) }
    case 'recordUpdate':
      return {
        ...e,
        record: f(e.record),
        fields: e.fields.map((fl) => ({ label: fl.label, value: f(fl.value) })),
      }
    case 'classdecl':
      return { ...e, body: f(e.body) }
    case 'instancedecl':
      return {
        ...e,
        methods: e.methods.map((m) => ({ ...m, value: f(m.value) })),
        body: f(e.body),
      }
  }
}

function childrenOf(e: Expr): Expr[] {
  switch (e.kind) {
    case 'lambda':
      return [e.body]
    case 'app':
      return [e.fn, e.arg]
    case 'let':
      return [e.value, e.body]
    case 'if':
      return [e.cond, e.then, e.else]
    case 'binop':
      return [e.left, e.right]
    case 'unop':
      return [e.operand]
    case 'list':
    case 'tuple':
      return e.elements
    case 'seq':
      return [e.first, e.rest]
    case 'match':
      return [e.scrutinee, ...e.cases.flatMap((c) => (c.guard ? [c.guard, c.body] : [c.body]))]
    case 'typedecl':
      return [e.body]
    case 'letrec':
      return [...e.bindings.map((b) => b.value), e.body]
    case 'record':
      return e.fields.map((f) => f.value)
    case 'field':
      return [e.record]
    case 'recordUpdate':
      return [e.record, ...e.fields.map((f) => f.value)]
    case 'classdecl':
      return [e.body]
    case 'instancedecl':
      return [...e.methods.map((m) => m.value), e.body]
    default:
      return []
  }
}
