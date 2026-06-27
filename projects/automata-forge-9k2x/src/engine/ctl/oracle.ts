// A SECOND, structurally-independent CTL evaluator — the differential oracle for `modelcheck.ts`.
//
// Where the labelling algorithm decides every temporal operator by iterating a *symbolic* pre-image
// operator over the whole state-set (a monotone Boolean-array fixpoint), this one decides them by
// **explicit graph search** on the transition relation:
//
//   • EF ψ           — backward BFS: which states can *reach* a ψ-state (on the reverse graph).
//   • E[φ U ψ]       — backward BFS from the ψ-states, expanding only through φ-states.
//   • EG ψ           — SCC analysis: a state with an infinite φ-path is one that can reach a cycle
//                      inside the subgraph induced by ψ-states (Tarjan's strongly-connected
//                      components, plus self-loops).
//   • the universal / release operators — via the standard CTL dualities, reduced to the three above.
//
// Two engines that share no code agreeing across thousands of random (model, formula) pairs is the
// differential proof the rest of the lab lives by.

import type { Ctl } from './formula'
import { ctlKey } from './formula'
import type { CtlModel } from './modelcheck'

/** Reverse adjacency: `pred[t]` = the states with an edge into `t`. */
function predecessors(m: CtlModel): number[][] {
  const pred: number[][] = Array.from({ length: m.n }, () => [])
  for (let s = 0; s < m.n; s++) for (const t of m.succ[s]) pred[t].push(s)
  return pred
}

const not = (b: boolean[]) => b.map((v) => !v)
const and = (a: boolean[], b: boolean[]) => a.map((v, i) => v && b[i])
const or = (a: boolean[], b: boolean[]) => a.map((v, i) => v || b[i])

/** EX: some successor lies in `set`. */
function exists1(m: CtlModel, set: boolean[]): boolean[] {
  return m.succ.map((s) => s.some((t) => set[t]))
}
/** AX: every successor lies in `set` (the relation is total, so "all" is never vacuous). */
function forall1(m: CtlModel, set: boolean[]): boolean[] {
  return m.succ.map((s) => s.every((t) => set[t]))
}

/** EF: backward BFS — the states from which a `target` state is reachable (targets included). */
function efReach(m: CtlModel, pred: number[][], target: boolean[]): boolean[] {
  const seen = target.slice()
  const work: number[] = []
  for (let i = 0; i < m.n; i++) if (seen[i]) work.push(i)
  while (work.length) {
    const s = work.pop()!
    for (const p of pred[s]) if (!seen[p]) {
      seen[p] = true
      work.push(p)
    }
  }
  return seen
}

/** E[φ U ψ]: backward BFS from the ψ-states, expanding to a predecessor only if it is a φ-state. */
function euReach(m: CtlModel, pred: number[][], phi: boolean[], psi: boolean[]): boolean[] {
  const seen = psi.slice()
  const work: number[] = []
  for (let i = 0; i < m.n; i++) if (seen[i]) work.push(i)
  while (work.length) {
    const s = work.pop()!
    for (const p of pred[s]) if (!seen[p] && phi[p]) {
      seen[p] = true
      work.push(p)
    }
  }
  return seen
}

