// The independent oracle: answer sets by the *textbook definition*.
//
// This file computes the answer sets of a ground program from first principles —
// the Gelfond–Lifschitz reduct and the least-model fixpoint — with no reference
// whatsoever to the native solver in `solve.ts`. It is deliberately the most
// naive thing that is unarguably correct, so `selfcheck.ts` can pit the fast
// solver against it on thousands of random programs.
//
// The classic definition (for a *normal* program P, i.e. rules `h :- pos, not neg`):
//
//     reduct(P, M) = { h :- pos  |  (h :- pos, not neg) ∈ P  and  neg ∩ M = ∅ }
//     M is an answer set  ⟺  M = leastModel(reduct(P, M))   and M satisfies every constraint.
//
// `leastModel` of a definite (negation-free) program is its unique minimal model,
// computed by iterating the immediate-consequence operator T_P from ∅.
//
// Choice rules `lo { h1..hk } hi :- B` are not normal, so we *normalise* them the
// standard way — each head becomes a free even-loop choice
//
//     hi     :- B, not h̄i.
//     h̄i     :- not hi.        (h̄i a fresh auxiliary atom)
//
// which lets each head be independently in or out of the model when B holds; the
// cardinality bounds are then enforced as a post-hoc filter (a bound never
// introduces atoms, it only prunes the free choices). Auxiliary atoms are
// projected away before the answer set is reported, exactly matching the
// behaviour every ASP system agrees on (e.g. `{a}.` has answer sets `{}` and `{a}`).

import type { GroundProgram, AnswerSet } from './program'
import { answerSetKey } from './program'

interface DefiniteRule {
  head: number
  pos: number[]
  neg: number[]
}
interface CardCheck {
  heads: number[]
  lo: number | null
  hi: number | null
  pos: number[]
  neg: number[]
}

/** Normalise a program to (definite-with-negation rules + integrity constraints
 *  + cardinality post-filters) over an extended atom set that includes the fresh
 *  auxiliary atoms introduced for choice heads. */
export function normalizeForOracle(prog: GroundProgram): {
  totalAtoms: number
  rules: DefiniteRule[]
  constraints: { pos: number[]; neg: number[] }[]
  cards: CardCheck[]
} {
  const rules: DefiniteRule[] = []
  const constraints: { pos: number[]; neg: number[] }[] = []
  const cards: CardCheck[] = []
  let next = prog.numAtoms + 1
  for (const r of prog.rules) {
    if (r.kind === 'normal') {
      rules.push({ head: r.head, pos: r.pos, neg: r.neg })
    } else if (r.kind === 'constraint') {
      constraints.push({ pos: r.pos, neg: r.neg })
    } else {
      for (const h of r.heads) {
        const aux = next++
        rules.push({ head: h, pos: r.pos, neg: [...r.neg, aux] })
        rules.push({ head: aux, pos: [], neg: [h] })
      }
      if (r.lo !== null || r.hi !== null) {
        cards.push({ heads: r.heads, lo: r.lo, hi: r.hi, pos: r.pos, neg: r.neg })
      }
    }
  }
  return { totalAtoms: next - 1, rules, constraints, cards }
}

const bit = (v: number) => 1 << (v - 1)
const has = (mask: number, v: number) => (mask & bit(v)) !== 0
const allIn = (mask: number, xs: number[]) => xs.every((v) => has(mask, v))
const noneIn = (mask: number, xs: number[]) => xs.every((v) => !has(mask, v))

/** Least (minimal) model of a set of definite-with-negation rules under a fixed
 *  reduct assignment: iterate T_P from ∅, treating each rule as `head :- pos`
 *  once its negative body has already been resolved by the reduct step. */
function leastModel(reduct: { head: number; pos: number[] }[]): number {
  let model = 0
  let changed = true
  while (changed) {
    changed = false
    for (const r of reduct) {
      if (!has(model, r.head) && allIn(model, r.pos)) {
        model |= bit(r.head)
        changed = true
      }
    }
  }
  return model
}

/** The Gelfond–Lifschitz reduct of the definite rules w.r.t. a candidate M. */
function reductOf(rules: DefiniteRule[], m: number): { head: number; pos: number[] }[] {
  const out: { head: number; pos: number[] }[] = []
  for (const r of rules) {
    if (noneIn(m, r.neg)) out.push({ head: r.head, pos: r.pos })
  }
  return out
}

