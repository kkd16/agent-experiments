// Pohlig–Hellman: the attack that explains why curve orders must be prime (or
// very nearly so). If the order n of ⟨P⟩ factors as ∏ pᵢ^eᵢ, the discrete log
// in ⟨P⟩ splits into one small discrete log per prime-power factor — each solved
// in ~√pᵢ steps by baby-step giant-step — and the pieces are glued back with the
// Chinese Remainder Theorem. A 256-bit order made of small primes would fall in
// milliseconds; this is precisely the structure secp256k1 was chosen to avoid.

import { Curve, type Point } from './curve'
import { mod } from './field'
import { babyStepGiantStep } from './dlog'

const eq = (A: Point, B: Point): boolean =>
  (A === null && B === null) || (A !== null && B !== null && A.x === B.x && A.y === B.y)

// Modular inverse over a (possibly composite) modulus; null if not coprime.
function modInvN(a: bigint, m: bigint): bigint | null {
  let [oldR, r] = [mod(a, m), m]
  let [oldS, s] = [1n, 0n]
  while (r !== 0n) {
    const q = oldR / r
    ;[oldR, r] = [r, oldR - q * r]
    ;[oldS, s] = [s, oldS - q * s]
  }
  return oldR === 1n ? mod(oldS, m) : null
}

/** Trial-division factorization of n into prime powers. Toy-sized n only — the
 *  whole point of the demo is a smooth order, which trial division handles. */
export function factorize(n: bigint): { prime: bigint; exp: number; power: bigint }[] {
  const out: { prime: bigint; exp: number; power: bigint }[] = []
  let m = n
  for (let d = 2n; d * d <= m; d++) {
    if (m % d !== 0n) continue
    let e = 0
    while (m % d === 0n) {
      m /= d
      e++
    }
    out.push({ prime: d, exp: e, power: d ** BigInt(e) })
  }
  if (m > 1n) out.push({ prime: m, exp: 1, power: m })
  return out
}

export interface PhSubproblem {
  prime: bigint
  exp: number
  power: bigint // pᵢ^eᵢ
  residue: bigint // k mod pᵢ^eᵢ
  digits: bigint[] // the base-pᵢ digits recovered by the lifting recursion
  steps: number // BSGS steps spent in this subgroup
}

export interface PhResult {
  order: bigint
  factors: { prime: bigint; exp: number; power: bigint }[]
  sub: PhSubproblem[]
  k: bigint | null
  totalSteps: number
  // The dominant cost: √(largest prime factor), vs √order for a frontal attack.
  largestPrime: bigint
}

/**
 * Solve Q = k·P in ⟨P⟩ of known order, by Pohlig–Hellman.
 *
 * For each prime power pᵉ ‖ n we recover k mod pᵉ one base-p digit at a time
 * (the standard Pohlig–Hellman lifting), each digit found by a BSGS in the
 * order-p subgroup. CRT then reassembles k mod n.
 */
export function pohligHellman(curve: Curve, P: Point, Q: Point, order: bigint): PhResult {
  const factors = factorize(order)
  const sub: PhSubproblem[] = []
  let totalSteps = 0

  for (const { prime, exp, power } of factors) {
    // Generator of the order-p subgroup: P0 = (n/p)·P.
    const cof = order / prime
    const P0 = curve.multiply(cof, P)

    const digits: bigint[] = []
    let stepsHere = 0
    // gamma accumulates Σ digit_j · p^j; we peel digits from least significant.
    let gammaScalar = 0n
    for (let j = 0; j < exp; j++) {
      // Q_j = (n / p^{j+1}) · (Q − gammaScalar·P), then solve dlog base P0.
      const shifted = curve.subtract(Q, curve.multiply(gammaScalar, P))
      const Qj = curve.multiply(order / prime ** BigInt(j + 1), shifted)
      const r = babyStepGiantStep(curve, P0, Qj, prime)
      stepsHere += r.steps
      const digit = r.k ?? 0n
      digits.push(digit)
      gammaScalar = mod(gammaScalar + digit * prime ** BigInt(j), power)
    }
    totalSteps += stepsHere
    sub.push({ prime, exp, power, residue: mod(gammaScalar, power), digits, steps: stepsHere })
  }

  // CRT: find k with k ≡ residueᵢ (mod powerᵢ) for all i.
  let k: bigint | null = 0n
  let M = 1n
  for (const s of sub) {
    if (k === null) break
    const Mi = M
    const inv = modInvN(Mi % s.power, s.power)
    if (inv === null) {
      k = null
      break
    }
    const t = mod((s.residue - k) * inv, s.power)
    k = k + Mi * t
    M *= s.power
  }
  if (k !== null) k = mod(k, order)
  // Final sanity check against the curve itself.
  if (k !== null && !eq(curve.multiply(k, P), Q)) k = null

  const largestPrime = factors.reduce((m, f) => (f.prime > m ? f.prime : m), 1n)
  return { order, factors, sub, k, totalSteps, largestPrime }
}

/** Search small curves for one whose group order is **smooth** (all prime
 *  factors ≤ `bound`) and reasonably large — the deliberately weak curve the
 *  Pohlig–Hellman lab attacks. Returns the curve, a generator, and its order. */
export function findSmoothCurve(
  bound: bigint,
  minOrder = 200,
  maxOrder = 5000,
): { curve: Curve; G: Point; order: bigint; factors: ReturnType<typeof factorize> } | null {
  const primes = [
    101n, 127n, 149n, 179n, 211n, 251n, 307n, 367n, 419n, 487n, 541n, 631n, 727n, 811n, 919n,
    1009n,
  ]
  for (const p of primes) {
    for (let a = 0n; a < 8n; a++) {
      for (let b = 1n; b < 12n; b++) {
        const curve = new Curve(a, b, p)
        if (!curve.isNonSingular()) continue
        const order = curve.count()
        if (order < BigInt(minOrder) || order > BigInt(maxOrder)) continue
        const factors = factorize(order)
        if (factors.every((f) => f.prime <= bound) && factors.length >= 2) {
          const G = curve.points().find((pt) => pt !== null && curve.pointOrder(pt) === order)
          if (G) return { curve, G, order, factors }
        }
      }
    }
  }
  return null
}
