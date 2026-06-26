// Aether — short-cut fusion (deforestation)
//
// The optimizing middle-end (`optimize.ts`) is a *greedy peephole* rewriter: it
// const-folds, β-reduces, inlines, shares (CSE/GVN) and even superoptimizes the
// arithmetic islands with an e-graph. What it has never done is the one rewrite
// every list pipeline is begging for — **deleting the intermediate data
// structures** that flow between combinators. Write
//
//     sum (map (fn x -> x * x) (filter even (range 1 100)))
//
// and the naïve compilation builds *three* throwaway lists — `range`'s, then
// `filter`'s, then `map`'s — only to walk each one once and discard it. Each
// intermediate cons cell is allocated, traversed and garbage-collected for
// nothing. Fusion removes them: it rewrites a *consumer applied to a producer*
// into a single pass that never materialises the list in between. This is the
// classic deforestation transformation (Wadler 1990; Gill, Launchbury & Peyton
// Jones, *A short cut to deforestation*, 1993), here as a from-scratch algebraic
// rewrite system over Aether's prelude combinators — GHC's `{-# RULES #-}` in
// miniature.
//
// Soundness. Aether is strict and *effectful* (`print`, the turtle), so the
// timing and count of effects is observable. A fusion law moves work across the
// boundary between two passes — it interleaves what used to be batched, or drops
// elements that used to be forced. Each law is therefore gated on the *function
// whose call-timing it changes* being **pure and total** (`isPureTotal`, supplied
// by the optimizer's own effect-&-totality analysis): a pure-total function may
// be called fewer times, in a different order, or not at all without any
// observable difference (no effect to reorder, no exception to hoist, no
// divergence to skip). The *consumer's* own function (a fold's `k`, a filter's
// downstream predicate) keeps its exact call sequence, so it is never gated.
//
// Identity. A rewrite must only fire on the *real* prelude combinator, never on a
// user binding that happens to share the name. `map` is "the prelude map" at a use
// site iff the binding in scope is structurally the canonical prelude definition
// (or the name is free — i.e. the prelude global, in the per-user-portion run the
// JS/WASM backends compile). A `let map = …` or a `fn map -> …` with any other
// body shadows it, and fusion declines. This is tracked with a scope environment
// during the walk.
//
// Because the output is ordinary core AST (the same `map`/`filter`/`foldl`/… the
// program already used, plus fresh lambdas), all three backends — the bytecode VM,
// the JavaScript backend and the WebAssembly backend — compile it unchanged, and
// the harness's VM ≡ JS ≡ WASM equivalence checks re-prove on every example that
// fusion never changed an answer, while the never-increase-VM-steps gate proves it
// never made one slower.

import type { BinaryOp, Expr, Pattern } from './ast.ts'
import type { Span } from './lexer.ts'
import { parse } from './parser.ts'
import { PRELUDE_DEFS } from './prelude.ts'

/** The prelude combinators fusion knows how to reason about, with their arity
 *  (how many arguments a *saturated* application takes). */
const COMB_ARITY: Record<string, number> = {
  map: 2,
  filter: 2,
  foldr: 3,
  foldl: 3,
  length: 1,
  sum: 1,
  reverse: 1,
  take: 2,
  all: 2,
  any: 2,
}

/** The canonical core AST of each combinator's prelude definition, parsed once.
 *  A binding is "the prelude combinator" only if its value matches this. */
const CANON: Map<string, Expr> = (() => {
  const m = new Map<string, Expr>()
  for (const d of PRELUDE_DEFS) {
    if (d.name in COMB_ARITY) m.set(d.name, parse(d.src))
  }
  return m
})()

/** Structural equality, ignoring source spans (and nothing else: bound-variable
 *  names must match, which they do because a canonical binding is a fresh parse of
 *  the exact same prelude source the program was built from). */
function structEq(a: Expr, b: Expr): boolean {
  return JSON.stringify(stripSpans(a)) === JSON.stringify(stripSpans(b))
}

/** Deep-copy an AST with every `span` removed, for span-insensitive comparison. */
function stripSpans(e: unknown): unknown {
  if (Array.isArray(e)) return e.map(stripSpans)
  if (e && typeof e === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(e as Record<string, unknown>)) {
      if (k === 'span') continue
      out[k] = stripSpans(v)
    }
    return out
  }
  return e
}

