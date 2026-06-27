// Witness / counterexample certificates for CTL model checking.
//
// A certificate is a concrete *behaviour* of the model — a finite path or a lasso (stem + repeated
// loop) — annotated, at each state, with the subformulas that must hold there. Existential
// obligations are *expanded* into real transitions:
//
//   • EX ψ      → one edge s → t with ψ at t.
//   • EF ψ      → a path from s to a ψ-state.
//   • E[φ U ψ]  → a path s ⇝ t through φ-states ending at a ψ-state.
//   • EG ψ      → a lasso: a stem into a cycle, every state on it a ψ-state.
//   • E[φ R ψ]  → a ψ-forever lasso, or a path through ψ to a φ∧ψ release point.
//
// Universal sub-obligations (`AX`, `AG`, …) are cited as *verified facts* at their state rather than
// expanded (a witness for "all paths …" is a tree, not a single behaviour). A formula that *fails* at
// an initial state is certified by a witness of its negation in NNF — so a violated `AG p` yields the
// explicit path to a `¬p`-state, and a violated `AF p` yields the `p`-avoiding lasso.
//
// Every claim placed on the certificate is true at its state (checked independently in the self-test),
// every consecutive pair is a real transition, and every lasso closes — so a certificate is a genuine,
// replayable proof, not a hint.

import type { Ctl } from './formula'
import { showCtl, nnf, negate } from './formula'
import type { CtlModel } from './modelcheck'
import { totalize, satVector } from './modelcheck'
import type { Kripke } from '../ltl/kripke'

/** A linear certificate: a state sequence (a path, or a lasso when `loopStart` is set). */
export interface LinearCert {
  kind: 'witness' | 'counterexample'
  goalText: string // the existential goal actually certified (φ, or ¬φ for a counterexample)
  start: number // the initial state the certificate begins at
  states: number[]
  loopStart: number | null // index where the repeated loop begins; null ⇒ a finite path
  obligations: string[][] // per-state: the subformula texts that hold there
}

interface Frag {
  states: number[]
  loopStart: number | null
  ann: string[][]
}

const PATH_SHAPED = new Set<Ctl['k']>(['EX', 'EF', 'EU', 'EG', 'ER'])

export class WitnessBuilder {
  private cache = new Map<string, boolean[]>()
  private model: CtlModel
  constructor(model: CtlModel) {
    this.model = model
  }

  /** Memoized `Sat` vector (from the production fixpoint checker — the oracle re-checks in tests). */
  private S(f: Ctl): boolean[] {
    const k = showCtl(f) // unique enough as a key here; collisions only merge identical formulas
    const hit = this.cache.get(k)
    if (hit) return hit
    const v = satVector(f, this.model)
    this.cache.set(k, v)
    return v
  }

  private local(s: number, claim: string): Frag {
    return { states: [s], loopStart: null, ann: [[claim]] }
  }

  /** Splice `cont` onto the end of `head`; they must meet at head's last state = cont's first state. */
  private splice(head: Frag, cont: Frag): Frag {
    const join = head.states.length - 1
    const states = [...head.states, ...cont.states.slice(1)]
    const ann = [...head.ann.map((a) => a.slice())]
    ann[join] = dedup([...ann[join], ...cont.ann[0]])
    for (let i = 1; i < cont.ann.length; i++) ann.push(cont.ann[i].slice())
    const loopStart = cont.loopStart !== null ? join + cont.loopStart : head.loopStart
    return { states, loopStart, ann }
  }

