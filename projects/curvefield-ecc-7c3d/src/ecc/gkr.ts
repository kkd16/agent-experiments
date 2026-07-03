// GKR — the Goldwasser–Kalai–Rothblum "doubly-efficient" interactive proof.
//
// A prover evaluates a layered arithmetic circuit and then convinces a verifier
// that a claimed *output* is correct — without the verifier re-running a single
// gate. Each layer's correctness is reduced to the layer beneath it by one run of
// the sum-check protocol (see sumcheck.ts) over the GKR identity
//
//   W̃ᵢ(z) = Σ_{x,y}  ẽq(z,·)-weighted[ addᵢ(z,x,y)·(W̃ᵢ₊₁(x)+W̃ᵢ₊₁(y))
//                                       + mulᵢ(z,x,y)·W̃ᵢ₊₁(x)·W̃ᵢ₊₁(y) ],
//
// where W̃ᵢ is the multilinear extension of layer i's gate values and addᵢ/mulᵢ are
// the multilinear extensions of the wiring predicates. The sum-check leaves the
// verifier needing two evaluations of the next layer, W̃ᵢ₊₁(b*) and W̃ᵢ₊₁(c*); the
// classic *line reduction* folds those two into one by restricting W̃ᵢ₊₁ to the
// line through b* and c*. After D layers the last claim is an evaluation of the
// (public) input's MLE, which the verifier checks directly.
//
// The whole thing runs over the Goldilocks field with a Fiat–Shamir transcript, so
// it is non-interactive and deterministic. The point of the lab: the verifier's
// work is O(D·polylog(S)) sum-check checks, exponentially cheaper than the S gate
// operations the prover ran.

import { add, sub, mul, fp } from './goldilocks'
import { Transcript } from './transcript'
import {
  eqEval,
  mleEval,
  foldFirst,
  lagrangeAt,
  type SumcheckRound,
} from './sumcheck'

export type Op = 'add' | 'mul'

/** A gate reads two wires (l, r) from the layer immediately below (toward the input). */
export interface Gate {
  op: Op
  l: number
  r: number
}

/**
 * A layered circuit. `input` is the bottom value layer (layer D). `gateLayers[i]`
 * describes how layer i is computed from layer i+1; gateLayers[0] is the output
 * layer. Every layer length must be a power of two ≥ 2.
 */
export interface Circuit {
  gateLayers: Gate[][]
  input: bigint[]
}

/** ⌈log₂⌉ that also asserts an exact power of two. */
export function log2exact(n: number): number {
  let k = 0
  let m = n
  while (m > 1) {
    if (m & 1) throw new Error(`layer size ${n} is not a power of two`)
    m >>= 1
    k++
  }
  return k
}

/** The k bits of `index`, least-significant first, as field 0/1 values. */
export function bitsOf(index: number, k: number): bigint[] {
  const out = new Array<bigint>(k)
  for (let i = 0; i < k; i++) out[i] = (index >> i) & 1 ? 1n : 0n
  return out
}

/** Evaluate the circuit, returning every value layer: values[0]=output … values[D]=input. */
export function evaluate(circuit: Circuit): bigint[][] {
  const D = circuit.gateLayers.length
  const values: bigint[][] = new Array(D + 1)
  values[D] = circuit.input.map((v) => fp(v))
  for (let i = D - 1; i >= 0; i--) {
    const below = values[i + 1]
    values[i] = circuit.gateLayers[i].map((g) =>
      g.op === 'add' ? add(below[g.l], below[g.r]) : mul(below[g.l], below[g.r]),
    )
  }
  return values
}

// ── Wiring-predicate MLEs. For the verifier we evaluate addᵢ/mulᵢ at a single
//    point by summing over the (sparse) gate list — cheap for structured circuits.
//    For the prover we materialise the tables over (x,y) so the sum-check can fold
//    them variable by variable. ──

/** addᵢ(z,x,y) or mulᵢ(z,x,y) at one point, summed over the gate list. */
export function wiringMleAt(
  gates: Gate[],
  op: Op,
  z: bigint[],
  x: bigint[],
  y: bigint[],
  kThis: number,
  kNext: number,
): bigint {
  let acc = 0n
  for (let gi = 0; gi < gates.length; gi++) {
    const g = gates[gi]
    if (g.op !== op) continue
    const w = mul(
      eqEval(z, bitsOf(gi, kThis)),
      mul(eqEval(x, bitsOf(g.l, kNext)), eqEval(y, bitsOf(g.r, kNext))),
    )
    acc = add(acc, w)
  }
  return acc
}

/** Build the add/mul tables over the 2·kNext variables (x,y), for a fixed z. */
function wiringTables(
  gates: Gate[],
  z: bigint[],
  kThis: number,
  kNext: number,
): { addT: bigint[]; mulT: bigint[] } {
  const size = 1 << (2 * kNext)
  const addT = new Array<bigint>(size).fill(0n)
  const mulT = new Array<bigint>(size).fill(0n)
  for (let gi = 0; gi < gates.length; gi++) {
    const g = gates[gi]
    const idx = g.l + (g.r << kNext) // x in low bits, y in high bits
    const w = eqEval(z, bitsOf(gi, kThis))
    if (g.op === 'add') addT[idx] = add(addT[idx], w)
    else mulT[idx] = add(mulT[idx], w)
  }
  return { addT, mulT }
}