/** Per-name resolution in the current scope: `prelude` ⇒ this name is the real
 *  combinator; `shadowed` ⇒ a user binding hides it. An absent name is free,
 *  which (in any expression we optimize) means the prelude global ⇒ treated as
 *  `prelude`. */
type Env = Map<string, 'prelude' | 'shadowed'>

function isComb(name: string, env: Env): boolean {
  return name in COMB_ARITY && env.get(name) !== 'shadowed'
}

/** Mark a name as bound by a non-prelude binder (lambda param, match var, …). */
function shadow(env: Env, name: string): Env {
  if (!(name in COMB_ARITY)) return env
  const next = new Map(env)
  next.set(name, 'shadowed')
  return next
}

function shadowAll(env: Env, names: Iterable<string>): Env {
  let next = env
  for (const n of names) next = shadow(next, n)
  return next
}

/** A `let name = value` updates the scope: a combinator-named binding becomes
 *  `prelude` only if its value is the canonical definition, else `shadowed`. */
function bindLet(env: Env, name: string, value: Expr): Env {
  if (!(name in COMB_ARITY)) return env
  const canon = CANON.get(name)
  const status: 'prelude' | 'shadowed' = canon && structEq(value, canon) ? 'prelude' : 'shadowed'
  const next = new Map(env)
  next.set(name, status)
  return next
}

/** The variables a pattern binds (so a `match` arm shadows them). */
function patternVars(p: Pattern): string[] {
  switch (p.kind) {
    case 'pvar':
      return [p.name]
    case 'pcons':
      return [...patternVars(p.head), ...patternVars(p.tail)]
    case 'ptuple':
      return p.elements.flatMap(patternVars)
    case 'pcon':
      return p.args.flatMap(patternVars)
    default:
      return []
  }
}

/** If `e` is a (left-nested) application spine `f a1 a2 …` whose head is a `var`,
 *  return the head name and the argument list in source order. */
function spine(e: Expr): { name: string; args: Expr[] } | null {
  const args: Expr[] = []
  let cur: Expr = e
  while (cur.kind === 'app') {
    args.unshift(cur.arg)
    cur = cur.fn
  }
  return cur.kind === 'var' ? { name: cur.name, args } : null
}

/** `e` as a *saturated* application of an in-scope combinator, or null. */
function combApp(e: Expr, env: Env): { name: string; args: Expr[] } | null {
  const s = spine(e)
  if (!s || !isComb(s.name, env)) return null
  if (s.args.length !== COMB_ARITY[s.name]) return null
  return s
}

// — small AST builders (all take the firing node's span) —

const v = (name: string, span: Span): Expr => ({ kind: 'var', name, span })

/** Left-associated application `head a1 a2 …`. */
function ap(head: Expr, args: Expr[], span: Span): Expr {
  return args.reduce<Expr>((fn, arg) => ({ kind: 'app', fn, arg, span }), head)
}

function lam(param: string, body: Expr, span: Span): Expr {
  return { kind: 'lambda', param, body, span }
}

function binop(op: BinaryOp, left: Expr, right: Expr, span: Span): Expr {
  return { kind: 'binop', op, left, right, span }
}

// Fresh, source-impossible names ($-prefixed) for the lambdas fusion introduces.
// Reset per `fuseLists` run so output is deterministic.
let fresh = 0
function gen(): string {
  return `$fuse_${fresh++}`
}

/** Is *calling* `f` pure and total? A lambda whose (peeled) body is pure-total,
 *  or a `var` naming a proven-pure function/native. Conservative: anything else
 *  (an unknown partial application, a bare parameter of unknown provenance) is
 *  treated as possibly-effectful. */
function pureFn(f: Expr, ctx: Ctx): boolean {
  if (f.kind === 'lambda') {
    let b: Expr = f
    while (b.kind === 'lambda') b = b.body
    return pureBody(b, ctx)
  }
  if (f.kind === 'var') return ctx.isPureFnName(f.name)
  return false
}

/** Pure-and-total evaluation of `e` (free variables count as already-evaluated
 *  pure values). This is mostly the optimizer's own `isPure`, with one addition:
 *  it sees through the β-redexes fusion itself introduces — a composed mapper
 *  `(fn z -> f (g z))` applied along a chain is pure iff its parts are — so a
 *  three-deep `map f (map g (map h xs))` fuses all the way down. Leaf subterms
 *  (binops, var-headed calls the analysis knows about) defer to `ctx.isPureTotal`,
 *  preserving its knowledge of which named functions are pure. */
