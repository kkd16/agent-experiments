// Combinational simulation over an AIG — the *incomplete* half of SAT sweeping.
//
// Simulation is cheap and can only ever prove nodes *different* (a single input
// pattern on which they disagree), never equal. But that is exactly what a SAT
// sweeper needs: simulation shreds the nodes into small candidate equivalence
// classes (nodes that agree on *every* pattern tried so far), and then a proof
// engine (here, the CDCL SAT solver) is asked the far smaller question of whether
// each surviving candidate pair is *really* equal. Two truly-equal nodes agree on
// every pattern, so they can never be split apart — simulation classes are always
// a safe over-approximation of the real equivalences.
//
// We simulate 64 patterns at a time packed into a `bigint` word per node, and can
// grow the pattern set on the fly (a SAT counterexample becomes a new pattern that
// refines every class), so signatures are arbitrary-width bit-vectors.

import { Aig, litNode, litInv } from './aig'

/** A per-node signature: the node's value across all simulated input patterns. */
export interface SimState {
  /** `sig[i]` — node i's output bit for each pattern (bit p = pattern p). */
  sig: bigint[]
  /** Number of patterns currently packed into each signature. */
  patterns: number
  /** The input patterns themselves: `pat[p][s]` = bit of input-slot s in pattern p. */
  pat: number[][]
}

// A tiny deterministic PRNG (mulberry32) so simulations are reproducible.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Evaluate every node under one input pattern (bit per input slot). Returns a bit array. */
export function evalPattern(aig: Aig, pat: number[]): Uint8Array {
  const N = aig.numNodes
  const val = new Uint8Array(N)
  val[0] = 0 // constant node = 0
  for (let s = 0; s < aig.inputs.length; s++) val[aig.inputs[s]] = pat[s] & 1
  for (let i = 1; i < N; i++) {
    if (aig.isPI[i]) continue
    const f0 = aig.fanin0[i]
    const f1 = aig.fanin1[i]
    const a = val[litNode(f0)] ^ litInv(f0)
    const b = val[litNode(f1)] ^ litInv(f1)
    val[i] = a & b & 1
  }
  return val
}

/** Fresh simulation with `count` random input patterns. */
export function simulate(aig: Aig, count: number, seed = 0x5a7f0): SimState {
  const rng = mulberry32(seed)
  const ni = aig.inputs.length
  const pat: number[][] = []
  // A couple of structured patterns (all-0, all-1, alternating) plus random ones —
  // the extremes catch constant nodes that random patterns can statistically miss.
  pat.push(new Array(ni).fill(0))
  pat.push(new Array(ni).fill(1))
  for (let p = pat.length; p < count; p++) {
    pat.push(Array.from({ length: ni }, () => (rng() < 0.5 ? 0 : 1)))
  }
  const sig = new Array<bigint>(aig.numNodes).fill(0n)
  for (let p = 0; p < pat.length; p++) {
    const val = evalPattern(aig, pat[p])
    for (let i = 0; i < aig.numNodes; i++) sig[i] = (sig[i] << 1n) | BigInt(val[i])
  }
  return { sig, patterns: pat.length, pat }
}

/** Append one more input pattern (e.g. a SAT counterexample) and extend every signature. */
export function addPattern(aig: Aig, st: SimState, pat: number[]): void {
  const val = evalPattern(aig, pat)
  for (let i = 0; i < aig.numNodes; i++) st.sig[i] = (st.sig[i] << 1n) | BigInt(val[i])
  st.pat.push(pat.slice())
  st.patterns++
}

/**
 * Canonicalize a signature *up to complementation* so a node and its inverse land
 * in the same class. Convention: force the highest-order bit (pattern 0) to 0; the
 * phase says whether the node itself, or its complement, matches that canonical form.
 */
export function canonical(st: SimState, node: number): { key: bigint; phase: number } {
  const s = st.sig[node]
  const p = st.patterns
  const top = Number((s >> BigInt(p - 1)) & 1n)
  if (top === 1) {
    const mask = (1n << BigInt(p)) - 1n
    return { key: s ^ mask, phase: 1 }
  }
  return { key: s, phase: 0 }
}

/**
 * The full truth table of an output literal, as a `2^n`-bit `bigint` (bit `m` = the
 * output when the inputs are the bits of `m`). This is a *reference* evaluator —
 * completely independent of the SAT/CNF path — used by the self-check to pin the
 * whole engine against exhaustive enumeration. Only sensible for small `n`.
 */
export function truthTable(aig: Aig, lit: number): bigint {
  const n = aig.inputs.length
  if (n > 20) throw new Error(`truthTable: ${n} inputs is too many to enumerate`)
  const rows = 1 << n
  let tt = 0n
  for (let m = 0; m < rows; m++) {
    const pat = new Array(n)
    for (let s = 0; s < n; s++) pat[s] = (m >> s) & 1
    const val = evalPattern(aig, pat)
    const bit = val[litNode(lit)] ^ litInv(lit)
    if (bit & 1) tt |= 1n << BigInt(m)
  }
  return tt
}
