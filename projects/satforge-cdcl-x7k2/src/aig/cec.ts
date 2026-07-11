// SAT sweeping (FRAIG) and combinational equivalence checking — the industrial
// killer app of SAT, in miniature.
//
// The problem: are two circuits (say, an RTL design and its synthesized netlist)
// the same Boolean function? Naively you build a *miter* — XOR the outputs and ask
// SAT for an input that makes any of them differ — but on real designs that one
// giant miter is hopeless. The trick that made CEC practical (Kuehlmann's FRAIG,
// Mishchenko's ABC) is **SAT sweeping**: merge the two circuits into one AIG so
// structural hashing already fuses everything syntactically identical, then walk the
// shared graph proving *internal* nodes equal one pair at a time. Each proof merges
// a node, shrinking every cone above it, so by the time you reach the outputs the
// miter has usually collapsed to a tautology and no final solve is needed at all.
//
//   simulation  → candidate equivalence classes (nodes agreeing on all patterns)
//   SAT proof   → confirm/refute one candidate pair; a refutation is a new pattern
//   merge       → redundant node is rewritten to its representative literal
//
// Every merge here is *proved* by the CDCL solver (never trusted from simulation),
// so the rebuilt AIG is guaranteed to compute the identical function — the
// self-check pins that against exhaustive truth tables.

import { Aig, mkLit, litNode, litInv, litNot, CONST0, type Lit } from './aig'
import { tseitin } from './cnf'
import { simulate, addPattern, canonical, type SimState } from './simulate'
import { solveAssuming, type SolverOptions } from '../sat/solver'

export interface FraigStats {
  /** AND gates before sweeping (after structural hashing alone). */
  andsBefore: number
  /** AND gates after sweeping (proven-equal nodes merged away). */
  andsAfter: number
  /** SAT queries issued to prove/refute candidate pairs. */
  satCalls: number
  /** Candidate pairs proven equal and merged. */
  merges: number
  /** Simulation counterexamples that refuted a candidate (and refined the classes). */
  refutations: number
  /** Combinational depth before / after. */
  depthBefore: number
  depthAfter: number
}

export interface FraigResult {
  /** The swept AIG — functionally identical, structurally minimal. */
  aig: Aig
  /** `mapLit(oldLit)` → the equivalent literal in the swept AIG. */
  map: (oldLit: Lit) => Lit
  stats: FraigStats
}

const SOLVE_OPTS: SolverOptions = { maxConflicts: 200000, minimize: true }

/** Extract the input-pattern (bit per input slot) from a SAT model. */
function modelPattern(aig: Aig, varOf: Int32Array, model: boolean[]): number[] {
  return aig.inputs.map((node) => (model[varOf[node]] ? 1 : 0))
}

/**
 * Fraig an AIG: prove out its internal functional equivalences by SAT sweeping and
 * return a rebuilt, minimal graph plus a literal-remapping. The returned graph has
 * the same primary inputs/outputs and computes the same functions.
 */