function pureBody(e: Expr, ctx: Ctx): boolean {
  if (e.kind === 'app') {
    const args: Expr[] = []
    let cur: Expr = e
    while (cur.kind === 'app') {
      args.unshift(cur.arg)
      cur = cur.fn
    }
    if (cur.kind === 'lambda') {
      // (fn p1 … -> body) a1 … — pure iff every argument and the body are pure
      let body: Expr = cur
      let n = args.length
      while (n > 0 && body.kind === 'lambda') {
        body = body.body
        n--
      }
      return args.every((a) => pureBody(a, ctx)) && pureBody(body, ctx)
    }
    if (cur.kind === 'var') {
      return ctx.isPureFnName(cur.name) && args.every((a) => pureBody(a, ctx))
    }
    return false
  }
  return ctx.isPureTotal(e)
}

export interface Ctx {
  /** evaluating this expression is effect-free and always terminates normally */
  isPureTotal: (e: Expr) => boolean
  /** a saturated call to this *named* function is pure and total */
  isPureFnName: (name: string) => boolean
}

export interface FusionStat {
  rule: string
  count: number
}

export interface FusionResult {
  expr: Expr
  /** total fusions applied */
  count: number
  /** firings grouped by law, for the Optimizer panel */
  fusions: FusionStat[]
}

/**
 * Rewrite list-combinator pipelines to fuse away their intermediate lists.
 * A no-op (identity) when nothing matches. Runs to a fixpoint bottom-up so chains
 * (`map f (map g (map h xs))`) collapse all the way down.
 */
