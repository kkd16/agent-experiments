// ε-NFA → DFA (subset construction) and DFA minimization (Hopcroft's algorithm).

import type { Dfa, Nfa } from './types'
import { epsilonClosure, indexNfa, move } from './nfa'

/** Canonical string key for a set of NFA states (sorted), used to deduplicate DFA states. */
function keyOf(set: Set<number>): string {
  return [...set].sort((a, b) => a - b).join(',')
}

/**
 * Subset construction. Produces a *complete* DFA: every (state, symbol) has a target, with a
 * single trap state catching all transitions that would otherwise be undefined. The trap makes
 * the machine total, which Hopcroft's algorithm needs.
 */
export function subsetConstruction(nfa: Nfa): Dfa {
  const idx = indexNfa(nfa)
  const alphabet = nfa.alphabet

  const start = epsilonClosure([nfa.start], idx)
  const stateKeys = new Map<string, number>()
  const subsets: Set<number>[] = []

  const intern = (set: Set<number>): number => {
    const k = keyOf(set)
    const existing = stateKeys.get(k)
    if (existing !== undefined) return existing
    const id = subsets.length
    stateKeys.set(k, id)
    subsets.push(set)
    return id
  }

  const startId = intern(start)
  const trans: number[][] = []
  const queue: number[] = [startId]
  // Reserve the trap as the very last state, created lazily on first need.
  let trap = -1
  const ensureTrap = (): number => {
    if (trap === -1) {
      trap = subsets.length
      subsets.push(new Set())
      stateKeys.set('∅', trap)
    }
    return trap
  }

  while (queue.length) {
    const id = queue.shift()!
    if (trans[id]) continue
    const row: number[] = new Array(alphabet.length)
    const set = subsets[id]
    if (set.size === 0) {
      // The trap loops to itself on everything.
      for (let s = 0; s < alphabet.length; s++) row[s] = id
      trans[id] = row
      continue
    }
    for (let s = 0; s < alphabet.length; s++) {
      const sym = alphabet[s]
      const next = epsilonClosure(move(set, sym, idx), idx)
      if (next.size === 0) {
        row[s] = ensureTrap()
      } else {
        const nid = intern(next)
        row[s] = nid
        if (!trans[nid]) queue.push(nid)
      }
    }
    trans[id] = row
  }

  // Make sure the trap (if created) has a row.
  if (trap !== -1 && !trans[trap]) {
    trans[trap] = new Array(alphabet.length).fill(trap)
  }

  const accepting = new Set<number>()
  subsets.forEach((set, id) => {
    if (set.has(nfa.accept)) accepting.add(id)
  })

  const label = subsets.map((set, id) =>
    id === trap ? undefined : [...set].sort((a, b) => a - b),
  )

  return {
    numStates: subsets.length,
    start: startId,
    accepting,
    trans,
    alphabet,
    label,
    trap: trap === -1 ? undefined : trap,
  }
}

/** Keep only states reachable from the start; renumber compactly. */
function pruneUnreachable(dfa: Dfa): Dfa {
  const reachable = new Set<number>([dfa.start])
  const stack = [dfa.start]
  while (stack.length) {
    const s = stack.pop()!
    for (const t of dfa.trans[s]) {
      if (!reachable.has(t)) {
        reachable.add(t)
        stack.push(t)
      }
    }
  }
  return renumber(dfa, [...reachable].sort((a, b) => a - b))
}

/**
 * Drop a "dead" trap: a non-accepting state from which no accepting state is reachable and
 * which is not the start. Transitions into it become undefined (we model that by removing the
 * state and leaving a partial DFA for *display only*). For a teaching tool a tidy diagram beats
 * a totalised one, so we strip exactly one canonical dead sink if present.
 */
function pruneDeadSink(dfa: Dfa): Dfa {
  // A state is "live" if it can reach an accepting state.
  const live = new Set<number>(dfa.accepting)
  // Reverse reachability.
  const rev: number[][] = Array.from({ length: dfa.numStates }, () => [])
  for (let s = 0; s < dfa.numStates; s++) {
    for (const t of dfa.trans[s]) rev[t].push(s)
  }
  const stack = [...dfa.accepting]
  while (stack.length) {
    const s = stack.pop()!
    for (const p of rev[s]) {
      if (!live.has(p)) {
        live.add(p)
        stack.push(p)
      }
    }
  }
  const keep: number[] = []
  for (let s = 0; s < dfa.numStates; s++) {
    if (live.has(s) || s === dfa.start) keep.push(s)
  }
  if (keep.length === dfa.numStates) return dfa
  return renumber(dfa, keep, /*allowPartial*/ true)
}

