// Aether — size-change termination analysis (Lee–Jones–Ben-Amram, POPL 2001)
//
// "The size-change principle for program termination." A program is
// size-change terminating when, on every potential infinite call sequence, some
// value drawn from a well-founded order would have to descend forever — which is
// impossible, so no infinite sequence exists. Aether's well-founded order is the
// **structural subterm order** on finite data: a component peeled out of a
// constructor / cons-cell / tuple by a pattern is *strictly smaller* than the
// whole. (Aether is strict and its data is immutable, so every value is finite
// and that order is well-founded.)
//
// The analysis is a static, untyped, core-to-fact pass that runs alongside the
// optimizing middle-end's effect-&-totality analysis. Its purpose there is to
// upgrade that analysis from its old approximation — "a function is total iff it
// is *non-recursive*" — to "a function is total iff it is **first-order** and
// **provably size-change terminating**." Once a recursive function is proven
// effect-free *and* terminating, the optimizer may treat a saturated call to it
// as pure: common-subexpression elimination can share a repeat and dead-code
// elimination can drop an unused one.
//
// How it works (the classic algorithm):
//   1. Collect the program's named first-order functions and their parameters.
//   2. For every call site f → g, build a **size-change graph** (SCG): a bipartite
//      graph from f's parameters to g's parameters whose arcs record, for each
//      argument, whether it is a strict subterm (↓) or a non-increasing alias
//      (↓=) of one of f's parameters — read straight off the `match`/`let`
//      destructurings in scope.
//   3. Close the call graph's SCGs under composition (per strongly-connected
//      component). The SCC terminates iff **every idempotent** self-graph in the
//      closure has a strict in-situ arc `p ↓ p` — a parameter that descends on
//      every way around that loop.
//
// Higher-order recursion is deliberately out of scope, and that cut-off is what
// keeps the result *sound for the optimizer too*: a function that applies one of
// its own parameters (`map`, `foldr`, …) is never proven, because its termination
// — and its effect-freedom — depend on a function it is handed at runtime, which
// the first-order call graph cannot see.

import type { Expr, Pattern } from './ast.ts'
import type { Span } from './lexer.ts'

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/** A size relation of an in-scope variable to one of the enclosing function's
 *  parameters: `strict` ⇒ a proper subterm (↓), otherwise an alias (↓=). */
interface Rel {
  param: string
  strict: boolean
}

/** One arc of a size-change graph: argument `to` descends from / aliases the
 *  caller's parameter `from`. */
export interface ScgArc {
  from: string
  to: string
  strict: boolean
}

/** A size-change graph for a single call site (or a composite from the closure). */
export interface Scg {
  fromFn: string
  toFn: string
  arcs: ScgArc[]
}

/** Per-function verdict surfaced to the UI. */
export interface TermFnView {
  name: string
  params: string[]
  /** participates in a call cycle (genuinely recursive) */
  recursive: boolean
  /** proven to terminate (its SCC passes the size-change test and every callee
   *  it depends on is itself proven) */
  terminates: boolean
  /** disqualified by applying a runtime-supplied function (higher-order) */
  higherOrder: boolean
  /** a short human-readable reason / witness */
  reason: string
  /** for a recursive function, its direct self-call size-change graphs (for the
   *  panel's descending-thread display) */
  selfGraphs: ScgArc[][]
}

export interface TerminationResult {
  fns: TermFnView[]
  /** names proven to terminate */
  terminating: Set<string>
  /** the cyclic SCCs that are fully proven terminating, each as its member names
   *  (used by the optimizer to admit a whole mutually-recursive group at once) */
  recursiveGroups: { members: string[] }[]
  /** de-duplicated first-order call edges between named functions */
  callEdges: { from: string; to: string }[]
  /** how many named functions were analyzed */
  analyzed: number
}

interface FnInfo {
  name: string
  params: string[]
  body: Expr
  span: Span
}

// ---------------------------------------------------------------------------
// Small self-contained AST helpers (kept local so this module stands alone)
// ---------------------------------------------------------------------------