/** Tarjan's SCCs restricted to the subgraph induced by `inSet`; returns a component id per vertex. */
function sccInduced(m: CtlModel, inSet: boolean[]): { comp: number[]; sizes: number[] } {
  const comp = new Array<number>(m.n).fill(-1)
  const index = new Array<number>(m.n).fill(-1)
  const low = new Array<number>(m.n).fill(0)
  const onStack = new Array<boolean>(m.n).fill(false)
  const stack: number[] = []
  const sizes: number[] = []
  let idx = 0
  let nComp = 0

  // Iterative Tarjan so arbitrarily large fuzz models can't overflow the call stack.
  for (let v0 = 0; v0 < m.n; v0++) {
    if (!inSet[v0] || index[v0] !== -1) continue
    const callStack: { v: number; i: number }[] = [{ v: v0, i: 0 }]
    index[v0] = low[v0] = idx++
    stack.push(v0)
    onStack[v0] = true
    while (callStack.length) {
      const frame = callStack[callStack.length - 1]
      const v = frame.v
      const succ = m.succ[v]
      if (frame.i < succ.length) {
        const w = succ[frame.i++]
        if (!inSet[w]) continue
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

/** EG ψ: states with an infinite path staying in `psi` — i.e. that can reach a cycle inside `psi`. */
function egSearch(m: CtlModel, pred: number[][], psi: boolean[]): boolean[] {
  const { comp, sizes } = sccInduced(m, psi)
  // A vertex is "recurrent" if it sits in a non-trivial SCC, or has a self-loop within psi.
  const recurrent = new Array<boolean>(m.n).fill(false)
  for (let v = 0; v < m.n; v++) {
    if (!psi[v]) continue
    if (comp[v] >= 0 && sizes[comp[v]] > 1) recurrent[v] = true
    else if (m.succ[v].includes(v)) recurrent[v] = true
  }
  // Backward-reach the recurrent set, staying inside psi.
  return euReach(m, pred, psi, recurrent)
}

/** Evaluate `Sat(formula)` by explicit graph search. Memoized by canonical key within the call. */
export function oracleSat(formula: Ctl, m: CtlModel): boolean[] {
  const pred = predecessors(m)
  const memo = new Map<string, boolean[]>()
  const ev = (f: Ctl): boolean[] => {
    const key = ctlKey(f)
    const hit = memo.get(key)
    if (hit) return hit
    let out: boolean[]
    switch (f.k) {
      case 'true':
        out = new Array<boolean>(m.n).fill(true)
        break
      case 'false':
        out = new Array<boolean>(m.n).fill(false)
        break
      case 'atom':
        out = m.props.map((p) => p.has(f.name))
        break
      case 'not':
        out = not(ev(f.a))
        break
      case 'and':
        out = and(ev(f.a), ev(f.b))
        break
      case 'or':
        out = or(ev(f.a), ev(f.b))
        break
      case 'imp':
        out = or(not(ev(f.a)), ev(f.b))
        break
      case 'iff': {
        const a = ev(f.a)
        const b = ev(f.b)
        out = a.map((v, i) => v === b[i])
        break
      }
      case 'EX':
        out = exists1(m, ev(f.a))
        break
      case 'AX':
        out = forall1(m, ev(f.a))
        break
      case 'EF':
        out = efReach(m, pred, ev(f.a))
        break
      case 'AF':
        // AF ψ = ¬ EG ¬ψ
        out = not(egSearch(m, pred, not(ev(f.a))))
        break
      case 'EG':
        out = egSearch(m, pred, ev(f.a))
        break
      case 'AG':
        // AG ψ = ¬ EF ¬ψ
        out = not(efReach(m, pred, not(ev(f.a))))
        break
      case 'EU':
        out = euReach(m, pred, ev(f.a), ev(f.b))
        break
      case 'AU': {
        // A[φ U ψ] = ¬( E[¬ψ U (¬φ ∧ ¬ψ)] ∨ EG ¬ψ )
        const nphi = not(ev(f.a))
        const npsi = not(ev(f.b))
        out = not(or(euReach(m, pred, npsi, and(nphi, npsi)), egSearch(m, pred, npsi)))
        break
      }
      case 'ER': {
        // E[φ R ψ] = E[ψ U (φ ∧ ψ)] ∨ EG ψ
        const phi = ev(f.a)
        const psi = ev(f.b)
        out = or(euReach(m, pred, psi, and(phi, psi)), egSearch(m, pred, psi))
        break
      }
      case 'AR': {
        // A[φ R ψ] = ¬ E[¬φ U ¬ψ]
        out = not(euReach(m, pred, not(ev(f.a)), not(ev(f.b))))
        break
      }
    }
    memo.set(key, out)
    return out
  }
  return ev(formula)
}
