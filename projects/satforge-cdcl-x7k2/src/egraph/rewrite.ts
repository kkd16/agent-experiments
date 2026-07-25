// The rewriting layer on top of the e-graph: pattern **e-matching**, the
// **equality-saturation** fixpoint, cost-based **extraction**, and an equality
// **prover**. Together these are the "egg" recipe: grow one e-graph by applying
// every rewrite everywhere at once (never destroying the left-hand side, so the
// rewrites don't fight each other), until it saturates — then read the cheapest
// term back out. Because a rewrite only ever *adds* an equality, two terms are
// provably equal exactly when they land in the same e-class.

import type { Term } from './term'
import { isPatternVar, printTerm } from './term'
import { EGraph } from './egraph'
import type { EClassId, ENode } from './egraph'

/** A rewrite rule `lhs → rhs`. Both sides are terms whose `?x` leaves are holes. */
export interface Rewrite {
  name: string
  lhs: Term
  rhs: Term
}

type Subst = Map<string, EClassId>

// ---------------------------------------------------------------------------
// E-matching: find every way a pattern matches a term inside an e-class.
// ---------------------------------------------------------------------------

function ematch(pat: Term, id: EClassId, eg: EGraph, subst: Subst): Subst[] {
  if (isPatternVar(pat.op)) {
    const bound = subst.get(pat.op)
    if (bound !== undefined) return eg.equiv(bound, id) ? [subst] : []
    const s = new Map(subst)
    s.set(pat.op, eg.find(id))
    return [s]
  }
  const out: Subst[] = []
  for (const node of eg.nodesOf(id)) {
    if (node.op !== pat.op || node.children.length !== pat.args.length) continue
    let partial: Subst[] = [subst]
    for (let i = 0; i < pat.args.length; i++) {
      const next: Subst[] = []
      for (const s of partial) for (const r of ematch(pat.args[i], node.children[i], eg, s)) next.push(r)
      partial = next
      if (partial.length === 0) break
    }
    for (const s of partial) out.push(s)
  }
  return out
}

interface Match {
  rule: Rewrite
  eclass: EClassId
  subst: Subst
}

function searchAll(eg: EGraph, rules: Rewrite[]): Match[] {
  const matches: Match[] = []
  const roots = eg.liveRoots()
  for (const rule of rules) {
    for (const id of roots) {
      for (const subst of ematch(rule.lhs, id, eg, new Map())) {
        matches.push({ rule, eclass: id, subst })
      }
    }
  }
  return matches
}

/** Build the term described by `pat` under `subst`, adding it to the e-graph. */
function instantiate(pat: Term, eg: EGraph, subst: Subst): EClassId {
  if (isPatternVar(pat.op)) {
    const bound = subst.get(pat.op)
    if (bound === undefined) throw new Error(`unbound pattern var ${pat.op} in rhs`)
    return bound
  }
  const children: ENode['children'] = pat.args.map((a) => instantiate(a, eg, subst))
  return eg.add({ op: pat.op, children })
}

// ---------------------------------------------------------------------------
// Equality saturation.
// ---------------------------------------------------------------------------

export interface IterInfo {
  iter: number
  applied: number
  classes: number
  nodes: number
}

export type StopReason = 'saturated' | 'iterations' | 'nodes'

export interface SaturateResult {
  iterations: IterInfo[]
  stopReason: StopReason
}

export interface SaturateOpts {
  maxIters?: number
  maxNodes?: number
}

/** Run the read-phase / write-phase saturation loop to a fixpoint (or a cap). */
export function saturate(eg: EGraph, rules: Rewrite[], opts: SaturateOpts = {}): SaturateResult {
  const maxIters = opts.maxIters ?? 30
  const maxNodes = opts.maxNodes ?? 1000
  const iterations: IterInfo[] = []
  let stopReason: StopReason = 'iterations'

  let hitCap = false
  for (let iter = 0; iter < maxIters; iter++) {
    const matches = searchAll(eg, rules)
    const addsBefore = eg.totalAdds
    const unionsBefore = eg.totalUnions

    // Read-then-write: apply every match found this pass. Associativity +
    // distributivity can make a *single* pass explode, so we watch a cheap O(1)
    // class-count budget mid-loop and stop adding once it is blown — the graph
    // still holds everything derived up to that point, which the extractor reads.
    let applied = 0
    for (const m of matches) {
      const rhs = instantiate(m.rule.rhs, eg, m.subst)
      eg.union(rhs, m.eclass)
      applied++
      if ((applied & 63) === 0 && eg.numClasses() > maxNodes) {
        hitCap = true
        break
      }
    }
    eg.rebuild()

    iterations.push({ iter, applied, classes: eg.numClasses(), nodes: eg.numNodes() })

    // Fixpoint: a full pass that created no class and merged nothing.
    if (eg.totalAdds === addsBefore && eg.totalUnions === unionsBefore) {
      stopReason = 'saturated'
      break
    }
    if (hitCap || eg.numClasses() > maxNodes) {
      stopReason = 'nodes'
      break
    }
  }
  return { iterations, stopReason }
}