function lambdaParams(e: Expr): string[] {
  const ps: string[] = []
  let cur: Expr = e
  while (cur.kind === 'lambda') {
    ps.push(cur.param)
    cur = cur.body
  }
  return ps
}

function lambdaBody(e: Expr): Expr {
  let cur: Expr = e
  while (cur.kind === 'lambda') cur = cur.body
  return cur
}

/** The variable head + argument spine of an application. `f a b` ⇒ `f`,`[a,b]`. */
function spine(e: Expr): { head: Expr; args: Expr[] } {
  const args: Expr[] = []
  let cur: Expr = e
  while (cur.kind === 'app') {
    args.unshift(cur.arg)
    cur = cur.fn
  }
  return { head: cur, args }
}

function children(e: Expr): Expr[] {
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

function patternVars(p: Pattern, acc: Set<string>): void {
  switch (p.kind) {
    case 'pvar':
      acc.add(p.name)
      break
    case 'pcons':
      patternVars(p.head, acc)
      patternVars(p.tail, acc)
      break
    case 'ptuple':
      for (const s of p.elements) patternVars(s, acc)
      break
    case 'pcon':
      for (const s of p.args) patternVars(s, acc)
      break
    default:
      break
  }
}

// ---------------------------------------------------------------------------
// 1. Collect the program's named, never-shadowed, first-order functions
// ---------------------------------------------------------------------------

/** Count every binder occurrence of each name, exactly as the optimizer does, so
 *  the call graph only ever trusts a name that resolves to one binding. */
function binderCounts(root: Expr): Map<string, number> {
  const m = new Map<string, number>()
  const add = (n: string): void => {
    m.set(n, (m.get(n) ?? 0) + 1)
  }
  const walk = (e: Expr): void => {
    switch (e.kind) {
      case 'lambda':
        add(e.param)
        break
      case 'let':
        add(e.name)
        break
      case 'letrec':
        for (const b of e.bindings) add(b.name)
        break
      case 'match':
        for (const c of e.cases) {
          const s = new Set<string>()
          patternVars(c.pattern, s)
          for (const n of s) add(n)
        }
        break
      default:
        break
    }
    for (const c of children(e)) walk(c)
  }
  walk(root)
  return m
}

function collectFns(root: Expr, counts: Map<string, number>): Map<string, FnInfo> {
  const fns = new Map<string, FnInfo>()
  const consider = (name: string, value: Expr, span: Span): void => {
    if (value.kind !== 'lambda') return
    if (counts.get(name) !== 1) return // shadowed somewhere ⇒ a `var` is ambiguous
    const params = lambdaParams(value)
    if (params.length === 0) return
    fns.set(name, { name, params, body: lambdaBody(value), span })
  }
  const walk = (e: Expr): void => {
    if (e.kind === 'let') consider(e.name, e.value, e.span)
    else if (e.kind === 'letrec') for (const b of e.bindings) consider(b.name, b.value, e.span)
    for (const c of children(e)) walk(c)
  }
  walk(root)
  return fns
}

// ---------------------------------------------------------------------------
// 2. Build size-change graphs by walking each function body
// ---------------------------------------------------------------------------

type Env = Map<string, Rel>

/** A walk context: the size of each in-scope variable, plus *reconstruction*
 *  facts. When `match m with S p -> …` binds `p` to the field of `m`, the term
 *  `S p` rebuilds `m` exactly — so it has the *same* size as `m`. Tracking that
 *  (a ↓= arc) is what lets size-change prove lexicographic descent, e.g.
 *  Ackermann's `ack (S p) q` keeps the first argument equal while the second
 *  strictly shrinks. Keyed by the term's shape; each entry remembers the field
 *  variables so a later rebinding can invalidate it. */
interface Ctx {
  sizes: Env
  recon: Map<string, { rel: Rel; vars: string[] }>
}

function cloneCtx(c: Ctx): Ctx {
  return { sizes: new Map(c.sizes), recon: new Map(c.recon) }
}

/** Drop every reconstruction fact that mentions `name` — its value just changed,
 *  so any term rebuilt from it is no longer known to have the recorded size. */
function invalidateRecon(c: Ctx, name: string): void {
  for (const [k, v] of c.recon) if (v.vars.includes(name)) c.recon.delete(k)
}

/** The shape key of an all-variable constructor / cons / tuple term, or null. */
function reconExprKey(e: Expr): string | null {
  if (e.kind === 'app') {
    const { head, args } = spine(e)
    if (head.kind === 'var' && args.length > 0 && args.every((a) => a.kind === 'var')) {
      return head.name + '|' + args.map((a) => (a as { name: string }).name).join(',')
    }
    return null
  }
  if (e.kind === 'binop' && e.op === '::' && e.left.kind === 'var' && e.right.kind === 'var') {
    return '::|' + e.left.name + ',' + e.right.name
  }
  if (e.kind === 'tuple' && e.elements.length > 0 && e.elements.every((x) => x.kind === 'var')) {
    return 'T' + e.elements.length + '|' + e.elements.map((x) => (x as { name: string }).name).join(',')
  }
  return null
}

/** The matching shape key of an all-variable constructor / cons / tuple pattern
 *  (plus its bound field variables), or null. */
function reconPatKey(p: Pattern): { key: string; vars: string[] } | null {
  if (p.kind === 'pcon' && p.args.length > 0 && p.args.every((a) => a.kind === 'pvar')) {
    const vars = p.args.map((a) => (a as { name: string }).name)
    return { key: p.name + '|' + vars.join(','), vars }
  }
  if (p.kind === 'pcons' && p.head.kind === 'pvar' && p.tail.kind === 'pvar') {
    return { key: '::|' + p.head.name + ',' + p.tail.name, vars: [p.head.name, p.tail.name] }
  }
  if (p.kind === 'ptuple' && p.elements.length > 0 && p.elements.every((a) => a.kind === 'pvar')) {
    const vars = p.elements.map((a) => (a as { name: string }).name)
    return { key: 'T' + p.elements.length + '|' + vars.join(','), vars }
  }
  return null
}

/** The size relation of an expression to the enclosing parameters, if any: a bare
 *  variable carries its tracked size; a term that exactly reconstructs a matched
 *  scrutinee carries that scrutinee's size (a non-increasing ↓= alias). */
function relOf(e: Expr, c: Ctx): Rel | null {
  if (e.kind === 'var') return c.sizes.get(e.name) ?? null
  const key = reconExprKey(e)
  return key ? (c.recon.get(key)?.rel ?? null) : null
}

/** Bind a pattern's variables to their size relative to the scrutinee `sr`. A
 *  variable directly *is* the scrutinee (depth 0) aliases it; one nested under at
 *  least one constructor / cons / tuple (depth ≥ 1) is a strict subterm. */
function bindPattern(p: Pattern, sr: Rel | null, depth: number, out: Env): void {
  switch (p.kind) {
    case 'pvar': {
      const rel: Rel | null =
        depth === 0 ? sr : sr ? { param: sr.param, strict: true } : null
      if (rel) out.set(p.name, rel)
      else out.delete(p.name)
      break
    }
    case 'pcons':
      bindPattern(p.head, sr, depth + 1, out)
      bindPattern(p.tail, sr, depth + 1, out)
      break
    case 'ptuple':
      for (const s of p.elements) bindPattern(s, sr, depth + 1, out)
      break
    case 'pcon':
      for (const s of p.args) bindPattern(s, sr, depth + 1, out)
      break
    default:
      break
  }
}

interface ScgBuild {
  scgs: Scg[]
  /** functions disqualified by higher-order self-application */
  higherOrder: Set<string>
  callEdges: Set<string> // "from to"
}

function buildScgs(fns: Map<string, FnInfo>): ScgBuild {
  const scgs: Scg[] = []
  const higherOrder = new Set<string>()
  const callEdges = new Set<string>()
  const FNAMES = new Set(fns.keys())

  for (const f of fns.values()) {
    // `locals` tracks names bound *inside* f (parameters, lambda params, pattern
    // and let binders). Applying one of them in head position is higher-order —
    // it runs a function chosen at runtime, invisible to the first-order call
    // graph — so it disqualifies f (see the file header).
    const locals = new Set(f.params)

    const recordCall = (g: FnInfo, args: Expr[], ctx: Ctx): void => {
      callEdges.add(f.name + ' ' + g.name)
      const arcs: ScgArc[] = []
      const seen = new Map<string, number>() // dst param → index into arcs
      const n = Math.min(args.length, g.params.length)
      for (let i = 0; i < n; i++) {
        const r = relOf(args[i], ctx)
        if (!r) continue
        const dst = g.params[i]
        const arc: ScgArc = { from: r.param, to: dst, strict: r.strict }
        const idx = seen.get(r.param + ' ' + dst)
        if (idx === undefined) {
          seen.set(r.param + ' ' + dst, arcs.length)
          arcs.push(arc)
        } else if (r.strict) {
          arcs[idx].strict = true // keep the strongest label
        }
      }
      scgs.push({ fromFn: f.name, toFn: g.name, arcs })
    }

    const walk = (e: Expr, ctx: Ctx): void => {
      switch (e.kind) {
        case 'app': {
          const { head, args } = spine(e)
          if (head.kind === 'var') {
            if (FNAMES.has(head.name)) {
              recordCall(fns.get(head.name)!, args, ctx)
            } else if (locals.has(head.name)) {
              higherOrder.add(f.name) // applies a runtime-supplied function
            }
          }
          // a non-variable head (e.g. `(fn x -> …) a`, or `(g a) b`) still has its
          // pieces walked below for nested calls.
          for (const a of args) walk(a, ctx)
          if (head.kind !== 'var') walk(head, ctx)
          return
        }
        case 'match': {
          walk(e.scrutinee, ctx)
          const sr = relOf(e.scrutinee, ctx)
          for (const c of e.cases) {
            const inner = cloneCtx(ctx)
            const bound = new Set<string>()
            patternVars(c.pattern, bound)
            for (const b of bound) {
              locals.add(b)
              invalidateRecon(inner, b) // a rebinding stales any term built from it
            }
            bindPattern(c.pattern, sr, 0, inner.sizes)
            // `C f1 .. fn` rebuilds this scrutinee exactly, so it shares its size
            if (sr) {
              const rp = reconPatKey(c.pattern)
              if (rp) inner.recon.set(rp.key, { rel: sr, vars: rp.vars })
            }
            if (c.guard) walk(c.guard, inner)
            walk(c.body, inner)
          }
          return
        }
        case 'let': {
          walk(e.value, ctx)
          locals.add(e.name)
          const inner = cloneCtx(ctx)
          invalidateRecon(inner, e.name)
          // copy-propagate a size fact through `let v = <var or reconstruction>`
          const r = relOf(e.value, ctx)
          if (r) inner.sizes.set(e.name, r)
          else inner.sizes.delete(e.name)
          walk(e.body, inner)
          return
        }
        case 'letrec': {
          for (const b of e.bindings) locals.add(b.name)
          for (const b of e.bindings) walk(b.value, ctx)
          walk(e.body, ctx)
          return
        }
        case 'lambda': {
          locals.add(e.param)
          const inner = cloneCtx(ctx)
          invalidateRecon(inner, e.param)
          inner.sizes.delete(e.param)
          walk(e.body, inner)
          return
        }
        default:
          for (const c of children(e)) walk(c, ctx)
      }
    }

    const ctx0: Ctx = { sizes: new Map(), recon: new Map() }
    for (const p of f.params) ctx0.sizes.set(p, { param: p, strict: false })
    walk(f.body, ctx0)
  }

  return { scgs, higherOrder, callEdges }
}

// ---------------------------------------------------------------------------
// 3. Compose, close, and apply the size-change termination test
// ---------------------------------------------------------------------------

type Adj = Map<string, Map<string, boolean>> // from → to → strict

function toAdj(arcs: ScgArc[]): Adj {
  const a: Adj = new Map()
  for (const arc of arcs) {
    let row = a.get(arc.from)
    if (!row) a.set(arc.from, (row = new Map()))
    const cur = row.get(arc.to)
    row.set(arc.to, (cur ?? false) || arc.strict)
  }
  return a
}

/** Compose two adjacency maps: (a;b)[u][w] exists when some v has a[u][v] and
 *  b[v][w]; it is strict if either segment is. Keeps the strongest label. */
function compose(a: Adj, b: Adj): Adj {
  const r: Adj = new Map()
  for (const [u, ra] of a) {
    for (const [v, s1] of ra) {
      const rb = b.get(v)
      if (!rb) continue
      let row = r.get(u)
      if (!row) r.set(u, (row = new Map()))
      for (const [w, s2] of rb) {
        const strict = s1 || s2
        const cur = row.get(w)
        row.set(w, (cur ?? false) || strict)
      }
    }
  }
  return r
}

function adjKey(a: Adj): string {
  const parts: string[] = []
  for (const [from, row] of a)
    for (const [to, strict] of row) parts.push(from + '>' + to + (strict ? '!' : '='))
  parts.sort()
  return parts.join(',')
}

function hasStrictSelfArc(a: Adj): boolean {
  for (const [from, row] of a) if (row.get(from) === true) return true
  return false
}

const CLOSURE_CAP = 4000

/**
 * Decide whether a strongly-connected component terminates. Closes its internal
 * size-change graphs under composition and checks that every idempotent
 * self-graph (G with G;G ≅ G) carries a strict in-situ arc. Returns `null` if
 * the closure exceeds the safety cap (treated as *not proven* by the caller).
 */
function sccTerminates(sccSet: Set<string>, base: Scg[]): boolean | null {
  // graphs internal to the SCC, keyed for de-duplication
  interface G {
    fromFn: string
    toFn: string
    adj: Adj
    key: string
  }
  const seen = new Set<string>()
  const graphs: G[] = []
  const add = (fromFn: string, toFn: string, adj: Adj): void => {
    const key = fromFn + '|' + toFn + '|' + adjKey(adj)
    if (seen.has(key)) return
    seen.add(key)
    graphs.push({ fromFn, toFn, adj, key })
  }
  for (const s of base) {
    if (sccSet.has(s.fromFn) && sccSet.has(s.toFn)) add(s.fromFn, s.toFn, toAdj(s.arcs))
  }

  // transitive closure under (call-graph-composable) composition
  for (let i = 0; i < graphs.length; i++) {
    const g = graphs[i]
    for (let j = 0; j < graphs.length; j++) {
      const h = graphs[j]
      if (g.toFn !== h.fromFn) continue
      add(g.fromFn, h.toFn, compose(g.adj, h.adj))
      if (graphs.length > CLOSURE_CAP) return null
    }
  }

  // every idempotent self-loop must descend somewhere
  for (const g of graphs) {
    if (g.fromFn !== g.toFn) continue
    const sq = compose(g.adj, g.adj)
    if (adjKey(sq) !== adjKey(g.adj)) continue // not idempotent
    if (!hasStrictSelfArc(g.adj)) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Tarjan strongly-connected components over the first-order call graph
// ---------------------------------------------------------------------------

function tarjanSccs(nodes: string[], edges: Map<string, Set<string>>): string[][] {
  let index = 0
  const idx = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const out: string[][] = []

  const strong = (v: string): void => {
    idx.set(v, index)
    low.set(v, index)
    index++
    stack.push(v)
    onStack.add(v)
    for (const w of edges.get(v) ?? []) {
      if (!idx.has(w)) {
        strong(w)
        low.set(v, Math.min(low.get(v)!, low.get(w)!))
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, idx.get(w)!))
      }
    }
    if (low.get(v) === idx.get(v)) {
      const comp: string[] = []
      for (;;) {
        const w = stack.pop()!
        onStack.delete(w)
        comp.push(w)
        if (w === v) break
      }
      out.push(comp)
    }
  }
  for (const v of nodes) if (!idx.has(v)) strong(v)
  return out
}

// ---------------------------------------------------------------------------
// Top-level driver
// ---------------------------------------------------------------------------

export function analyzeTermination(root: Expr): TerminationResult {
  const counts = binderCounts(root)
  const fns = collectFns(root, counts)
  const names = [...fns.keys()]
  const { scgs, higherOrder, callEdges } = buildScgs(fns)

  // call-graph edges restricted to named functions
  const edges = new Map<string, Set<string>>()
  for (const n of names) edges.set(n, new Set())
  const callEdgeList: { from: string; to: string }[] = []
  for (const e of callEdges) {
    const [from, to] = e.split(' ')
    if (edges.has(from) && fns.has(to)) {
      edges.get(from)!.add(to)
      callEdgeList.push({ from, to })
    }
  }

  // self-loop set (a function that calls itself directly)
  const selfLoop = new Set<string>()
  for (const s of scgs) if (s.fromFn === s.toFn) selfLoop.add(s.fromFn)

  // SCCs, then per-SCC size-change test. Process in reverse topological order so
  // a function only counts as terminating when every callee it leans on does.
  const sccs = tarjanSccs(names, edges) // already in reverse-topological order
  const sccOf = new Map<string, number>()
  sccs.forEach((c, i) => c.forEach((n) => sccOf.set(n, i)))

  const sccTerminating: boolean[] = sccs.map(() => false)
  const terminating = new Set<string>()
  const recursiveGroups: { members: string[] }[] = []

  sccs.forEach((comp, i) => {
    const set = new Set(comp)
    const cyclic = comp.length > 1 || comp.some((n) => selfLoop.has(n))
    const disqualified = comp.some((n) => higherOrder.has(n))

    // a callee in a *different*, not-yet-terminating SCC sinks this one
    let calleesOk = true
    for (const n of comp) {
      for (const w of edges.get(n) ?? []) {
        const j = sccOf.get(w)!
        if (j !== i && !sccTerminating[j]) calleesOk = false
      }
    }

    let ok = calleesOk && !disqualified
    if (ok && cyclic) {
      const verdict = sccTerminates(set, scgs)
      ok = verdict === true
    }
    sccTerminating[i] = ok
    if (ok) {
      for (const n of comp) terminating.add(n)
      if (cyclic) recursiveGroups.push({ members: [...comp] })
    }
  })

  // per-function views for the panel
  const fnViews: TermFnView[] = names.map((n) => {
    const info = fns.get(n)!
    const i = sccOf.get(n)!
    const comp = sccs[i]
    const recursive = comp.length > 1 || selfLoop.has(n)
    const ho = higherOrder.has(n)
    const ok = terminating.has(n)
    const selfGraphs = scgs
      .filter((s) => s.fromFn === n && s.toFn === n)
      .map((s) => s.arcs)
    let reason: string
    if (!recursive) reason = ok ? 'non-recursive (terminates trivially)' : 'calls an unproven function'
    else if (ho) reason = 'higher-order: applies a runtime-supplied function — out of scope'
    else if (ok) {
      const descend = new Set<string>()
      for (const arcs of selfGraphs) for (const a of arcs) if (a.strict && a.from === a.to) descend.add(a.from)
      reason =
        descend.size > 0
          ? `every recursive call shrinks ${[...descend].map((p) => '`' + p + '`').join(' / ')} (a strict subterm)`
          : 'size-change terminating across its mutual-recursion group'
    } else reason = 'no parameter provably decreases on every loop'
    return { name: n, params: info.params, recursive, terminates: ok, higherOrder: ho, reason, selfGraphs }
  })

  return {
    fns: fnViews,
    terminating,
    recursiveGroups,
    callEdges: callEdgeList,
    analyzed: names.length,
  }
}