export function fraig(
  aig: Aig,
  opts: { patterns?: number; seed?: number } = {},
): FraigResult {
  const N = aig.numNodes
  const lvlBefore = aig.levels()
  let depthBefore = 0
  for (const o of aig.outputs) depthBefore = Math.max(depthBefore, lvlBefore[litNode(o.lit)])

  const { cnf, varOf, dl } = tseitin(aig)
  const st: SimState = simulate(aig, opts.patterns ?? 64, opts.seed ?? 0x5a7f0)

  // Prove whether two AIG literals are equal under the shared CNF. Returns either
  // {equal:true} or a distinguishing input pattern that refutes the candidate.
  const stats = { satCalls: 0, refutations: 0 }
  const proveEqual = (litA: Lit, litB: Lit): { equal: boolean; cex?: number[] } => {
    const a = dl(litA)
    const b = dl(litB)
    // Can they differ with A=1,B=0?  then with A=0,B=1?  Both UNSAT ⇒ equal.
    stats.satCalls++
    const r1 = solveAssuming(cnf, [a, -b], SOLVE_OPTS)
    if (r1.status === 'sat') return { equal: false, cex: modelPattern(aig, varOf, r1.model!) }
    if (r1.status === 'unknown') return { equal: false } // give up conservatively
    stats.satCalls++
    const r2 = solveAssuming(cnf, [-a, b], SOLVE_OPTS)
    if (r2.status === 'sat') return { equal: false, cex: modelPattern(aig, varOf, r2.model!) }
    if (r2.status === 'unknown') return { equal: false }
    return { equal: true }
  }

  // reprLit[i] — the literal (in the *original* AIG) that node i is equal to. For a
  // representative node it is mkLit(i,0); for a proven-redundant node it points at
  // an earlier representative (possibly inverted).
  const reprLit = new Int32Array(N)
  reprLit[0] = CONST0
  // buckets: canonical-signature key → representative nodes sharing it.
  const buckets = new Map<string, { node: number; phase: number }[]>()
  const addRep = (node: number) => {
    const { key, phase } = canonical(st, node)
    const k = key.toString(36)
    const list = buckets.get(k)
    if (list) list.push({ node, phase })
    else buckets.set(k, [{ node, phase }])
  }
  addRep(0)

  for (let i = 1; i < N; i++) {
    if (aig.isPI[i]) {
      reprLit[i] = mkLit(i, 0)
      addRep(i)
      continue
    }
    const { key, phase } = canonical(st, i)
    const k = key.toString(36)
    const cands = buckets.get(k) ?? []
    let merged = false
    for (const cand of cands) {
      const inv = phase ^ cand.phase // i ≡ rep, or i ≡ ¬rep?
      const target = mkLit(cand.node, inv as 0 | 1)
      const res = proveEqual(mkLit(i, 0), target)
      if (res.equal) {
        reprLit[i] = target
        merged = true
        break
      }
      if (res.cex) {
        addPattern(aig, st, res.cex) // refine classes for future nodes
        stats.refutations++
      }
    }
    if (!merged) {
      reprLit[i] = mkLit(i, 0)
      addRep(i)
    }
  }

  // Rebuild a minimal AIG from the representatives.
  const out = new Aig()
  const map = new Int32Array(N)
  map[0] = CONST0
  for (let s = 0; s < aig.inputs.length; s++) {
    map[aig.inputs[s]] = out.addInput(aig.inputNames[s])
  }
  const mapLit = (oldLit: Lit): Lit => {
    const base = map[litNode(oldLit)]
    return litInv(oldLit) ? litNot(base) : base
  }
  for (let i = 1; i < N; i++) {
    if (aig.isPI[i]) continue
    if (reprLit[i] !== mkLit(i, 0)) {
      // Redundant node — its representative is an earlier, already-mapped literal.
      map[i] = mapLit(reprLit[i])
    } else {
      map[i] = out.mkAnd(mapLit(aig.fanin0[i]), mapLit(aig.fanin1[i]))
    }
  }
  for (const o of aig.outputs) out.addOutput(o.name, mapLit(o.lit))

  let merges = 0
  for (let i = 1; i < N; i++) if (!aig.isPI[i] && reprLit[i] !== mkLit(i, 0)) merges++

  return {
    aig: out,
    map: mapLit,
    stats: {
      andsBefore: aig.numAnds,
      andsAfter: out.numAnds,
      satCalls: stats.satCalls,
      merges,
      refutations: stats.refutations,
      depthBefore,
      depthAfter: out.depth,
    },
  }
}

export interface OutputVerdict {
  name: string
  equivalent: boolean
  /** A distinguishing input assignment when the outputs differ. */
  counterexample?: { name: string; value: 0 | 1 }[]
}

export interface CecResult {
  equivalent: boolean
  outputs: OutputVerdict[]
  fraig: FraigStats
  /** SAT calls spent on the final miters (0 when sweeping already settled it). */
  miterCalls: number
}

/**
 * Combinational equivalence check of two circuits already built into one shared AIG,
 * given the matching output-literal pairs `[litA, litB]`. Strategy: fraig the shared
 * graph (so common logic and internal equivalences collapse), then per output pair
 * compare their swept literals — equal literals are *proven* equivalent for free. If
 * they differ, one miter solve either confirms non-equivalence with a counterexample
 * or (rarely, if sweeping was budget-limited) proves them equal after all.
 */
export function checkEquivalence(
  aig: Aig,
  pairs: { name: string; a: Lit; b: Lit }[],
  opts: { patterns?: number; seed?: number } = {},
): CecResult {
  const swept = fraig(aig, opts)
  const outputs: OutputVerdict[] = []
  let miterCalls = 0
  let allEq = true

  for (const p of pairs) {
    const sa = swept.map(p.a)
    const sb = swept.map(p.b)
    if (sa === sb) {
      outputs.push({ name: p.name, equivalent: true })
      continue
    }
    // Swept literals differ — settle it with a miter on the swept graph. Build the
    // XOR node first, then encode (so the miter node is included in the CNF).
    const miter = swept.aig.mkXor(sa, sb)
    const enc = tseitin(swept.aig)
    miterCalls++
    const r = solveAssuming(enc.cnf, [enc.dl(miter)], SOLVE_OPTS)
    if (r.status === 'sat') {
      const cex = swept.aig.inputs.map((node, s) => ({
        name: swept.aig.inputNames[s],
        value: (r.model![enc.varOf[node]] ? 1 : 0) as 0 | 1,
      }))
      outputs.push({ name: p.name, equivalent: false, counterexample: cex })
      allEq = false
    } else {
      outputs.push({ name: p.name, equivalent: true })
    }
  }

  return { equivalent: allEq, outputs, fraig: swept.stats, miterCalls }
}
