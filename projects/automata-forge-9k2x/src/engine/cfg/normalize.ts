// Convert a grammar to Chomsky Normal Form, capturing every stage so the UI can show the work.
//
// CNF means every production is one of: A → B C (two nonterminals), A → a (one terminal), or
// (only the start symbol) S₀ → ε. The textbook pipeline (Hopcroft–Motwani–Ullman / Wikipedia order):
//   START — a fresh start symbol that never appears on a right-hand side;
//   TERM  — hoist terminals out of long bodies into unit nonterminals N_a → a;
//   BIN   — binarise every body longer than two symbols into a right-leaning chain;
//   DEL   — delete ε-productions, generating the nullable-omission variants;
//   UNIT  — delete unit productions A → B by short-circuiting through them;
//   CLEAN — drop useless (non-generating or unreachable) symbols.

import type { Grammar, Production } from './grammar'
import { ntSetOf, freshNamer } from './grammar'
import { nullableSet, generatingSet, reachableSet } from './analyze'

export interface CnfStage {
  name: string
  note: string
  grammar: Grammar
}

const SEP = ''
const prodKey = (p: Production) => `${p.lhs}${SEP}${p.rhs.join(SEP)}`

/** Assemble a grammar from a nonterminal list + productions, recomputing the terminal set. */
function build(start: string, nts: string[], prods: Production[]): Grammar {
  // Dedup productions, preserve order.
  const seen = new Set<string>()
  const productions: Production[] = []
  for (const p of prods) {
    const k = prodKey(p)
    if (!seen.has(k)) {
      seen.add(k)
      productions.push({ lhs: p.lhs, rhs: [...p.rhs] })
    }
  }
  const ntList: string[] = []
  const ntSeen = new Set<string>()
  for (const n of nts) {
    if (!ntSeen.has(n)) {
      ntSeen.add(n)
      ntList.push(n)
    }
  }
  const ntSet = new Set(ntList)
  const terms: string[] = []
  const tSeen = new Set<string>()
  for (const p of productions) {
    for (const s of p.rhs) {
      if (!ntSet.has(s) && !tSeen.has(s)) {
        tSeen.add(s)
        terms.push(s)
      }
    }
  }
  return { start, nonterminals: ntList, terminals: terms, productions }
}

function stepStart(g: Grammar): Grammar {
  const fresh = freshNamer(g.nonterminals)
  const s0 = fresh('S0')
  return build(s0, [s0, ...g.nonterminals], [{ lhs: s0, rhs: [g.start] }, ...g.productions])
}

function stepTerm(g: Grammar): Grammar {
  const nt = ntSetOf(g)
  const fresh = freshNamer(g.nonterminals)
  const termNt = new Map<string, string>() // terminal -> its hoisting nonterminal
  const extra: Production[] = []
  const prods: Production[] = []
  for (const p of g.productions) {
    if (p.rhs.length < 2) {
      prods.push(p)
      continue
    }
    const rhs = p.rhs.map((s) => {
      if (nt.has(s)) return s
      let N = termNt.get(s)
      if (!N) {
        N = fresh(`T_${s}`)
        termNt.set(s, N)
        extra.push({ lhs: N, rhs: [s] })
      }
      return N
    })
    prods.push({ lhs: p.lhs, rhs })
  }
  return build(g.start, [...g.nonterminals, ...termNt.values()], [...prods, ...extra])
}

function stepBin(g: Grammar): Grammar {
  const fresh = freshNamer(g.nonterminals)
  const newNts: string[] = []
  const prods: Production[] = []
  for (const p of g.productions) {
    if (p.rhs.length <= 2) {
      prods.push(p)
      continue
    }
    // A -> X1 X2 ... Xk  ⇒  A -> X1 C1, C1 -> X2 C2, …, C_{k-2} -> X_{k-1} Xk
    let head = p.lhs
    for (let i = 0; i < p.rhs.length - 2; i++) {
      const next = fresh(`${p.lhs}_${i + 1}`)
      newNts.push(next)
      prods.push({ lhs: head, rhs: [p.rhs[i], next] })
      head = next
    }
    prods.push({ lhs: head, rhs: [p.rhs[p.rhs.length - 2], p.rhs[p.rhs.length - 1]] })
  }
  return build(g.start, [...g.nonterminals, ...newNts], prods)
}