export function fuseLists(root: Expr, ctx: Ctx): FusionResult {
  fresh = 0
  const counts = new Map<string, number>()
  const fire = (rule: string): void => {
    counts.set(rule, (counts.get(rule) ?? 0) + 1)
  }

  // Try every law at node `e` (whose children are already fused). Returns the
  // rewritten node and the rule name, or null if nothing fires.
  function tryRule(e: Expr, env: Env): { expr: Expr; rule: string } | null {
    const outer = combApp(e, env)
    if (!outer) return null
    const sp = e.span
    const { name, args } = outer

    // — consumer ∘ map : push the consumer through, dropping the mapped list —
    if (name === 'map') {
      const [f, xs] = args
      const inner = combApp(xs, env)
      // map/map: map f (map g ys) ⇒ map (fn z -> f (g z)) ys      (g pure-total)
      if (inner && inner.name === 'map' && pureFn(inner.args[0], ctx)) {
        const [g, ys] = inner.args
        const z = gen()
        const composed = lam(z, ap(f, [ap(g, [v(z, sp)], sp)], sp), sp)
        return { expr: ap(v('map', sp), [composed, ys], sp), rule: 'map/map' }
      }
    }
    if (name === 'filter') {
      const [p, xs] = args
      const inner = combApp(xs, env)
      // filter/filter: filter p (filter q ys) ⇒ filter (fn z -> q z && p z) ys
      if (inner && inner.name === 'filter' && pureFn(inner.args[0], ctx)) {
        const [q, ys] = inner.args
        const z = gen()
        const both = lam(z, binop('&&', ap(q, [v(z, sp)], sp), ap(p, [v(z, sp)], sp), sp), sp)
        return { expr: ap(v('filter', sp), [both, ys], sp), rule: 'filter/filter' }
      }
    }
    if (name === 'foldr') {
      const [k, z0, xs] = args
      const inner = combApp(xs, env)
      // foldr/map: foldr k z (map g ys) ⇒ foldr (fn x a -> k (g x) a) z ys
      if (inner && inner.name === 'map' && pureFn(inner.args[0], ctx)) {
        const [g, ys] = inner.args
        const x = gen()
        const a = gen()
        const k2 = lam(x, lam(a, ap(k, [ap(g, [v(x, sp)], sp), v(a, sp)], sp), sp), sp)
        return { expr: ap(v('foldr', sp), [k2, z0, ys], sp), rule: 'foldr/map' }
      }
      // foldr/filter: foldr k z (filter p ys) ⇒
      //   foldr (fn x a -> if p x then k x a else a) z ys
      if (inner && inner.name === 'filter' && pureFn(inner.args[0], ctx)) {
        const [p, ys] = inner.args
        const x = gen()
        const a = gen()
        const k2 = lam(
          x,
          lam(
            a,
            { kind: 'if', cond: ap(p, [v(x, sp)], sp), then: ap(k, [v(x, sp), v(a, sp)], sp), else: v(a, sp), span: sp },
            sp,
          ),
          sp,
        )
        return { expr: ap(v('foldr', sp), [k2, z0, ys], sp), rule: 'foldr/filter' }
      }
    }
    if (name === 'foldl') {
      const [k, z0, xs] = args
      const inner = combApp(xs, env)
      // foldl/map: foldl k z (map g ys) ⇒ foldl (fn a x -> k a (g x)) z ys
      if (inner && inner.name === 'map' && pureFn(inner.args[0], ctx)) {
        const [g, ys] = inner.args
        const a = gen()
        const x = gen()
        const k2 = lam(a, lam(x, ap(k, [v(a, sp), ap(g, [v(x, sp)], sp)], sp), sp), sp)
        return { expr: ap(v('foldl', sp), [k2, z0, ys], sp), rule: 'foldl/map' }
      }
      // foldl/filter: foldl k z (filter p ys) ⇒
      //   foldl (fn a x -> if p x then k a x else a) z ys
      if (inner && inner.name === 'filter' && pureFn(inner.args[0], ctx)) {
        const [p, ys] = inner.args
        const a = gen()
        const x = gen()
        const k2 = lam(
          a,
          lam(
            x,
            { kind: 'if', cond: ap(p, [v(x, sp)], sp), then: ap(k, [v(a, sp), v(x, sp)], sp), else: v(a, sp), span: sp },
            sp,
          ),
          sp,
        )
        return { expr: ap(v('foldl', sp), [k2, z0, ys], sp), rule: 'foldl/filter' }
      }
    }
    if (name === 'all' || name === 'any') {
      const [p, xs] = args
      const inner = combApp(xs, env)
      // all/any over map: all p (map g ys) ⇒ all (fn z -> p (g z)) ys
      if (inner && inner.name === 'map' && pureFn(inner.args[0], ctx)) {
        const [g, ys] = inner.args
        const z = gen()
        const p2 = lam(z, ap(p, [ap(g, [v(z, sp)], sp)], sp), sp)
        return { expr: ap(v(name, sp), [p2, ys], sp), rule: `${name}/map` }
      }
    }
    if (name === 'length') {
      const [xs] = args
      const inner = combApp(xs, env)
      // length/map: length (map g ys) ⇒ length ys      (g pure-total — drop it)
      if (inner && inner.name === 'map' && pureFn(inner.args[0], ctx)) {
        return { expr: ap(v('length', sp), [inner.args[1]], sp), rule: 'length/map' }
      }
      // length/reverse: length (reverse ys) ⇒ length ys      (reverse total)
      if (inner && inner.name === 'reverse') {
        return { expr: ap(v('length', sp), [inner.args[0]], sp), rule: 'length/reverse' }
      }
    }
    if (name === 'sum') {
      const [xs] = args
      const inner = combApp(xs, env)
      // sum/map: sum (map g ys) ⇒ foldl (fn a x -> a + g x) 0 ys
      if (inner && inner.name === 'map' && pureFn(inner.args[0], ctx)) {
        const [g, ys] = inner.args
        const a = gen()
        const x = gen()
        const step = lam(a, lam(x, binop('+', v(a, sp), ap(g, [v(x, sp)], sp), sp), sp), sp)
        return {
          expr: ap(v('foldl', sp), [step, { kind: 'int', value: 0, span: sp }, ys], sp),
          rule: 'sum/map',
        }
      }
      // sum/filter: sum (filter p ys) ⇒ foldl (fn a x -> if p x then a + x else a) 0 ys
      if (inner && inner.name === 'filter' && pureFn(inner.args[0], ctx)) {
        const [p, ys] = inner.args
        const a = gen()
        const x = gen()
        const step = lam(
          a,
          lam(
            x,
            {
              kind: 'if',
              cond: ap(p, [v(x, sp)], sp),
              then: binop('+', v(a, sp), v(x, sp), sp),
              else: v(a, sp),
              span: sp,
            },
            sp,
          ),
          sp,
        )
        return {
          expr: ap(v('foldl', sp), [step, { kind: 'int', value: 0, span: sp }, ys], sp),
          rule: 'sum/filter',
        }
      }
    }
    if (name === 'reverse') {
      const [xs] = args
      const inner = combApp(xs, env)
      // reverse/reverse: reverse (reverse ys) ⇒ ys   (reverse pure-total; ys read once)
      if (inner && inner.name === 'reverse') {
        return { expr: inner.args[0], rule: 'reverse/reverse' }
      }
    }
    if (name === 'take') {
      const [n, xs] = args
      const inner = combApp(xs, env)
      // take/map: take n (map g ys) ⇒ map g (take n ys)   (g pure-total — fewer calls)
      if (inner && inner.name === 'map' && pureFn(inner.args[0], ctx)) {
        const [g, ys] = inner.args
        return {
          expr: ap(v('map', sp), [g, ap(v('take', sp), [n, ys], sp)], sp),
          rule: 'take/map',
        }
      }
    }

    return null
  }

  // Bottom-up walk: fuse children first, then fire laws at this node to a fixpoint
  // (a rewrite can expose another at the same spot, e.g. a chained map).
  function go(e: Expr, env: Env): Expr {
    e = recurse(e, env)
    for (let guard = 0; guard < 10000; guard++) {
      const r = tryRule(e, env)
      if (!r) break
      fire(r.rule)
      e = r.expr
    }
    return e
  }

  // Rebuild `e` with each child fused under the correctly-shadowed scope.
  function recurse(e: Expr, env: Env): Expr {
    switch (e.kind) {
      case 'int':
      case 'float':
      case 'bool':
      case 'str':
      case 'unit':
      case 'var':
        return e
      case 'lambda':
        return { ...e, body: go(e.body, shadow(env, e.param)) }
      case 'app':
        return { ...e, fn: go(e.fn, env), arg: go(e.arg, env) }
      case 'let': {
        const inner = e.recursive ? bindLet(env, e.name, e.value) : env
        const value = go(e.value, inner)
        const body = go(e.body, bindLet(env, e.name, e.value))
        return { ...e, value, body }
      }
      case 'letrec': {
        const names = e.bindings.map((b) => b.name)
        const inner = shadowAll(env, names)
        return {
          ...e,
          bindings: e.bindings.map((b) => ({ name: b.name, value: go(b.value, inner) })),
          body: go(e.body, inner),
        }
      }
      case 'if':
        return { ...e, cond: go(e.cond, env), then: go(e.then, env), else: go(e.else, env) }
      case 'binop':
        return { ...e, left: go(e.left, env), right: go(e.right, env) }
      case 'unop':
        return { ...e, operand: go(e.operand, env) }
      case 'list':
      case 'tuple':
        return { ...e, elements: e.elements.map((x) => go(x, env)) }
      case 'seq':
        return { ...e, first: go(e.first, env), rest: go(e.rest, env) }
      case 'match':
        return {
          ...e,
          scrutinee: go(e.scrutinee, env),
          cases: e.cases.map((c) => {
            const cenv = shadowAll(env, patternVars(c.pattern))
            return {
              pattern: c.pattern,
              guard: c.guard ? go(c.guard, cenv) : undefined,
              body: go(c.body, cenv),
            }
          }),
        }
      case 'typedecl':
        return { ...e, body: go(e.body, env) }
      case 'record':
        return { ...e, fields: e.fields.map((f) => ({ label: f.label, value: go(f.value, env) })) }
      case 'field':
        return { ...e, record: go(e.record, env) }
      case 'recordUpdate':
        return {
          ...e,
          record: go(e.record, env),
          fields: e.fields.map((f) => ({ label: f.label, value: go(f.value, env) })),
        }
      case 'classdecl':
        return { ...e, body: go(e.body, env) }
      case 'instancedecl':
        return {
          ...e,
          methods: e.methods.map((m) => ({ ...m, value: go(m.value, env) })),
          body: go(e.body, env),
        }
    }
  }

  const expr = go(root, new Map())
  let count = 0
  const fusions: FusionStat[] = []
  for (const [rule, c] of counts) {
    count += c
    fusions.push({ rule, count: c })
  }
  fusions.sort((x, y) => y.count - x.count || x.rule.localeCompare(y.rule))
  return { expr, count, fusions }
}
