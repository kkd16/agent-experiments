// The sum-check protocol — the single most important building block in modern
// proof systems. Given a low-degree multivariate polynomial g over 𝔽_p in v
// variables, a prover convinces a verifier of the value of
//
//        H  =  Σ_{x ∈ {0,1}^v}  g(x)
//
// while the verifier evaluates g at exactly *one* random point and otherwise does
// O(v · deg) field work — exponentially less than the 2^v terms in the sum. This
// is the engine under GKR (see gkr.ts), Spartan, HyperPlonk, Jolt and every other
// multilinear SNARK. Everything here is exact BigInt over the Goldilocks field so
// prover and verifier agree bit-for-bit.
//
// Representation. A multilinear polynomial in v variables is a *table* of its 2^v
// values on the boolean hypercube. Index i encodes the point (x₀,…,x_{v−1}) with
// x_j = bit j of i (LSB = variable 0), and variable 0 is the one bound first. The
// multilinear extension (MLE) is the unique multilinear polynomial matching those
// values; `mleEval` evaluates it at an arbitrary point in 𝔽_p^v.

import { add, sub, mul, fp, inv } from './goldilocks'
import { Transcript } from './transcript'

/** The equality (Lagrange-basis) polynomial ẽq(a,b)=∏ᵢ(aᵢbᵢ+(1−aᵢ)(1−bᵢ)). */
export function eqEval(a: bigint[], b: bigint[]): bigint {
  let acc = 1n
  for (let i = 0; i < a.length; i++) {
    // aᵢbᵢ + (1−aᵢ)(1−bᵢ) = 1 − aᵢ − bᵢ + 2aᵢbᵢ
    const ab = mul(a[i], b[i])
    const term = fp(1n - a[i] - b[i] + 2n * ab)
    acc = mul(acc, term)
  }
  return acc
}

/** Fold the first (LSB) variable of a table to the field value r, halving its length. */
export function foldFirst(table: bigint[], r: bigint): bigint[] {
  const half = table.length >> 1
  const out = new Array<bigint>(half)
  for (let j = 0; j < half; j++) {
    const v0 = table[2 * j] // this variable = 0
    const v1 = table[2 * j + 1] // this variable = 1
    // (1−r)·v0 + r·v1 = v0 + r·(v1−v0)
    out[j] = add(v0, mul(r, sub(v1, v0)))
  }
  return out
}

/** Evaluate the multilinear extension of a 2^v-entry table at an arbitrary point. */
export function mleEval(table: bigint[], point: bigint[]): bigint {
  let t = table
  for (const r of point) t = foldFirst(t, r)
  return t[0]
}

/** Sum of a table over the boolean hypercube (its value at the all-ones "corner sum"). */
export function hypercubeSum(table: bigint[]): bigint {
  let acc = 0n
  for (const v of table) acc = add(acc, v)
  return acc
}

// ── Univariate helpers: round messages are the polynomial's evaluations at
//    0,1,…,degree. Lagrange interpolation reconstructs the value anywhere. ──

/** Evaluate the univariate through points (0,evals[0]),…,(d,evals[d]) at x. */
export function lagrangeAt(evals: bigint[], x: bigint): bigint {
  const d = evals.length - 1
  // If x is one of the nodes, return directly (also avoids a 0 denominator).
  for (let i = 0; i <= d; i++) if (fp(x - BigInt(i)) === 0n) return evals[i]
  let acc = 0n
  for (let i = 0; i <= d; i++) {
    let num = evals[i]
    let den = 1n
    for (let j = 0; j <= d; j++) {
      if (j === i) continue
      num = mul(num, sub(x, BigInt(j)))
      den = mul(den, fp(BigInt(i) - BigInt(j)))
    }
    acc = add(acc, mul(num, inv(den)))
  }
  return acc
}

// ── The generic sum-check claim. `combine` is an arbitrary low-degree polynomial
//    in the tables' values; `degree` is its degree in any single variable, so each
//    round message needs degree+1 evaluations. ──

export interface SumcheckClaim {
  numVars: number
  degree: number
  tables: bigint[][] // each of length 2^numVars
  combine: (vals: bigint[]) => bigint
}

export interface SumcheckRound {
  /** Evaluations of the round univariate at 0,1,…,degree. */
  evals: bigint[]
  /** The challenge r the verifier fed back this round. */
  challenge: bigint
}