// ---------------------------------------------------------------------------
// Cost model + extraction.
// ---------------------------------------------------------------------------

/**
 * Extraction cost of an operator. Multiplication is dear and the shift is cheap,
 * so the extractor prefers strength-reduced and factored forms — the whole point
 * of running the optimizer.
 */
export function opCost(op: string): number {
  switch (op) {
    case '*':
      return 18
    case 'shl':
      return 3
    case '+':
      return 2
    case 'neg':
      return 2
    default:
      return 1 // constants and variables
  }
}

export interface Extraction {
  term: Term
  cost: number
  /** Cheapest cost found for each live class (for display / debugging). */
  cost_of: Map<EClassId, number>
}

/** Bottom-up fixpoint extractor: the cheapest term in `root`'s class. */
export function extractBest(eg: EGraph, root: EClassId): Extraction {
  const INF = Number.POSITIVE_INFINITY
  const cost = new Map<EClassId, number>()
  const best = new Map<EClassId, ENode>()
  const roots = eg.liveRoots()
  for (const id of roots) cost.set(id, INF)

  let changed = true
  while (changed) {
    changed = false
    for (const id of roots) {
      for (const node of eg.nodesOf(id)) {
        let c = opCost(node.op)
        let ok = true
        for (const ch of node.children) {
          const cc = cost.get(eg.find(ch)) ?? INF
          if (cc === INF) {
            ok = false
            break
          }
          c += cc
        }
        if (ok && c < (cost.get(id) ?? INF)) {
          cost.set(id, c)
          best.set(id, node)
          changed = true
        }
      }
    }
  }

  const build = (id: EClassId): Term => {
    const node = best.get(eg.find(id))
    if (!node) throw new Error(`no extraction for class ${id}`)
    return { op: node.op, args: node.children.map(build) }
  }

  const rootRoot = eg.find(root)
  return { term: build(rootRoot), cost: cost.get(rootRoot) ?? INF, cost_of: cost }
}

// ---------------------------------------------------------------------------
// Top-level entry points.
// ---------------------------------------------------------------------------

export interface OptimizeResult {
  eg: EGraph
  rootId: EClassId
  original: Term
  best: Term
  originalCost: number
  bestCost: number
  saturate: SaturateResult
}

/** Term size measured by the extraction cost model (so "before" is comparable). */
export function costOf(t: Term): number {
  return opCost(t.op) + t.args.reduce((s, a) => s + costOf(a), 0)
}

/** Saturate `t` under `rules`, then extract its cheapest equivalent form. */
export function optimize(t: Term, rules: Rewrite[], opts: SaturateOpts = {}): OptimizeResult {
  const eg = new EGraph()
  const rootId = eg.addTerm(t)
  eg.rebuild()
  const sat = saturate(eg, rules, opts)
  const ex = extractBest(eg, rootId)
  return {
    eg,
    rootId,
    original: t,
    best: ex.term,
    originalCost: costOf(t),
    bestCost: ex.cost,
    saturate: sat,
  }
}

export interface ProveResult {
  proved: boolean
  eg: EGraph
  saturate: SaturateResult
  lhsId: EClassId
  rhsId: EClassId
}

/** Try to prove `a ≡ b` by saturating both in one e-graph and comparing classes. */
export function prove(a: Term, b: Term, rules: Rewrite[], opts: SaturateOpts = {}): ProveResult {
  const eg = new EGraph()
  const lhsId = eg.addTerm(a)
  const rhsId = eg.addTerm(b)
  eg.rebuild()
  const sat = saturate(eg, rules, opts)
  return { proved: eg.equiv(lhsId, rhsId), eg, saturate: sat, lhsId, rhsId }
}

/** Human-readable one-liner for a rule (used in the UI). */
export function ruleLabel(r: Rewrite): string {
  return `${printTerm(r.lhs)}  →  ${printTerm(r.rhs)}`
}