/** Renumber a DFA to the given (sorted) subset of states. */
function renumber(dfa: Dfa, keep: number[], allowPartial = false): Dfa {
  const remap = new Map<number, number>()
  keep.forEach((old, i) => remap.set(old, i))
  const keepSet = new Set(keep)

  const trans: number[][] = keep.map((old) =>
    dfa.trans[old].map((t) => {
      if (keepSet.has(t)) return remap.get(t)!
      if (allowPartial) return -1 // dropped target -> no transition (partial DFA)
      return remap.get(t)! // should not happen for reachable-only prune
    }),
  )
  const accepting = new Set<number>()
  for (const old of keep) if (dfa.accepting.has(old)) accepting.add(remap.get(old)!)
  const label = keep.map((old) => dfa.label?.[old])
  return {
    numStates: keep.length,
    start: remap.get(dfa.start)!,
    accepting,
    trans,
    alphabet: dfa.alphabet,
    label,
    trap: dfa.trap !== undefined && keepSet.has(dfa.trap) ? remap.get(dfa.trap) : undefined,
  }
}

/**
 * Hopcroft's algorithm. Refines the partition {accepting, non-accepting} until no block can be
 * split by any symbol, then collapses each block into a single state. Operates on the complete
 * DFA, so call this before pruning the trap.
 */
export function minimizeDfa(dfaIn: Dfa): Dfa {
  const dfa = pruneUnreachable(dfaIn)
  const n = dfa.numStates
  const alpha = dfa.alphabet
  if (n === 0) return dfa

  // Initial partition: accepting vs non-accepting (skip empty blocks).
  const accepting = new Set<number>()
  const nonAccepting = new Set<number>()
  for (let s = 0; s < n; s++) (dfa.accepting.has(s) ? accepting : nonAccepting).add(s)

  const partition: Set<number>[] = []
  if (accepting.size) partition.push(accepting)
  if (nonAccepting.size) partition.push(nonAccepting)

  // Worklist of (block, symbol) splitters; seed with the smaller of the two initial blocks.
  const worklist: { block: Set<number>; sym: number }[] = []
  const seed = accepting.size <= nonAccepting.size ? accepting : nonAccepting
  if (seed.size) {
    for (let s = 0; s < alpha.length; s++) worklist.push({ block: seed, sym: s })
  }

  // Precompute reverse transitions per symbol: preImage[sym].get(target) -> sources.
  const preImage: Map<number, number[]>[] = Array.from({ length: alpha.length }, () => new Map())
  for (let s = 0; s < n; s++) {
    for (let c = 0; c < alpha.length; c++) {
      const t = dfa.trans[s][c]
      const m = preImage[c]
      const arr = m.get(t)
      if (arr) arr.push(s)
      else m.set(t, [s])
    }
  }

  while (worklist.length) {
    const { block: A, sym: c } = worklist.pop()!
    // X = states that move into A on symbol c.
    const X = new Set<number>()
    for (const target of A) {
      const srcs = preImage[c].get(target)
      if (srcs) for (const s of srcs) X.add(s)
    }
    if (X.size === 0) continue

    for (let i = 0; i < partition.length; i++) {
      const Y = partition[i]
      // Split Y into (Y∩X) and (Y\X).
      const inter = new Set<number>()
      const diff = new Set<number>()
      for (const s of Y) (X.has(s) ? inter : diff).add(s)
      if (inter.size === 0 || diff.size === 0) continue

      // Replace Y with the two halves.
      partition[i] = inter
      partition.push(diff)

      // Update the worklist.
      const smaller = inter.size <= diff.size ? inter : diff
      for (let sym = 0; sym < alpha.length; sym++) {
        // If Y was queued, both halves must be; otherwise queue the smaller half.
        const yIdxInWork = worklist.findIndex((w) => w.block === Y && w.sym === sym)
        if (yIdxInWork >= 0) {
          worklist[yIdxInWork] = { block: inter, sym }
          worklist.push({ block: diff, sym })
        } else {
          worklist.push({ block: smaller, sym })
        }
      }
    }
  }

  // Build the minimized DFA from the blocks.
  const blockOf = new Array<number>(n)
  partition.forEach((block, bi) => {
    for (const s of block) blockOf[s] = bi
  })
  const m = partition.length
  const trans: number[][] = Array.from({ length: m }, () => new Array(alpha.length))
  for (let bi = 0; bi < m; bi++) {
    const rep = partition[bi].values().next().value as number
    for (let c = 0; c < alpha.length; c++) trans[bi][c] = blockOf[dfa.trans[rep][c]]
  }
  const accepting2 = new Set<number>()
  partition.forEach((block, bi) => {
    if ([...block].some((s) => dfa.accepting.has(s))) accepting2.add(bi)
  })
  // Label each merged state with the original (pruned) DFA states it contains.
  const label = partition.map((block) => [...block].sort((a, b) => a - b))

  const minimal: Dfa = {
    numStates: m,
    start: blockOf[dfa.start],
    accepting: accepting2,
    trans,
    alphabet: alpha,
    label,
  }
  // Tidy the diagram: drop the dead trap if there is one.
  return pruneDeadSink(minimal)
}

/** Convenience: also return a display-pruned (dead-sink-free) copy of the raw DFA. */
export function prettyDfa(dfa: Dfa): Dfa {
  return pruneDeadSink(pruneUnreachable(dfa))
}
