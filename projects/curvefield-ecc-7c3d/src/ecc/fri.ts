// FRI — the Fast Reed–Solomon Interactive Oracle Proof of Proximity. This is the
// engine that makes a STARK a *proof*: a way to convince a verifier, in
// polylogarithmic work, that a committed vector of N field values is (close to)
// the evaluations of a polynomial of degree < N/blowup — without ever sending the
// polynomial.
//
// The idea is a random fold. Split f(x) = f_even(x²) + x·f_odd(x²). A verifier's
// random β collapses the two halves into a single polynomial
//   f'(y) = f_even(y) + β·f_odd(y),
// of half the degree, whose evaluations live on the squared (half-size) domain.
// Repeat ⌈log₂⌉ times and a degree-d claim becomes a degree-0 (constant) claim,
// which is trivial to check. Soundness comes from re-opening a few random
// positions and checking each fold is locally consistent: a codeword far from
// every low-degree polynomial survives a round with probability ≈ ½, so a
// committed cheat is caught with overwhelming probability across the layers and
// queries. The only cryptography used is the Merkle hash — no trusted setup.

import { P, add, sub, mul, inv, pow, rootOfUnity, intt } from './goldilocks'
import { buildMerkle, openMerkle, verifyMerkle, type MerkleTree } from './merkle'
import { Transcript } from './transcript'

const INV2 = inv(2n)

export interface FriLayerOpening {
  valLo: bigint
  valHi: bigint
  pathLo: string[]
  pathHi: string[]
}

export interface FriQueryOpening {
  layers: FriLayerOpening[]
}

export interface FriProof {
  size: number
  degreeBound: number
  offset: bigint
  layerRoots: string[]
  finalConst: bigint
  queries: FriQueryOpening[]
}

export interface FriParams {
  size: number
  offset: bigint
  degreeBound: number
  numQueries: number
}

/** One folding step: halve a codeword using challenge β. */
function foldLayer(evals: bigint[], offset: bigint, omega: bigint, beta: bigint): bigint[] {
  const half = evals.length >> 1
  const out = new Array<bigint>(half)
  let x = offset // x at index 0 is offset·ω⁰
  for (let j = 0; j < half; j++) {
    const a = evals[j]
    const b = evals[j + half] // f(−x): ω^{j+half} = −ω^j
    const even = mul(add(a, b), INV2) // (f(x)+f(−x))/2  = f_even(x²)
    const odd = mul(sub(a, b), mul(INV2, inv(x))) // (f(x)−f(−x))/2x = f_odd(x²)
    out[j] = add(even, mul(beta, odd))
    x = mul(x, omega)
  }
  return out
}

/**
 * Prove that `codeword` (evaluations over offset·⟨ω_N⟩) has degree < degreeBound.
 * Returns the proof plus the queried positions, so a caller (the STARK) can open
 * its own committed columns at exactly the same places.
 */
export function friProve(
  codeword: bigint[],
  params: FriParams,
  transcript: Transcript,
): { proof: FriProof; positions: number[] } {
  const { size, offset, degreeBound, numQueries } = params
  if (codeword.length !== size) throw new Error('friProve: codeword length ≠ size')
  const rounds = Math.log2(degreeBound)
  if (!Number.isInteger(rounds)) throw new Error('friProve: degreeBound must be a power of two')

  // Build all folding layers, interleaving Merkle roots and β challenges through
  // the transcript exactly as the verifier will re-derive them.
  interface Layer {
    evals: bigint[]
    tree: MerkleTree
    offset: bigint
    omega: bigint
  }
  const layers: Layer[] = []
  let evals = codeword.slice()
  let curOffset = offset
  let curOmega = rootOfUnity(size)

  let tree = buildMerkle(evals.map((v) => [v]))
  transcript.absorbHex(tree.root)
  layers.push({ evals, tree, offset: curOffset, omega: curOmega })

  for (let r = 0; r < rounds; r++) {
    const beta = transcript.challengeField()
    evals = foldLayer(evals, curOffset, curOmega, beta)
    curOffset = mul(curOffset, curOffset)
    curOmega = mul(curOmega, curOmega)
    if (r < rounds - 1) {
      tree = buildMerkle(evals.map((v) => [v]))
      transcript.absorbHex(tree.root)
      layers.push({ evals, tree, offset: curOffset, omega: curOmega })
    }
  }

  // The final layer is a constant (degree < 1). Sent in the clear; its constness
  // is enforced by the last fold check at every query.
  const finalConst = evals[0]
  transcript.absorbField(finalConst)

  // Sample query positions (the "lo" index of each layer-0 pair) and open.
  const half0 = size >> 1
  const positions: number[] = []
  for (let q = 0; q < numQueries; q++) positions.push(transcript.challengeInt(half0))

  const queries: FriQueryOpening[] = positions.map((pos0) => {
    const layerOpenings: FriLayerOpening[] = []
    let pos = pos0
    for (let L = 0; L < layers.length; L++) {
      const m = layers[L].evals.length
      const half = m >> 1
      const lo = pos % half
      const hi = lo + half
      layerOpenings.push({
        valLo: layers[L].evals[lo],
        valHi: layers[L].evals[hi],
        pathLo: openMerkle(layers[L].tree, lo),
        pathHi: openMerkle(layers[L].tree, hi),
      })
      pos = lo
    }
    return { layers: layerOpenings }
  })

  return {
    proof: { size, degreeBound, offset, layerRoots: layers.map((l) => l.tree.root), finalConst, queries },
    positions,
  }
}

