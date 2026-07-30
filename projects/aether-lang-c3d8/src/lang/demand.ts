// Aether — a from-scratch DEMAND (relevance / absence) ANALYSIS
//
// A backward abstract interpretation over a *mutually-recursive group* of core
// functions (`let rec f = … and g = … and …`) that computes, per parameter, a
// **relevance signature**: is the parameter's value *Used* (it may influence the
// program's result or an observable effect) or provably *Absent* (it cannot)?
//
// This is the classic demand/absence analysis (Mycroft 1980; Peyton Jones &
// Partain; GHC's demand analyser). In a *strict* language every reachable
// argument is evaluated, so strictness itself is trivial — the actionable signal
// is **absence**: a parameter that never reaches the answer is dead work, and its
// per-iteration computation can be deleted (see the dead-argument-elimination
// pass, Aether 31.0, which this analysis powers).
//
// The engine is a **greatest fixpoint**. For each function we compute the set of
// free variables that are *needed* — that may flow to the result or an effect —
// by a structural walk (`nfv`, "needed free variables"). A parameter is Absent
// iff it is not needed. The subtlety is mutual recursion: a parameter of `f` may
// flow only into a parameter of `g` that is *itself* absent, so the two are dead
// together (`f`'s `acc` feeds `g`'s `acc` feeds `f`'s `acc`, threaded round a loop
// and thrown away). We resolve that circularity coinductively: start optimistic
// (assume *every* parameter absent), then repeatedly walk each body and demote any
// parameter we find needed under the current assumptions, until nothing changes.
// The result is the largest self-consistent set of absent parameters — sound
// because the "needed" operator is monotone in the assumption set and we take its
// least-needed (greatest-absent) fixpoint.
//
// Two dependencies are injected so this module owns no second copy of the
// optimizer's core predicates: `isPure` (evaluating an expression has no
// observable effect and terminates) and `freeVars`. The analysis is purely a
// *decision procedure* — it never rewrites anything; the optimizer consumes its
// signatures and re-proves every drop with the standing VM ≡ JS ≡ WASM
// equivalence checks and the never-increase-steps invariant.

import type { Expr, Pattern } from './ast.ts'

/** One function of the analysed group: its name, curried parameter names (outer
 *  to inner) and the body beneath all of them. */
export interface DemandFn {
  name: string
  params: string[]
  body: Expr
}

/** Injected core predicates (shared with the optimizer, never re-implemented). */
export interface DemandDeps {
  isPure: (e: Expr) => boolean
  freeVars: (e: Expr) => Set<string>
}

export interface DemandResult {
  /** function name → per-parameter flags, `true` = ABSENT (provably irrelevant),
   *  `false` = USED. Index-aligned with the function's `params`. */
  absent: Map<string, boolean[]>
}

// ---------------------------------------------------------------------------
// small local helpers (kept independent of optimize.ts internals)
// ---------------------------------------------------------------------------

function union(into: Set<string>, from: Set<string>): void {
  for (const x of from) into.add(x)
}

/** Collect the variables a pattern binds (mirrors the compiler's binder rules). */
function patVars(p: Pattern, acc: Set<string>): void {
  switch (p.kind) {
    case 'pvar':
      acc.add(p.name)
      break
    case 'pcons':
      patVars(p.head, acc)
      patVars(p.tail, acc)
      break
    case 'ptuple':
      for (const s of p.elements) patVars(s, acc)
      break
    case 'pcon':
      for (const s of p.args) patVars(s, acc)
      break
    case 'precord':
      for (const f of p.fields) patVars(f.pattern, acc)
      break
    case 'pas':
      acc.add(p.name)
      patVars(p.inner, acc)
      break
    case 'por':
      for (const alt of p.alternatives) patVars(alt, acc)
      break
    default:
      break
  }
}

/** The head variable + argument list of a (curried) application spine, or null
 *  when the spine is not headed by a variable. */
function spine(e: Expr): { name: string; args: Expr[] } | null {
  const args: Expr[] = []
  let cur: Expr = e
  while (cur.kind === 'app') {
    args.unshift(cur.arg)
    cur = cur.fn
  }
  return cur.kind === 'var' ? { name: cur.name, args } : null
}

// ---------------------------------------------------------------------------
// the analysis
// ---------------------------------------------------------------------------

/**
 * Compute the relevance signatures for a mutually-recursive group.
 *
 * Assumes the caller has already checked that no group name is shadowed inside
 * the bodies (so a `var g` unambiguously denotes the group function `g`) — that
 * is what lets the walk recognise a group call by name alone.
 */