/** Does M satisfy the cardinality bounds of every fired choice rule? */
function cardsOk(m: number, cards: CardCheck[]): boolean {
  for (const c of cards) {
    if (allIn(m, c.pos) && noneIn(m, c.neg)) {
      let cnt = 0
      for (const h of c.heads) if (has(m, h)) cnt++
      if (c.lo !== null && cnt < c.lo) return false
      if (c.hi !== null && cnt > c.hi) return false
    }
  }
  return true
}

/**
 * Enumerate **every** answer set of a ground program by exhaustive search over
 * the extended atom set — the ground truth against which the native solver is
 * checked. Only usable for small programs (it is exponential); callers guard on
 * `totalAtoms`.
 */
export function bruteAnswerSets(prog: GroundProgram): AnswerSet[] {
  const { totalAtoms, rules, constraints, cards } = normalizeForOracle(prog)
  if (totalAtoms > 24) throw new Error(`bruteAnswerSets: ${totalAtoms} atoms is too many for exhaustive search`)
  const seen = new Set<string>()
  const results: AnswerSet[] = []
  const realBits = (1 << prog.numAtoms) - 1
  const total = 1 << totalAtoms
  for (let m = 0; m < total; m++) {
    // constraints reference only real atoms; check early to prune.
    let bad = false
    for (const c of constraints) {
      if (allIn(m, c.pos) && noneIn(m, c.neg)) {
        bad = true
        break
      }
    }
    if (bad) continue
    if (leastModel(reductOf(rules, m)) !== m) continue
    if (!cardsOk(m, cards)) continue
    const proj = m & realBits
    const set: AnswerSet = []
    for (let v = 1; v <= prog.numAtoms; v++) if (has(proj, v)) set.push(v)
    const key = answerSetKey(set)
    if (!seen.has(key)) {
      seen.add(key)
      results.push(set)
    }
  }
  results.sort((a, b) => a.length - b.length || answerSetKey(a).localeCompare(answerSetKey(b)))
  return results
}

/**
 * Independently decide whether a *specific* candidate M (given as a set of real
 * atom ids) is an answer set of the program. Used as a defence-in-depth gate:
 * every model the native solver reports is re-checked here before it is
 * accepted. Reconstructs the forced auxiliary atoms (h̄ ⟺ ¬h) and applies the
 * exact reduct/least-model test — with a boolean-array assignment so it scales
 * to grounded programs with thousands of atoms (no 32-bit mask limit).
 */
export function isAnswerSet(prog: GroundProgram, real: ReadonlyArray<number>): boolean {
  const { totalAtoms, rules, constraints, cards } = normalizeForOracle(prog)
  const asg = new Uint8Array(totalAtoms + 1)
  const realSet = new Set(real)
  for (const v of real) asg[v] = 1
  // Auxiliary atoms were appended in normalise order (aux ⟺ ¬head): recompute.
  let next = prog.numAtoms + 1
  for (const r of prog.rules) {
    if (r.kind === 'choice') {
      for (const h of r.heads) {
        const aux = next++
        if (!realSet.has(h)) asg[aux] = 1
      }
    }
  }
  const allT = (xs: number[]) => xs.every((v) => asg[v] === 1)
  const noneT = (xs: number[]) => xs.every((v) => asg[v] === 0)
  for (const c of constraints) if (allT(c.pos) && noneT(c.neg)) return false
  // least model of the reduct, over the same assignment's negative parts
  const lm = new Uint8Array(totalAtoms + 1)
  const active = rules.filter((r) => noneT(r.neg))
  let changed = true
  while (changed) {
    changed = false
    for (const r of active) {
      if (lm[r.head] === 0 && r.pos.every((v) => lm[v] === 1)) {
        lm[r.head] = 1
        changed = true
      }
    }
  }
  for (let v = 1; v <= totalAtoms; v++) if (lm[v] !== asg[v]) return false
  for (const c of cards) {
    if (allT(c.pos) && noneT(c.neg)) {
      let cnt = 0
      for (const h of c.heads) if (asg[h] === 1) cnt++
      if (c.lo !== null && cnt < c.lo) return false
      if (c.hi !== null && cnt > c.hi) return false
    }
  }
  return true
}