/** combine([add, mul, wx, wy]) = add·(wx+wy) + mul·wx·wy — the GKR layer summand. */
function gkrCombine(vals: bigint[]): bigint {
  const [a, m, wx, wy] = vals
  return add(mul(a, add(wx, wy)), mul(m, mul(wx, wy)))
}

const GKR_DEGREE = 2 // combine is quadratic in each single variable

// ── The proof object. Each layer carries its sum-check round messages and one
//    line-restriction polynomial. r0 and every challenge are recovered from the
//    transcript, so they are not stored. ──

export interface GkrLayerProof {
  rounds: SumcheckRound[]
  /** Evaluations of q(t)=W̃ᵢ₊₁(ℓ(t)) at t=0,…,kNext. */
  linePoly: bigint[]
}

export interface GkrProof {
  output: bigint[]
  layers: GkrLayerProof[]
  /** Prover-side bookkeeping for the UI: honest gate operations executed. */
  gateOps: number
}

/** Restrict a point to the line through b and c: ℓ(t) = b + t·(c − b). */
function lineAt(b: bigint[], c: bigint[], t: bigint): bigint[] {
  return b.map((bi, i) => add(bi, mul(t, sub(c[i], bi))))
}

/**
 * The GKR prover. Evaluates the circuit, then walks top-down, running one sum-check
 * per layer and emitting the line-reduction polynomial that fuses its two residual
 * claims into the next layer's single claim.
 */
export function gkrProve(circuit: Circuit): GkrProof {
  const values = evaluate(circuit)
  const D = circuit.gateLayers.length
  const tr = new Transcript('gkr')

  const output = values[0]
  for (const v of output) tr.absorbField(v)

  // Random evaluation point for the output layer.
  const k0 = log2exact(output.length)
  let z: bigint[] = []
  for (let i = 0; i < k0; i++) z.push(tr.challengeField())

  const layers: GkrLayerProof[] = []
  let gateOps = 0
  for (const layer of circuit.gateLayers) gateOps += layer.length

  for (let i = 0; i < D; i++) {
    const kThis = log2exact(values[i].length)
    const kNext = log2exact(values[i + 1].length)
    const W = values[i + 1]
    const mask = (1 << kNext) - 1

    const { addT, mulT } = wiringTables(circuit.gateLayers[i], z, kThis, kNext)
    const size = 1 << (2 * kNext)
    const wxT = new Array<bigint>(size)
    const wyT = new Array<bigint>(size)
    for (let idx = 0; idx < size; idx++) {
      wxT[idx] = W[idx & mask]
      wyT[idx] = W[idx >> kNext]
    }

    // Run the sum-check over the 2·kNext variables (x,y). We drive the transcript
    // directly (rather than via sumcheckProve) so the GKR claim W̃ᵢ(z) — not the
    // engine's recomputed sum — is what binds the messages.
    tr.absorbField(mleEval(values[i], z))
    let tables = [addT, mulT, wxT, wyT]
    const rounds: SumcheckRound[] = []
    const point: bigint[] = []
    const numVars = 2 * kNext
    for (let round = 0; round < numVars; round++) {
      const half = tables[0].length >> 1
      const evals: bigint[] = []
      for (let t = 0; t <= GKR_DEGREE; t++) {
        const tt = BigInt(t)
        let acc = 0n
        for (let j = 0; j < half; j++) {
          const vals = tables.map((tab) => {
            const v0 = tab[2 * j]
            const v1 = tab[2 * j + 1]
            return add(v0, mul(tt, sub(v1, v0)))
          })
          acc = add(acc, gkrCombine(vals))
        }
        evals.push(acc)
      }
      for (const e of evals) tr.absorbField(e)
      const r = tr.challengeField()
      rounds.push({ evals, challenge: r })
      point.push(r)
      tables = tables.map((tab) => foldFirst(tab, r))
    }

    const bStar = point.slice(0, kNext)
    const cStar = point.slice(kNext)

    // Line reduction: q(t) = W̃ᵢ₊₁(ℓ(t)), degree kNext, sent as kNext+1 evaluations.
    const linePoly: bigint[] = []
    for (let t = 0; t <= kNext; t++) linePoly.push(mleEval(W, lineAt(bStar, cStar, BigInt(t))))
    for (const e of linePoly) tr.absorbField(e)
    const tStar = tr.challengeField()

    layers.push({ rounds, linePoly })
    z = lineAt(bStar, cStar, tStar)
  }

  return { output, layers, gateOps }
}

export interface GkrVerdict {
  ok: boolean
  /** Human-readable reason if it failed. */
  reason: string
  /** 0-based layer where verification stopped, or D on full success. */
  layer: number
  /** Sum-check identity checks the verifier performed (its total work, in checks). */
  checks: number
  /** Proof size in field elements. */
  proofElements: number
}

