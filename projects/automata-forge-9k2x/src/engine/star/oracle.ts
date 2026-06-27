// A SECOND, structurally-independent path-existence engine — the differential oracle for the CTL*
// model checker, in the same spirit as the CTL mode's SCC oracle for its fixpoint checker.
//
// The production engine (`pathexist.ts`) decides "∃ a path from s satisfying ρ" by the Logic mode's
// on-the-fly product search: a BFS that grows the stem, then a second BFS that hunts a loop back to
// each reachable accepting state. This oracle decides the SAME question by a DIFFERENT algorithm —
// **Tarjan strongly-connected components** of the product graph:
//
//   ∃ accepting run from s  ⇔  some accepting product state is reachable from an initial product
//                              state AND lies on a cycle (its SCC is non-trivial, or it self-loops).
//
// (An accepting run visits an accepting state infinitely often ⇒ that state lies on a cycle reachable
// from the start; conversely, looping a reachable on-cycle accepting state forever is an accepting
// run.) On top of the SCC verdict, every *positive* answer is independently re-validated: we extract
// the witnessing lasso and replay its ω-word through the direct LTL semantics (`evalLtlOnLasso`) —
// the same ground-truth oracle the Logic mode's self-test trusts — so a "yes" is never taken on the
// automaton's word alone.

import type { Core, Ltl } from '../ltl/formula'
import type { BA } from '../ltl/buchi'
import { satGuard } from '../ltl/buchi'
import { buildBuchi } from '../ltl/modelcheck'
import { evalLtlOnLasso } from '../ltl/semantics'
import type { CtlModel } from '../ctl/modelcheck'
import type { Holds, Lasso, PathExistFn, PathExistResult } from './pathexist'

/** Rebuild the LTL surface formula a `Core` (NNF) automaton accepts — for the direct-semantics replay. */
export function coreToLtl(c: Core): Ltl {
  switch (c.k) {
    case 'true':
      return { k: 'true' }
    case 'false':
      return { k: 'false' }
    case 'lit':
      return c.neg ? { k: 'not', a: { k: 'atom', name: c.atom } } : { k: 'atom', name: c.atom }
    case 'and':
      return { k: 'and', a: coreToLtl(c.a), b: coreToLtl(c.b) }
    case 'or':
      return { k: 'or', a: coreToLtl(c.a), b: coreToLtl(c.b) }
    case 'next':
      return { k: 'next', a: coreToLtl(c.a) }
    case 'until':
      return { k: 'until', a: coreToLtl(c.a), b: coreToLtl(c.b) }
    case 'release':
      return { k: 'release', a: coreToLtl(c.a), b: coreToLtl(c.b) }
  }
}

/** Atoms mentioned in an LTL formula (for projecting model states onto letters). */
function atomsOfLtl(f: Ltl): string[] {
  const set = new Set<string>()
  const walk = (x: Ltl) => {
    switch (x.k) {
      case 'atom':
        set.add(x.name)
        break
      case 'true':
      case 'false':
        break
      case 'not':
      case 'next':
      case 'fin':
      case 'glob':
        walk(x.a)
        break
      default:
        walk(x.a)
        walk(x.b)
    }
  }
  walk(f)
  return [...set]
}

/** Iterative Tarjan SCC over a graph given as dense adjacency; returns a component id + size per node. */
function tarjan(adj: number[][]): { comp: number[]; sizes: number[] } {
  const N = adj.length
  const comp = new Array<number>(N).fill(-1)
  const index = new Array<number>(N).fill(-1)
  const low = new Array<number>(N).fill(0)
  const onStack = new Array<boolean>(N).fill(false)
  const stack: number[] = []
  const sizes: number[] = []
  let idx = 0
  let nComp = 0
  for (let v0 = 0; v0 < N; v0++) {
    if (index[v0] !== -1) continue
    const callStack: { v: number; i: number }[] = [{ v: v0, i: 0 }]
    index[v0] = low[v0] = idx++
    stack.push(v0)
    onStack[v0] = true
    while (callStack.length) {
      const frame = callStack[callStack.length - 1]
      const v = frame.v
      if (frame.i < adj[v].length) {
        const w = adj[v][frame.i++]
        if (index[w] === -1) {
          index[w] = low[w] = idx++
          stack.push(w)
          onStack[w] = true
          callStack.push({ v: w, i: 0 })
        } else if (onStack[w]) {
          low[v] = Math.min(low[v], index[w])
        }
      } else {
        if (low[v] === index[v]) {
          let size = 0
          for (;;) {
            const w = stack.pop()!
            onStack[w] = false
            comp[w] = nComp
            size++
            if (w === v) break
          }
          sizes[nComp] = size
          nComp++
        }
        callStack.pop()
        if (callStack.length) {
          const parent = callStack[callStack.length - 1].v
          low[parent] = Math.min(low[parent], low[v])
        }
      }
    }
  }
  return { comp, sizes }
}