  /** BFS for a path s0 ⇝ t with t ∈ target, every intermediate state in `through` (or s0). */
  private reachPath(s0: number, target: boolean[], through: boolean[]): number[] | null {
    if (target[s0]) return [s0]
    const parent = new Array<number>(this.model.n).fill(-1)
    const seen = new Array<boolean>(this.model.n).fill(false)
    seen[s0] = true
    const q = [s0]
    while (q.length) {
      const u = q.shift()!
      for (const v of this.model.succ[u]) {
        if (seen[v]) continue
        if (target[v]) {
          const path = [v]
          let x = u
          while (x !== -1) {
            path.unshift(x)
            x = parent[x]
          }
          return path
        }
        if (through[v]) {
          seen[v] = true
          parent[v] = u
          q.push(v)
        }
      }
    }
    return null
  }

  /** DFS within `inSet` from s0 for a lasso (stem + cycle); returns states + the loop-start index. */
  private findLasso(s0: number, inSet: boolean[]): { states: number[]; loopStart: number } | null {
    if (!inSet[s0]) return null
    const onStack = new Array<boolean>(this.model.n).fill(false)
    const visited = new Array<boolean>(this.model.n).fill(false)
    const path: number[] = []
    const iter: number[] = []
    path.push(s0)
    iter.push(0)
    onStack[s0] = true
    visited[s0] = true
    while (path.length) {
      const v = path[path.length - 1]
      const succ = this.model.succ[v]
      let advanced = false
      while (iter[iter.length - 1] < succ.length) {
        const w = succ[iter[iter.length - 1]++]
        if (!inSet[w]) continue
        if (onStack[w]) {
          // Back-edge v → w closes a cycle. The lasso is the whole current path; loop starts at w.
          const loopStart = path.indexOf(w)
          return { states: path.slice(), loopStart }
        }
        if (!visited[w]) {
          visited[w] = true
          onStack[w] = true
          path.push(w)
          iter.push(0)
          advanced = true
          break
        }
      }
      if (!advanced && iter[iter.length - 1] >= succ.length) {
        onStack[v] = false
        path.pop()
        iter.pop()
      }
    }
    return null
  }

  /** Build a linear fragment certifying that `goal` (assumed in NNF) holds at `s0`, or null. */
  build(goal: Ctl, s0: number): Frag | null {
    const label = showCtl(goal)
    switch (goal.k) {
      case 'true':
        return this.local(s0, '⊤')
      case 'atom':
        return this.local(s0, goal.name)
      case 'not':
        // NNF ⇒ this is ¬atom.
        return this.local(s0, label)
      case 'and': {
        const a = goal.a
        const b = goal.b
        const aPath = PATH_SHAPED.has(a.k)
        const bPath = PATH_SHAPED.has(b.k)
        if (aPath && !bPath) return this.annotate(this.build(a, s0), b, s0)
        if (bPath && !aPath) return this.annotate(this.build(b, s0), a, s0)
        if (!aPath && !bPath) {
          const fa = this.build(a, s0)
          const fb = this.build(b, s0)
          if (!fa || !fb) return null
          return { states: [s0], loopStart: null, ann: [dedup([...fa.ann[0], ...fb.ann[0]])] }
        }
        // Both path-shaped: expand a, cite b as a fact at s0.
        return this.annotateText(this.build(a, s0), showCtl(b))
      }
      case 'or': {
        const a = this.S(goal.a)
        const pick = a[s0] ? goal.a : goal.b
        return this.build(pick, s0)
      }
      case 'EX': {
        const sub = this.S(goal.a)
        const t = this.model.succ[s0].find((x) => sub[x])
        if (t === undefined) return null
        const head: Frag = { states: [s0, t], loopStart: null, ann: [[label], []] }
        const cont = this.build(goal.a, t)
        return cont ? this.splice(head, cont) : head
      }
      case 'EF': {
        const sub = this.S(goal.a)
        const path = this.reachPath(s0, sub, allTrue(this.model.n))
        if (!path) return null
        const head = this.fromPath(path, label, () => [])
        const cont = this.build(goal.a, path[path.length - 1])
        return cont ? this.splice(head, cont) : head
      }
      case 'EU': {
        const phi = this.S(goal.a)
        const psi = this.S(goal.b)
        const path = this.reachPath(s0, psi, phi)
        if (!path) return null
        const phiText = showCtl(goal.a)
        const head = this.fromPath(path, label, () => [phiText])
        const cont = this.build(goal.b, path[path.length - 1])
        return cont ? this.splice(head, cont) : head
      }
      case 'EG': {
        const inv = this.S(goal.a)
        const lasso = this.findLasso(s0, inv)
        if (!lasso) return null
        const invText = showCtl(goal.a)
        const ann = lasso.states.map((_, i) => (i === 0 ? [label, invText] : [invText]))
        return { states: lasso.states, loopStart: lasso.loopStart, ann }
      }
      case 'ER': {
        // E[φ R ψ] = EG ψ ∨ E[ψ U (φ∧ψ)].
        const egPsi = this.S({ k: 'EG', a: goal.b })
        if (egPsi[s0]) {
          const f = this.build({ k: 'EG', a: goal.b }, s0)
          return f ? this.annotateText(f, label) : null
        }
        const release: Ctl = { k: 'EU', a: goal.b, b: { k: 'and', a: goal.a, b: goal.b } }
        const f = this.build(release, s0)
        return f ? this.annotateText(f, label) : null
      }
      // Universal modalities are cited as verified facts (a witness for "all paths" is a tree).
      // imp/iff never reach here (the goal is in NNF) but are listed so the switch is exhaustive.
      case 'AX':
      case 'AF':
      case 'AG':
      case 'AU':
      case 'AR':
      case 'imp':
      case 'iff':
      case 'false':
        return this.local(s0, label)
    }
  }