/**
 * The GKR verifier. It never touches a gate value: for each layer it replays the
 * sum-check identity, reconstructs the wiring MLEs from the sparse gate list, and
 * uses the line polynomial to supply the two residual next-layer evaluations. The
 * final claim is checked against the public input's MLE.
 *
 * `claimedOutput` is the output the verifier is asked to trust — corrupt it and the
 * derived challenges diverge, so the proof no longer certifies it.
 */
export function gkrVerify(
  circuit: Circuit,
  claimedOutput: bigint[],
  proof: GkrProof,
): GkrVerdict {
  const D = circuit.gateLayers.length
  // The verifier NEVER evaluates the circuit. Layer sizes are structural (the gate
  // counts and the public input length), so it derives every variable count without
  // running a single gate — the whole point of a doubly-efficient proof.
  const layerSize = (i: number) => (i < D ? circuit.gateLayers[i].length : circuit.input.length)
  const tr = new Transcript('gkr')
  let checks = 0
  let proofElements = claimedOutput.length

  for (const v of claimedOutput) tr.absorbField(v)

  const k0 = log2exact(claimedOutput.length)
  let z: bigint[] = []
  for (let i = 0; i < k0; i++) z.push(tr.challengeField())

  let claim = mleEval(claimedOutput, z)

  for (let i = 0; i < D; i++) {
    const kThis = log2exact(layerSize(i))
    const kNext = log2exact(layerSize(i + 1))
    const lp = proof.layers[i]
    const numVars = 2 * kNext
    proofElements += numVars * (GKR_DEGREE + 1) + lp.linePoly.length

    tr.absorbField(claim)
    let expected = claim
    const point: bigint[] = []
    for (let round = 0; round < numVars; round++) {
      const evals = lp.rounds[round]?.evals
      if (!evals || evals.length !== GKR_DEGREE + 1)
        return { ok: false, reason: `layer ${i} round ${round}: malformed message`, layer: i, checks, proofElements }
      checks++
      if (add(evals[0], evals[1]) !== expected)
        return { ok: false, reason: `layer ${i} round ${round}: s(0)+s(1) ≠ claim`, layer: i, checks, proofElements }
      for (const e of evals) tr.absorbField(e)
      const r = tr.challengeField()
      point.push(r)
      expected = lagrangeAt(evals, r)
    }

    const bStar = point.slice(0, kNext)
    const cStar = point.slice(kNext)

    // Reconstruct the wiring MLEs at the sum-check's random point — the verifier's
    // only structural work, and cheap for a sparse circuit.
    const addMle = wiringMleAt(circuit.gateLayers[i], 'add', z, bStar, cStar, kThis, kNext)
    const mulMle = wiringMleAt(circuit.gateLayers[i], 'mul', z, bStar, cStar, kThis, kNext)
    const q0 = lp.linePoly[0] // W̃ᵢ₊₁(b*)
    const q1 = lp.linePoly[1] // W̃ᵢ₊₁(c*)
    const oracle = add(mul(addMle, add(q0, q1)), mul(mulMle, mul(q0, q1)))
    if (oracle !== expected)
      return { ok: false, reason: `layer ${i}: final oracle check failed`, layer: i, checks, proofElements }

    // Fold the line into the next claim.
    for (const e of lp.linePoly) tr.absorbField(e)
    const tStar = tr.challengeField()
    z = bStar.map((bi, j) => add(bi, mul(tStar, sub(cStar[j], bi))))
    claim = lagrangeAt(lp.linePoly, tStar)
  }

  // Bottom out: the last claim must equal the public input's MLE at z.
  const inputClaim = mleEval(circuit.input.map((v) => fp(v)), z)
  checks++
  if (inputClaim !== claim)
    return { ok: false, reason: 'input-layer claim ≠ MLE of the public input', layer: D, checks, proofElements }

  return { ok: true, reason: 'every layer certified; verifier ran zero gates', layer: D, checks, proofElements }
}

// ── A concrete two-layer example circuit for the lab. Eight inputs feed eight
//    mixed add/mul gates, which feed four output gates. Editable input values keep
//    the wiring fixed so the same proof structure is reused. ──

export function exampleCircuit(input: bigint[]): Circuit {
  const layer1: Gate[] = [
    { op: 'mul', l: 0, r: 1 },
    { op: 'add', l: 2, r: 3 },
    { op: 'mul', l: 4, r: 5 },
    { op: 'add', l: 6, r: 7 },
    { op: 'add', l: 0, r: 2 },
    { op: 'mul', l: 1, r: 3 },
    { op: 'add', l: 4, r: 6 },
    { op: 'mul', l: 5, r: 7 },
  ]
  const output: Gate[] = [
    { op: 'add', l: 0, r: 1 },
    { op: 'mul', l: 2, r: 3 },
    { op: 'add', l: 4, r: 5 },
    { op: 'mul', l: 6, r: 7 },
  ]
  return { gateLayers: [output, layer1], input: input.map((v) => fp(v)) }
}