/** Decide ∃-path-from-s for every s, by SCC analysis of the product M ⊗ A(ρ), with witness replay. */
function emptinessBySCC(ba: BA, model: CtlModel, holds: Holds, formula: Ltl): PathExistResult {
  const M = model.n
  const enc = (b: number, m: number) => b * M + m
  const decM = (id: number) => id % M
  const decB = (id: number) => Math.floor(id / M)
  const valid = (b: number, m: number) => satGuard(ba.states[b].label, (atom) => holds(m, atom))
  const prodSucc = (id: number): number[] => {
    const b = decB(id)
    const m = decM(id)
    const out: number[] = []
    for (const b2 of ba.states[b].next) for (const m2 of model.succ[m]) if (valid(b2, m2)) out.push(enc(b2, m2))
    return out
  }
  const atoms = atomsOfLtl(formula)
  const letterAt = (m: number): Set<string> => new Set(atoms.filter((a) => holds(m, a)))

  const sat = new Array<boolean>(M).fill(false)
  const witness: (Lasso | null)[] = new Array(M).fill(null)
  let productStates = 0

  for (let s = 0; s < M; s++) {
    // Initial product states for the single start state s.
    const inits: number[] = []
    for (const b of ba.initial) if (valid(b, s)) inits.push(enc(b, s))
    if (inits.length === 0) continue

    // BFS the reachable product, recording dense indices + a parent for stem reconstruction.
    const denseOf = new Map<number, number>()
    const ids: number[] = []
    const parent: number[] = []
    const queue: number[] = []
    const see = (id: number, parDense: number) => {
      if (denseOf.has(id)) return
      denseOf.set(id, ids.length)
      parent.push(parDense) // parent is a DENSE index (or -1), so the stem walk below stays in-range
      ids.push(id)
      queue.push(id)
    }
    for (const id of inits) see(id, -1)
    let qh = 0
    while (qh < queue.length) {
      const u = queue[qh++]
      const du = denseOf.get(u)!
      for (const v of prodSucc(u)) see(v, du)
    }
    productStates = Math.max(productStates, ids.length)

    // Tarjan over the reachable subgraph.
    const adj = ids.map((id) => prodSucc(id).map((v) => denseOf.get(v)!))
    const { comp, sizes } = tarjan(adj)
    const onCycle = (di: number): boolean =>
      sizes[comp[di]] > 1 || adj[di].includes(di)

    // An accepting product state on a cycle ⇒ an accepting run exists.
    let anchor = -1
    for (let di = 0; di < ids.length; di++) {
      if (ba.accept.has(decB(ids[di])) && onCycle(di)) {
        anchor = di
        break
      }
    }
    if (anchor < 0) continue

    // Stem: init → … → anchor (dense indices), via the BFS parent pointers.
    const stem: number[] = []
    for (let cur = anchor; cur !== -1; cur = parent[cur]) stem.push(cur)
    stem.reverse()
    // Loop: a shortest cycle anchor → … → anchor.
    const loop = shortestCycle(adj, anchor)
    if (!loop) continue

    const prefixM = stem.slice(0, -1).map((di) => decM(ids[di]))
    const loopM = loop.map((di) => decM(ids[di]))
    // Independent re-validation: the projected ω-word must satisfy the formula by direct semantics.
    const prefixL = prefixM.map(letterAt)
    const loopL = loopM.map(letterAt)
    if (!evalLtlOnLasso(formula, prefixL, loopL)) continue

    sat[s] = true
    witness[s] = { prefix: prefixM, loop: loopM }
  }
  return { sat, witness, productStates }
}

/** A shortest cycle anchor → … → anchor (dense indices), anchor listed first; null if none. */
function shortestCycle(adj: number[][], anchor: number): number[] | null {
  const back = new Map<number, number>()
  const queue: number[] = []
  for (const v of adj[anchor]) {
    if (v === anchor) return [anchor]
    if (!back.has(v)) {
      back.set(v, anchor)
      queue.push(v)
    }
  }
  let qh = 0
  while (qh < queue.length) {
    const u = queue[qh++]
    for (const v of adj[u]) {
      if (v === anchor) {
        const seg: number[] = [u]
        let cur = u
        while (back.get(cur) !== anchor) {
          cur = back.get(cur)!
          seg.push(cur)
        }
        seg.push(anchor)
        seg.reverse() // [anchor, …, u]
        return seg
      }
      if (!back.has(v)) {
        back.set(v, u)
        queue.push(v)
      }
    }
  }
  return null
}

/** The differential oracle: GPVW automaton, SCC-based emptiness, direct-semantics witness replay. */
export const pathExistOracle: PathExistFn = (core, _ltl, model, holds) => {
  const { ba } = buildBuchi(core)
  return emptinessBySCC(ba, model, holds, coreToLtl(core))
}