  /** Turn an explicit path into a fragment, labelling state 0 with `head` and each interior via `mid`. */
  private fromPath(path: number[], head: string, mid: (i: number) => string[]): Frag {
    const ann = path.map((_, i) => (i === 0 ? [head, ...mid(i)] : i < path.length - 1 ? mid(i) : []))
    return { states: path, loopStart: null, ann }
  }

  /** Add a local sub-obligation `extra` (expanded for its annotation only) at the fragment's start. */
  private annotate(frag: Frag | null, extra: Ctl, s0: number): Frag | null {
    if (!frag) return null
    const ef = this.build(extra, s0)
    if (!ef) return frag
    const ann = frag.ann.map((a) => a.slice())
    ann[0] = dedup([...ann[0], ...ef.ann[0]])
    return { ...frag, ann }
  }

  private annotateText(frag: Frag | null, text: string): Frag | null {
    if (!frag) return null
    const ann = frag.ann.map((a) => a.slice())
    ann[0] = dedup([text, ...ann[0]])
    return { ...frag, ann }
  }
}

const allTrue = (n: number) => new Array<boolean>(n).fill(true)
const dedup = (xs: string[]) => [...new Set(xs)]

/**
 * Produce a certificate for `formula` against `k`. If the formula holds at an initial state we
 * witness it there; if it fails, we witness its NNF-negation (a counterexample). Returns null when
 * the (oriented) goal is purely universal and has no single-behaviour certificate.
 */
export function certify(formula: Ctl, k: Kripke): LinearCert | null {
  const model = totalize(k)
  const sat = satVector(formula, model)
  const holdsEverywhere = model.initial.every((s) => sat[s])

  let kind: LinearCert['kind']
  let goal: Ctl
  let s0: number
  if (holdsEverywhere) {
    kind = 'witness'
    goal = nnf(formula)
    s0 = model.initial[0]
  } else {
    kind = 'counterexample'
    goal = nnf(negate(formula))
    s0 = model.initial.find((s) => !sat[s]) ?? model.initial[0]
  }

  const builder = new WitnessBuilder(model)
  const frag = builder.build(goal, s0)
  if (!frag) return null
  return {
    kind,
    goalText: showCtl(goal),
    start: s0,
    states: frag.states,
    loopStart: frag.loopStart,
    obligations: frag.ann,
  }
}
