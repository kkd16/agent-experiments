// Language algebra on two regexes: build both over a shared alphabet, take the product of their
// DFAs, and read off boolean combinations, equivalence and containment — each with a proof.
//
// The product of two complete DFAs A and B is the DFA over the same alphabet whose states are the
// reachable pairs (a, b): it runs both machines in lock-step. Whether a pair is accepting is just a
// boolean predicate on (a∈F_A, b∈F_B), so one product yields *every* boolean combination of the two
// languages — union, intersection, difference, symmetric difference — by swapping that predicate.
// Emptiness of a product language is decidable (BFS for a reachable accepting state), which makes
// equivalence (A ⊕ B = ∅) and containment (A − B = ∅) decidable too, each witnessed by the shortest
// string the BFS finds.

import type { Ast, Dfa, Sym } from './types'
import { OTHER } from './types'
import type { Alphabet } from './alphabet'
import { deriveAlphabet, symbolOf } from './alphabet'
import { buildNfa } from './nfa'
import { minimizeDfa, prettyDfa, subsetConstruction } from './dfa'

/** Boolean combiners over (a accepts, b accepts). */
export type Combine = (a: boolean, b: boolean) => boolean

export type OpId = 'union' | 'inter' | 'diffAB' | 'diffBA' | 'symdiff'

export interface OpDef {
  id: OpId
  /** Short mathematical symbol for the operator. */
  sym: string
  /** Human label. */
  label: string
  combine: Combine
}

/** The boolean operators offered in the Compare view, in display order. */
export const OPS: OpDef[] = [
  { id: 'union', sym: '∪', label: 'Union  (A or B)', combine: (a, b) => a || b },
  { id: 'inter', sym: '∩', label: 'Intersection  (A and B)', combine: (a, b) => a && b },
  { id: 'diffAB', sym: '−', label: 'Difference  (A not B)', combine: (a, b) => a && !b },
  { id: 'diffBA', sym: '−', label: 'Difference  (B not A)', combine: (a, b) => !a && b },
  { id: 'symdiff', sym: '⊕', label: 'Symmetric difference', combine: (a, b) => a !== b },
]

/**
 * The shared alphabet of two ASTs: every character either names explicitly, plus the OTHER
 * sentinel. Building each regex over this wider alphabet is semantics-preserving (see buildNfa) and
 * is what lets the two DFAs be combined symbol-for-symbol.
 */
export function combinedAlphabet(a: Ast, b: Ast): Alphabet {
  const da = deriveAlphabet(a)
  const db = deriveAlphabet(b)
  const chars = new Set<string>()
  for (const s of da.symbols) if (s !== OTHER) chars.add(s)
  for (const s of db.symbols) if (s !== OTHER) chars.add(s)
  const symbols: Sym[] = [...chars].sort((x, y) => x.charCodeAt(0) - y.charCodeAt(0))
  symbols.push(OTHER)
  const index = new Map<Sym, number>()
  symbols.forEach((s, i) => index.set(s, i))
  return { symbols, index, truncated: da.truncated || db.truncated }
}

/** Compile an AST all the way to its minimal DFA over a given alphabet. */
export function compileOver(ast: Ast, alpha: Alphabet): { full: Dfa; minimal: Dfa } {
  const nfa = buildNfa(ast, alpha)
  const full = subsetConstruction(nfa)
  return { full, minimal: minimizeDfa(full) }
}

/**
 * Totalise a DFA: every (state, symbol) gets a target. A display-pruned DFA can have missing
 * (-1) transitions where a dead sink was trimmed; we restore a single explicit trap so the product
 * construction is well-defined everywhere.
 */
export function completeDfa(dfa: Dfa): Dfa {
  let missing = false
  for (let s = 0; s < dfa.numStates && !missing; s++) {
    for (let c = 0; c < dfa.alphabet.length; c++) {
      const t = dfa.trans[s][c]
      if (t === undefined || t < 0) {
        missing = true
        break
      }
    }
  }
  if (!missing) return dfa
  const trap = dfa.numStates
  const trans = dfa.trans.map((row) => row.map((t) => (t === undefined || t < 0 ? trap : t)))
  trans.push(new Array(dfa.alphabet.length).fill(trap))
  return {
    ...dfa,
    numStates: dfa.numStates + 1,
    trans,
    trap,
    label: dfa.label ? [...dfa.label, undefined] : undefined,
  }
}

/**
 * Product of two DFAs over the same alphabet. Explores only reachable state pairs. The `combine`
 * predicate decides which product states accept, so a single call yields any boolean op.
 */
