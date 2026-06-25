// LTL → Büchi: the classic tableau construction of Gerth, Peled, Vardi & Wolper, "Simple On-the-fly
// Automatic Verification of Linear Temporal Logic" (PSTV 1995) — the algorithm at the heart of every
// explicit-state model checker (SPIN's original `ltl2ba` is this construction).
//
// The idea: a state of the automaton is a set of subformulas that are promised to hold from here on.
// We grow states by repeatedly *decomposing* each promise into what must hold *now* (literals, added
// to the state's guard) and what must hold *from the next step* (collected into `Next`). The local
// expansion rules are just the temporal "unrollings":
//
//     a U b  ≡  b ∨ (a ∧ X(a U b))          (b now, or a now and keep waiting)
//     a R b  ≡  b ∧ (a ∨ X(a R b))          (b always, until a releases it)
//
// Disjunctions (and the two unrollings) split a state in two. When a state has nothing left to
// decompose, its `Next` set seeds a successor. Two states with the same Old/Next are merged, which is
// what makes the construction terminate (the subformula closure is finite).
//
// Acceptance is *generalized* Büchi: one set per `a U b` subformula, forcing the "eventually b" to be
// discharged rather than postponed forever — a state is in that set iff it already has b, or it isn't
// even promising `a U b`.

import type { Core } from './formula'
import {
  addCore,
  coreKey,
  hasCore,
  negLitKey,
  sameCoreSet,
  untilSubformulas,
} from './formula'
import type { GBA, GBAState, Lit } from './buchi'
import { showCore } from './formula'

const INIT = -1 // the sentinel predecessor name marking an initial state

interface Node {
  name: number
  incoming: Set<number>
  toDo: Core[] // "New": promises not yet decomposed
  done: Core[] // "Old": promises already decomposed (the state's identity)
  next: Core[] // "Next": promises deferred to the successor
}

/** The split for a disjunctive/temporal formula: [now on branch 1, next on branch 1, now on branch 2]. */
function splitRules(eta: Core): [Core[], Core[], Core[]] {
  switch (eta.k) {
    case 'or':
      return [[eta.a], [], [eta.b]]
    case 'until':
      // a U b: either b now, or (a now and a U b next).
      return [[eta.a], [eta], [eta.b]]
    case 'release':
      // a R b: b now and (a now [released], or a R b next).
      return [[eta.b], [eta], [eta.a, eta.b]]
    default:
      return [[], [], []]
  }
}

export interface TranslateResult {
  gba: GBA
  overflow: boolean // the construction was capped (formula too large)
}

/** Build a generalized Büchi automaton from a Core (NNF) formula via the GPVW tableau. */
export function gpvw(phi: Core): TranslateResult {
  let counter = 0
  const newName = () => counter++
  const result = new Map<number, Node>()
  let overflow = false

  const expand = (node: Node): void => {
    if (overflow) return
    if (counter > 200000 || result.size > 8000) {
      overflow = true
      return
    }

    if (node.toDo.length === 0) {
      // Fully decomposed: merge into an equivalent finished state, or commit it + seed a successor.
      for (const q of result.values()) {
        if (sameCoreSet(q.done, node.done) && sameCoreSet(q.next, node.next)) {
          for (const x of node.incoming) q.incoming.add(x)
          return
        }
      }
      result.set(node.name, node)
      expand({
        name: newName(),
        incoming: new Set([node.name]),
        toDo: [...node.next],
        done: [],
        next: [],
      })
      return
    }

    const eta = node.toDo[0]
    const rest = node.toDo.slice(1)
    if (hasCore(node.done, eta)) {
      expand({ ...node, toDo: rest })
      return
    }

    switch (eta.k) {
      case 'true':
        expand({ ...node, toDo: rest, done: addCore(node.done, eta) })
        return
      case 'false':
        return // a contradiction — drop this branch
      case 'lit': {
        if (node.done.some((x) => coreKey(x) === negLitKey(eta))) return // p ∧ ¬p — drop
        expand({ ...node, toDo: rest, done: addCore(node.done, eta) })
        return
      }
      case 'and': {
        let td = rest
        if (!hasCore(node.done, eta.a)) td = addCore(td, eta.a)
        if (!hasCore(node.done, eta.b)) td = addCore(td, eta.b)
        expand({ ...node, toDo: td, done: addCore(node.done, eta) })
        return
      }
      case 'next':
        expand({
          ...node,
          toDo: rest,
          done: addCore(node.done, eta),
          next: addCore(node.next, eta.a),
        })
        return
      case 'or':
      case 'until':
      case 'release': {
        const [new1, next1, new2] = splitRules(eta)
        const td1 = new1.reduce((acc, x) => (hasCore(node.done, x) ? acc : addCore(acc, x)), rest)
        const nx1 = next1.reduce((acc, x) => addCore(acc, x), node.next)
        const td2 = new2.reduce((acc, x) => (hasCore(node.done, x) ? acc : addCore(acc, x)), rest)
        expand({
          name: newName(),
          incoming: new Set(node.incoming),
          toDo: td1,
          done: addCore(node.done, eta),
          next: nx1,
        })
        expand({
          name: newName(),
          incoming: new Set(node.incoming),
          toDo: td2,
          done: addCore(node.done, eta),
          next: [...node.next],
        })
        return
      }
    }
  }

  expand({ name: newName(), incoming: new Set([INIT]), toDo: [phi], done: [], next: [] })

  return { gba: assemble(phi, result), overflow }
}

/** Turn the finished tableau nodes into a GBA: contiguous ids, edges from `incoming`, acceptance sets. */
function assemble(phi: Core, result: Map<number, Node>): GBA {
  const nodes = [...result.values()]
  const idOf = new Map<number, number>()
  nodes.forEach((n, i) => idOf.set(n.name, i))

  const atoms = new Set<string>()
  const states: GBAState[] = nodes.map((n, i) => {
    const label: Lit[] = []
    const seen = new Set<string>()
    for (const f of n.done) {
      if (f.k === 'lit') {
        const key = (f.neg ? '!' : '') + f.atom
        if (!seen.has(key)) {
          seen.add(key)
          label.push({ atom: f.atom, neg: f.neg })
        }
        atoms.add(f.atom)
      }
    }
    const state: GBAState = { id: i, label, next: [], old: n.done.map(showCore) }
    return state
  })

  // Edges: X → Y whenever X's name is in Y's incoming set. Initial: INIT ∈ incoming.
  const initial: number[] = []
  const edgeSeen = nodes.map(() => new Set<number>())
  nodes.forEach((n, yi) => {
    for (const pred of n.incoming) {
      if (pred === INIT) {
        if (!initial.includes(yi)) initial.push(yi)
        continue
      }
      const xi = idOf.get(pred)
      if (xi === undefined) continue
      if (!edgeSeen[xi].has(yi)) {
        edgeSeen[xi].add(yi)
        states[xi].next.push(yi)
      }
    }
  })

  // Generalized acceptance: one set per `a U b` subformula of φ.
  const untils = untilSubformulas(phi)
  const acceptSets: Set<number>[] = untils.map((mu) => {
    const F = new Set<number>()
    nodes.forEach((n, i) => {
      // A state discharges μ = a U b if it has b, or it is not (any longer) promising μ.
      if (hasCore(n.done, mu.b) || !hasCore(n.done, mu)) F.add(i)
    })
    return F
  })

  return { states, initial, acceptSets, atoms: [...atoms].sort() }
}