export interface FriVerdict {
  ok: boolean
  reason: string
  positions: number[]
  /** layer-0 (input codeword) values at each query's pair, for the caller to cross-check. */
  layer0: { pos: number; lo: number; hi: number; valLo: bigint; valHi: bigint }[]
  rounds: number
}

/** Verify a FRI proof against the expected domain + degree bound. */
export function friVerify(proof: FriProof, params: FriParams, transcript: Transcript): FriVerdict {
  const { size, offset, degreeBound, numQueries } = params
  const rounds = Math.log2(degreeBound)
  const layer0: FriVerdict['layer0'] = []
  const fail = (reason: string): FriVerdict => ({ ok: false, reason, positions: [], layer0, rounds })

  if (proof.size !== size || proof.degreeBound !== degreeBound) return fail('domain/degree mismatch')
  if (proof.offset !== offset) return fail('coset offset mismatch')
  if (proof.layerRoots.length !== rounds) return fail('wrong number of committed layers')
  if (proof.queries.length !== numQueries) return fail('wrong number of queries')

  // Re-derive β challenges and query positions from the transcript.
  const betas: bigint[] = []
  transcript.absorbHex(proof.layerRoots[0])
  for (let r = 0; r < rounds; r++) {
    betas.push(transcript.challengeField())
    if (r < rounds - 1) transcript.absorbHex(proof.layerRoots[r + 1])
  }
  transcript.absorbField(proof.finalConst)
  const half0 = size >> 1
  const positions: number[] = []
  for (let q = 0; q < numQueries; q++) positions.push(transcript.challengeInt(half0))

  const omega0 = rootOfUnity(size)

  for (let q = 0; q < numQueries; q++) {
    const opening = proof.queries[q]
    if (opening.layers.length !== rounds) return fail(`query ${q}: wrong layer count`)
    let pos = positions[q]
    let curSize = size
    let curOffset = offset
    let curOmega = omega0

    for (let L = 0; L < rounds; L++) {
      const half = curSize >> 1
      const lo = pos % half
      const hi = lo + half
      const { valLo, valHi } = opening.layers[L]

      if (!verifyMerkle(proof.layerRoots[L], lo, [valLo], opening.layers[L].pathLo))
        return fail(`query ${q} layer ${L}: bad Merkle path (lo)`)
      if (!verifyMerkle(proof.layerRoots[L], hi, [valHi], opening.layers[L].pathHi))
        return fail(`query ${q} layer ${L}: bad Merkle path (hi)`)

      if (L === 0) layer0.push({ pos, lo, hi, valLo, valHi })

      // Fold this pair with β_L and check it matches the next layer.
      const x = mul(curOffset, pow(curOmega, BigInt(lo)))
      const even = mul(add(valLo, valHi), INV2)
      const odd = mul(sub(valLo, valHi), mul(INV2, inv(x)))
      const folded = add(even, mul(betas[L], odd))

      const nextPos = lo
      if (L < rounds - 1) {
        const nextHalf = (curSize >> 1) >> 1
        const nextVal = nextPos < nextHalf ? opening.layers[L + 1].valLo : opening.layers[L + 1].valHi
        if (folded !== nextVal) return fail(`query ${q} layer ${L}: fold inconsistent`)
      } else {
        if (folded !== proof.finalConst) return fail(`query ${q}: final fold ≠ constant`)
      }

      pos = nextPos
      curSize = half
      curOffset = mul(curOffset, curOffset)
      curOmega = mul(curOmega, curOmega)
    }
  }

  return { ok: true, reason: 'all folds consistent; final layer is a constant', positions, layer0, rounds }
}

/**
 * A small helper used only in tests/visualisation: recover the coefficient vector
 * of a codeword given over the coset offset·⟨ω_size⟩ (un-coset then inverse NTT).
 */
export function codewordToCoeffs(codeword: bigint[], offset: bigint): bigint[] {
  const scaled = intt(codeword)
  const offInv = inv(offset)
  let pw = 1n
  const out = new Array<bigint>(codeword.length)
  for (let k = 0; k < codeword.length; k++) {
    out[k] = mul(scaled[k], pw)
    pw = mul(pw, offInv)
  }
  return out.map((v) => ((v % P) + P) % P)
}
