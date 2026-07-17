// The Wavelet Packet Transform + Coifman–Wickerhauser best-basis selection.
//
// The DWT (dwt.ts) only ever recurses on the *approximation* (low-pass) band —
// it gives the dyadic, octave-by-octave tiling of the frequency axis. A wavelet
// *packet* transform recurses on **both** children at every node, producing a
// full binary tree of subbands and, with it, a whole library of orthonormal
// bases: every admissible pruning of the tree is a different tiling of the
// time-frequency plane.
//
// The **best basis** (Coifman & Wickerhauser, 1992) is the single pruning that
// minimises an additive information cost — usually the Shannon entropy of the
// coefficients. A bottom-up sweep compares each parent's cost against the sum of
// its children's best costs and keeps whichever is cheaper; the surviving leaves
// are the basis that represents the signal most sparsely. It adapts the
// frequency resolution to the signal: fine where the signal is tonal, coarse
// where it is transient.
//
// Perfect reconstruction is inherited from dwt.ts: every node stores the exact
// analysis coefficients of its subband, and idwtStep inverts dwtStep, so *any*
// admissible cover of the tree resynthesises the signal exactly.

import { dwtStep, idwtStep, type FilterBank } from './dwt'
import { fromReal, magnitude } from './complex'
import { fft } from './fft'

/** nodes[j][k] = coefficient array of the packet node at level j, position k. */
export type PacketTree = Float64Array[][]

export function wpAnalyze(x: Float64Array, bank: FilterBank, levels: number): PacketTree {
  const nodes: PacketTree = [[x]]
  for (let j = 1; j <= levels; j++) {
    const prev = nodes[j - 1]
    const cur: Float64Array[] = []
    for (const parent of prev) {
      const { cA, cD } = dwtStep(parent, bank)
      cur.push(cA, cD) // child 2k (low), child 2k+1 (high)
    }
    nodes.push(cur)
  }
  return nodes
}

export type CostName = 'shannon' | 'l1'

/**
 * Additive information cost of a coefficient band (Coifman–Wickerhauser). The
 * costs are *additive over coefficients* — crucially, with NO per-band
 * renormalisation — so summing a node's cost over any admissible cover of the
 * tree is a fair comparison, which is exactly what the best-basis sweep needs.
 * Both are minimised by concentrating energy into few large coefficients.
 *
 *   shannon: −Σ xᵢ²·log(xᵢ²)   (the classic entropy cost)
 *   l1:       Σ |xᵢ|            (an ℓ¹ sparsity proxy)
 */
export function cost(band: Float64Array, kind: CostName): number {
  if (kind === 'l1') {
    let s = 0
    for (let i = 0; i < band.length; i++) s += Math.abs(band[i])
    return s
  }
  let s = 0
  for (let i = 0; i < band.length; i++) {
    const e = band[i] * band[i]
    if (e > 1e-300) s -= e * Math.log(e)
  }
  return s
}

export interface Leaf {
  j: number
  k: number
}

export interface BestBasis {
  leaves: Leaf[]
  split: boolean[][] // split[j][k] — is this node subdivided in the best basis?
  bestCost: number
  fullTreeCost: number // cost of the root band (no splitting) — the baseline
  finestCost: number // cost summed over the finest level (full WP)
}

/**
 * Bottom-up best-basis search. Returns the leaves of the minimum-cost admissible
 * subtree, plus the split map for drawing the tree.
 */
export function bestBasis(nodes: PacketTree, kind: CostName): BestBasis {
  const J = nodes.length - 1
  const nodeCost = nodes.map((level) => level.map((b) => cost(b, kind)))
  const best = nodeCost.map((level) => level.slice())
  const split: boolean[][] = nodes.map((level) => level.map(() => false))
  for (let j = J - 1; j >= 0; j--) {
    for (let k = 0; k < nodes[j].length; k++) {
      const childSum = best[j + 1][2 * k] + best[j + 1][2 * k + 1]
      if (childSum < best[j][k]) {
        best[j][k] = childSum
        split[j][k] = true
      }
    }
  }
  const leaves: Leaf[] = []
  const collect = (j: number, k: number) => {
    if (j < J && split[j][k]) {
      collect(j + 1, 2 * k)
      collect(j + 1, 2 * k + 1)
    } else {
      leaves.push({ j, k })
    }
  }
  collect(0, 0)
  let finestCost = 0
  for (let k = 0; k < nodes[J].length; k++) finestCost += nodeCost[J][k]
  return { leaves, split, bestCost: best[0][0], fullTreeCost: nodeCost[0][0], finestCost }
}

/**
 * Reconstruct the signal from an admissible set of leaves. Rebuilds every split
 * node from its two children with idwtStep; exact inverse of wpAnalyze over any
 * admissible cover.
 */
export function wpReconstruct(nodes: PacketTree, split: boolean[][], bank: FilterBank): Float64Array {
  const J = nodes.length - 1
  const recon = (j: number, k: number): Float64Array => {
    if (j < J && split[j][k]) {
      return idwtStep(recon(j + 1, 2 * k), recon(j + 1, 2 * k + 1), bank)
    }
    return nodes[j][k]
  }
  return recon(0, 0)
}

/**
 * Synthesise a single packet leaf back to full length (all other bands zero) —
 * the band-limited signal component carried by that node. Used to place each
 * leaf on the true frequency axis.
 */
export function wpLeafSignal(nodes: PacketTree, leaf: Leaf, bank: FilterBank): Float64Array {
  // Walk up from the leaf to the root, upsampling through idwtStep with a zeroed
  // sibling at each step.
  let band = nodes[leaf.j][leaf.k]
  let j = leaf.j
  let k = leaf.k
  while (j > 0) {
    const parentLen = band.length * 2
    const zero = new Float64Array(band.length)
    const isLow = k % 2 === 0
    band = idwtStep(isLow ? band : zero, isLow ? zero : band, bank)
    if (band.length !== parentLen) band = band.subarray(0, parentLen)
    k = Math.floor(k / 2)
    j--
  }
  return band
}

/** Spectral centroid (in cycles/sample, 0..0.5) of a real signal, energy-weighted. */
export function spectralCentroid(sig: Float64Array): number {
  const N = sig.length
  const mag = magnitude(fft(fromReal(sig)))
  let num = 0
  let den = 0
  const half = N >> 1
  for (let k = 0; k <= half; k++) {
    const p = mag[k] * mag[k]
    num += (k / N) * p
    den += p
  }
  return den > 0 ? num / den : 0
}