export function productDfa(aIn: Dfa, bIn: Dfa, combine: Combine): Dfa {
  const A = completeDfa(aIn)
  const B = completeDfa(bIn)
  const alphabet = A.alphabet
  const L = alphabet.length

  const idOf = new Map<number, number>()
  const pairs: [number, number][] = []
  const intern = (i: number, j: number): number => {
    const k = i * B.numStates + j
    let id = idOf.get(k)
    if (id === undefined) {
      id = pairs.length
      idOf.set(k, id)
      pairs.push([i, j])
    }
    return id
  }

  const start = intern(A.start, B.start)
  const trans: number[][] = []
  const order = [start]
  for (let head = 0; head < order.length; head++) {
    const id = order[head]
    const [i, j] = pairs[id]
    const row = new Array<number>(L)
    for (let c = 0; c < L; c++) {
      const before = pairs.length
      const nid = intern(A.trans[i][c], B.trans[j][c])
      row[c] = nid
      if (nid >= before) order.push(nid) // a freshly created pair
    }
    trans[id] = row
  }

  const accepting = new Set<number>()
  pairs.forEach(([i, j], id) => {
    if (combine(A.accepting.has(i), B.accepting.has(j))) accepting.add(id)
  })

  return {
    numStates: pairs.length,
    start,
    accepting,
    trans,
    alphabet,
    label: pairs.map((p) => [...p]),
  }
}

/** Shortest string a DFA accepts (as alphabet symbols), or null if the language is empty. */
export function shortestWitness(dfa: Dfa): Sym[] | null {
  if (dfa.accepting.has(dfa.start)) return []
  const prev = new Map<number, { from: number; sym: Sym }>()
  const seen = new Set<number>([dfa.start])
  const queue = [dfa.start]
  let found = -1
  outer: while (queue.length) {
    const s = queue.shift()!
    for (let c = 0; c < dfa.alphabet.length; c++) {
      const t = dfa.trans[s][c]
      if (t === undefined || t < 0 || seen.has(t)) continue
      seen.add(t)
      prev.set(t, { from: s, sym: dfa.alphabet[c] })
      if (dfa.accepting.has(t)) {
        found = t
        break outer
      }
      queue.push(t)
    }
  }
  if (found < 0) return null
  const path: Sym[] = []
  let cur = found
  while (cur !== dfa.start) {
    const p = prev.get(cur)!
    path.push(p.sym)
    cur = p.from
  }
  return path.reverse()
}

/** Is the DFA's language empty? */
export function isEmpty(dfa: Dfa): boolean {
  return shortestWitness(dfa) === null
}

/** Run a DFA on a sequence of alphabet symbols (not raw characters). */
export function acceptsSyms(dfa: Dfa, syms: Sym[]): boolean {
  let state = dfa.start
  for (const sym of syms) {
    const c = dfa.alphabet.indexOf(sym)
    if (c < 0) return false
    const next = dfa.trans[state][c]
    if (next === undefined || next < 0) return false
    state = next
  }
  return dfa.accepting.has(state)
}

/** Run a DFA on a raw input string (characters mapped onto the alphabet). */
export function acceptsString(dfa: Dfa, input: string, alpha: Alphabet): boolean {
  return acceptsSyms(dfa, [...input].map((ch) => symbolOf(ch, alpha)))
}

export interface Relations {
  equivalent: boolean
  aSubsetB: boolean
  bSubsetA: boolean
  disjoint: boolean
  /** Shortest string distinguishing the two languages, or null when they are equal. */
  witness: Sym[] | null
  /** Which side accepts the witness ('A' or 'B'), or null when equivalent. */
  witnessSide: 'A' | 'B' | null
}

/** Decide equivalence, both containments and disjointness, all from product emptiness checks. */
export function relations(dfaA: Dfa, dfaB: Dfa): Relations {
  const symdiff = productDfa(dfaA, dfaB, (a, b) => a !== b)
  const witness = shortestWitness(symdiff)
  const aSubsetB = isEmpty(productDfa(dfaA, dfaB, (a, b) => a && !b))
  const bSubsetA = isEmpty(productDfa(dfaA, dfaB, (a, b) => !a && b))
  const disjoint = isEmpty(productDfa(dfaA, dfaB, (a, b) => a && b))
  return {
    equivalent: witness === null,
    aSubsetB,
    bSubsetA,
    disjoint,
    witness,
    witnessSide: witness === null ? null : acceptsSyms(dfaA, witness) ? 'A' : 'B',
  }
}

export interface Comparison {
  alphabet: Alphabet
  /** Display-pruned minimal DFAs for each input, over the shared alphabet. */
  dfaA: Dfa
  dfaB: Dfa
  /** Minimal DFA for each boolean operator's result language. */
  results: Record<OpId, Dfa>
  relations: Relations
}

/** Build the whole Compare workspace: both machines, every boolean result, and the relations. */
export function compareAsts(astA: Ast, astB: Ast): Comparison {
  const alphabet = combinedAlphabet(astA, astB)
  const a = compileOver(astA, alphabet)
  const b = compileOver(astB, alphabet)
  const results = {} as Record<OpId, Dfa>
  for (const op of OPS) {
    results[op.id] = minimizeDfa(productDfa(a.full, b.full, op.combine))
  }
  return {
    alphabet,
    dfaA: prettyDfa(a.full),
    dfaB: prettyDfa(b.full),
    results,
    relations: relations(a.full, b.full),
  }
}