function stepDel(g: Grammar): Grammar {
  const nullable = nullableSet(g)
  const prods: Production[] = []
  for (const p of g.productions) {
    if (p.rhs.length === 0) continue // drop ε-productions; re-added for the start below
    // Positions holding a nullable nonterminal: enumerate every keep/drop combination.
    const nullablePos = p.rhs.map((s, i) => (nullable.has(s) ? i : -1)).filter((i) => i >= 0)
    const combos = 1 << nullablePos.length
    for (let mask = 0; mask < combos; mask++) {
      const dropped = new Set<number>()
      nullablePos.forEach((pos, b) => {
        if (mask & (1 << b)) dropped.add(pos)
      })
      const body = p.rhs.filter((_, i) => !dropped.has(i))
      if (body.length === 0) continue // never introduce a new ε-production here
      prods.push({ lhs: p.lhs, rhs: body })
    }
  }
  // Preserve the empty word if the start symbol was nullable.
  if (nullable.has(g.start)) prods.push({ lhs: g.start, rhs: [] })
  return build(g.start, g.nonterminals, prods)
}

function stepUnit(g: Grammar): Grammar {
  const nt = ntSetOf(g)
  const isUnit = (p: Production) => p.rhs.length === 1 && nt.has(p.rhs[0])
  // Unit-reachability: pairs (A, B) with A ⇒* B using only unit productions (reflexive).
  const reaches = new Map<string, Set<string>>()
  for (const n of g.nonterminals) reaches.set(n, new Set([n]))
  let changed = true
  while (changed) {
    changed = false
    for (const p of g.productions) {
      if (!isUnit(p)) continue
      const [B] = p.rhs
      const bReach = [...(reaches.get(B) ?? [])] // snapshot — we mutate sets below
      // Anyone who reaches A=p.lhs now also reaches everything B reaches.
      for (const [, set] of reaches) {
        if (!set.has(p.lhs)) continue
        for (const x of bReach) {
          if (!set.has(x)) {
            set.add(x)
            changed = true
          }
        }
      }
    }
  }
  const prods: Production[] = []
  for (const A of g.nonterminals) {
    for (const B of reaches.get(A)!) {
      for (const p of g.productions) {
        if (p.lhs === B && !isUnit(p)) prods.push({ lhs: A, rhs: p.rhs })
      }
    }
  }
  return build(g.start, g.nonterminals, prods)
}

/** Remove non-generating then unreachable symbols (and the productions that use them). */
export function removeUseless(g: Grammar): Grammar {
  const gen = generatingSet(g)
  const keepGen = g.productions.filter((p) => gen.has(p.lhs) && p.rhs.every((s) => gen.has(s)))
  const ntsGen = g.nonterminals.filter((n) => gen.has(n))
  const g1 = build(g.start, ntsGen, keepGen)
  const reach = reachableSet(g1)
  const keepReach = g1.productions.filter((p) => reach.has(p.lhs) && p.rhs.every((s) => reach.has(s)))
  const ntsReach = g1.nonterminals.filter((n) => reach.has(n))
  return build(g1.start, ntsReach, keepReach)
}

/** The full pipeline, returning every intermediate stage (stage 0 is the input grammar). */
export function toCnfStages(g: Grammar): CnfStage[] {
  const stages: CnfStage[] = [{ name: 'Input', note: 'The grammar as written.', grammar: g }]
  const push = (name: string, note: string, grammar: Grammar) => stages.push({ name, note, grammar })

  let cur = stepStart(g)
  push('START', 'A fresh start symbol S0 → S, so the start never appears on a right-hand side.', cur)
  cur = stepTerm(cur)
  push('TERM', 'Terminals inside long bodies are hoisted into unit nonterminals N → a.', cur)
  cur = stepBin(cur)
  push('BIN', 'Bodies longer than two symbols are split into a chain of binary rules.', cur)
  cur = stepDel(cur)
  push('DEL', 'ε-productions are removed; each nullable symbol is optionally omitted from every body.', cur)
  cur = stepUnit(cur)
  push('UNIT', 'Unit productions A → B are removed by inlining B’s bodies into A.', cur)
  cur = removeUseless(cur)
  push('CLEAN', 'Useless (non-generating or unreachable) symbols are pruned. The grammar is now in CNF.', cur)
  return stages
}

/** The CNF grammar itself (last stage). */
export function toCnf(g: Grammar): Grammar {
  const stages = toCnfStages(g)
  return stages[stages.length - 1].grammar
}

/** Verify a grammar is in Chomsky Normal Form. */
export function isCnf(g: Grammar): boolean {
  const nt = ntSetOf(g)
  for (const p of g.productions) {
    if (p.rhs.length === 0) {
      if (p.lhs !== g.start) return false // only S0 → ε allowed
    } else if (p.rhs.length === 1) {
      if (nt.has(p.rhs[0])) return false // no unit productions
    } else if (p.rhs.length === 2) {
      if (!nt.has(p.rhs[0]) || !nt.has(p.rhs[1])) return false
    } else {
      return false
    }
  }
  return true
}