export interface SumcheckProof {
  claimedSum: bigint
  rounds: SumcheckRound[]
  /** The random point r ∈ 𝔽_p^v the protocol converged to. */
  point: bigint[]
  /** g(r): the single oracle evaluation the verifier must reconcile. */
  finalValue: bigint
}

/**
 * Run the prover. It folds the tables one variable at a time; each round it emits
 * the univariate sⱼ(X)=Σ_{rest} combine(tables|first var=X), absorbs it into the
 * Fiat–Shamir transcript, and reads back the challenge — so the proof is
 * non-interactive and deterministic.
 */
export function sumcheckProve(claim: SumcheckClaim, tr: Transcript): SumcheckProof {
  const claimedSum = hypercubeSum(combineTable(claim))
  let tables = claim.tables.map((t) => t.slice())
  const rounds: SumcheckRound[] = []
  const point: bigint[] = []
  tr.absorbField(claimedSum)

  for (let round = 0; round < claim.numVars; round++) {
    const half = tables[0].length >> 1
    const evals: bigint[] = []
    for (let t = 0; t <= claim.degree; t++) {
      const tt = BigInt(t)
      let acc = 0n
      for (let j = 0; j < half; j++) {
        const vals = tables.map((tab) => {
          const v0 = tab[2 * j]
          const v1 = tab[2 * j + 1]
          return add(v0, mul(tt, sub(v1, v0)))
        })
        acc = add(acc, claim.combine(vals))
      }
      evals.push(acc)
    }
    for (const e of evals) tr.absorbField(e)
    const r = tr.challengeField()
    rounds.push({ evals, challenge: r })
    point.push(r)
    tables = tables.map((tab) => foldFirst(tab, r))
  }

  const finalValue = claim.combine(tables.map((t) => t[0]))
  return { claimedSum, rounds, point, finalValue }
}

/** Materialise g over the hypercube once, to read off its honest sum. */
function combineTable(claim: SumcheckClaim): bigint[] {
  const n = claim.tables[0].length
  const out = new Array<bigint>(n)
  for (let i = 0; i < n; i++) out[i] = claim.combine(claim.tables.map((t) => t[i]))
  return out
}

export interface SumcheckVerdict {
  ok: boolean
  /** The round (0-based) the check first failed, or -1 if all passed. */
  failedRound: number
  point: bigint[]
  /** The value the last round forces g(point) to equal. */
  expected: bigint
}

/**
 * Run the verifier against a proof. It replays the transcript to recover the exact
 * challenges, checks sⱼ(0)+sⱼ(1)=sⱼ₋₁(rⱼ₋₁) every round, then defers to `oracle`
 * for the single evaluation g(point) — the only place it touches the real
 * polynomial. Pass the claimed sum explicitly so a lying prover can be caught.
 */
export function sumcheckVerify(
  numVars: number,
  degree: number,
  claimedSum: bigint,
  rounds: SumcheckRound[],
  oracle: (point: bigint[]) => bigint,
  tr: Transcript,
): SumcheckVerdict {
  tr.absorbField(claimedSum)
  let expected = claimedSum
  const point: bigint[] = []
  for (let round = 0; round < numVars; round++) {
    const evals = rounds[round].evals
    if (evals.length !== degree + 1) return { ok: false, failedRound: round, point, expected }
    // The core sum-check identity: the sum over {0,1} of the round poly is the
    // value the previous round pinned down.
    if (add(evals[0], evals[1]) !== expected) return { ok: false, failedRound: round, point, expected }
    for (const e of evals) tr.absorbField(e)
    const r = tr.challengeField()
    point.push(r)
    expected = lagrangeAt(evals, r)
  }
  const g = oracle(point)
  return { ok: g === expected, failedRound: g === expected ? -1 : numVars, point, expected }
}

// ── Convenience: the canonical demo — prove the sum over the hypercube of a
//    product of k multilinear polynomials, given by their tables. The round polys
//    have degree k, and the verifier's single oracle call is the product of the
//    k tables' MLEs at the random point. ──

export function productClaim(tables: bigint[][], numVars: number): SumcheckClaim {
  return {
    numVars,
    degree: tables.length,
    tables,
    combine: (vals) => vals.reduce((a, b) => mul(a, b), 1n),
  }
}

/** The verifier's oracle for a product claim: ∏ⱼ MLEⱼ(point). */
export function productOracle(tables: bigint[][]): (point: bigint[]) => bigint {
  return (point) => tables.map((t) => mleEval(t, point)).reduce((a, b) => mul(a, b), 1n)
}