export function analyzeAbsence(group: DemandFn[], deps: DemandDeps): DemandResult {
  const arity = new Map<string, number>()
  for (const g of group) arity.set(g.name, g.params.length)
  const names = new Set(arity.keys())

  // Optimistic start: assume every parameter is absent, then demote.
  const absent = new Map<string, boolean[]>()
  for (const g of group) absent.set(g.name, group.length === 0 ? [] : g.params.map(() => true))

  // `nfv(e)` — the free variables of `e` that are *needed*: they may influence
  // the result value or an observable effect, given the current absence
  // assumptions. Sound by construction: the only places a variable is *not*
  // counted are (a) an argument passed to a currently-absent, *pure* group-call
  // slot, and (b) the pure value of a dead `let` binding — both provably unable
  // to reach the answer or run an effect. Everything else is counted.
  const nfv = (e: Expr): Set<string> => {
    switch (e.kind) {
      case 'var':
        return new Set([e.name])
      case 'int':
      case 'float':
      case 'bool':
      case 'str':
      case 'unit':
        return new Set()
      case 'lambda': {
        const s = nfv(e.body)
        s.delete(e.param)
        return s
      }
      case 'app': {
        const sp = spine(e)
        if (sp && names.has(sp.name)) {
          const a = arity.get(sp.name)!
          // A *saturated* call to a group function: skip the arguments in its
          // currently-absent slots (when they are pure), because their values
          // cannot reach the answer. A pure argument in an absent slot is dead;
          // an impure one is kept whole (its effect could touch anything).
          if (sp.args.length === a) {
            const flags = absent.get(sp.name)!
            const out = new Set<string>([sp.name])
            for (let i = 0; i < a; i++) {
              const arg = sp.args[i]
              if (!flags[i]) union(out, nfv(arg))
              else if (!deps.isPure(arg)) union(out, deps.freeVars(arg))
            }
            return out
          }
        }
        // Any other application: the head and every argument may matter.
        return unionOf(nfv(e.fn), nfv(e.arg))
      }
      case 'if':
        return unionOf(nfv(e.cond), nfv(e.then), nfv(e.else))
      case 'binop':
        return unionOf(nfv(e.left), nfv(e.right))
      case 'unop':
        return nfv(e.operand)
      case 'seq':
        return unionOf(nfv(e.first), nfv(e.rest))
      case 'list':
      case 'tuple':
        return unionOf(...e.elements.map(nfv))
      case 'record':
        return unionOf(...e.fields.map((f) => nfv(f.value)))
      case 'field':
        return nfv(e.record)
      case 'recordUpdate':
        return unionOf(nfv(e.record), ...e.fields.map((f) => nfv(f.value)))
      case 'let': {
        const body = nfv(e.body)
        // The binding's value is needed only if the binding is actually used, or
        // if evaluating it could have an effect (a dead *pure* let is skipped).
        const valueNeeded = body.has(e.name) || !deps.isPure(e.value)
        const out = new Set(body)
        if (valueNeeded) union(out, nfv(e.value))
        out.delete(e.name)
        return out
      }
      case 'letrec': {
        // Nested groups are rare inside a function body; approximate soundly by
        // counting every binding's value, minus the bound names.
        const out = new Set(nfv(e.body))
        for (const b of e.bindings) union(out, nfv(b.value))
        for (const b of e.bindings) out.delete(b.name)
        return out
      }
      case 'match': {
        const out = new Set(nfv(e.scrutinee))
        for (const c of e.cases) {
          const pv = new Set<string>()
          patVars(c.pattern, pv)
          const cb = new Set(nfv(c.body))
          if (c.guard) union(cb, nfv(c.guard))
          for (const n of pv) cb.delete(n)
          union(out, cb)
        }
        return out
      }
      default:
        // typedecl / classdecl / instancedecl and anything unmodelled: fall back
        // to *all* free variables — never unsound, only less precise.
        return new Set(deps.freeVars(e))
    }
  }

  // Greatest fixpoint: demote absent → used until stable. Bounded by the total
  // parameter count (each pass can only flip flags one way).
  let changed = true
  let guard = 0
  const cap = group.reduce((n, g) => n + g.params.length, 0) + 2
  while (changed && guard++ <= cap) {
    changed = false
    for (const g of group) {
      const needed = nfv(g.body)
      const flags = absent.get(g.name)!
      g.params.forEach((p, i) => {
        if (flags[i] && needed.has(p)) {
          flags[i] = false
          changed = true
        }
      })
    }
  }

  return { absent }
}

function unionOf(...sets: Set<string>[]): Set<string> {
  const out = new Set<string>()
  for (const s of sets) for (const x of s) out.add(x)
  return out
}
