// The invalid-curve attack — a key recovery that exploits one missing line of
// code: a verifier that forgets to check an incoming point is actually on the
// curve.
//
// The short-Weierstrass addition law for y² = x³ + ax + b never once uses b. So
// if a victim does d·Q for an attacker-supplied Q, the result is computed
// correctly on whatever curve y² = x³ + ax + b' the point Q happens to satisfy —
// even one the attacker chose. By sending points of small prime order ℓ that live
// on weak "invalid" curves, the attacker learns d mod ℓ from each reply, then
// glues the residues together with the CRT to recover the full private key. This
// is exactly the bug class behind real-world TLS/ECDH key-recovery CVEs.

import { Curve, type Point } from './curve'
import { mod, modInv } from './field'
import { factorize } from './pohlig'

/** The target system's curve: a strong, prime-order toy curve (n = 10039). */
export const TARGET = { p: 10007n, a: 3n, b: 6n, n: 10039n }
export const targetCurve = new Curve(TARGET.a, TARGET.b, TARGET.p)

/** A generator of the target group (its order is the prime n). */
export const targetG: Point = (() => {
  for (let x = 0n; x < TARGET.p; x++) {
    const ys = targetCurve.liftX(x)
    if (ys.length) return { x, y: ys[0] }
  }
  throw new Error('no generator found')
})()

const eqPt = (P: Point, Q: Point): boolean =>
  P === null || Q === null ? P === Q : P.x === Q.x && P.y === Q.y

/**
 * The VULNERABLE oracle: scalar-multiplies any point the caller hands it without
 * checking it is on the real curve. (`targetCurve.multiply` never touches b, so
 * off-curve points are happily processed on their own invalid curve.)
 */
export function makeBrokenOracle(secret: bigint): (Q: Point) => Point {
  return (Q: Point) => targetCurve.multiply(secret, Q)
}

/** The FIXED oracle, for contrast: it rejects any point not on the real curve. */
export function makeSafeOracle(secret: bigint): (Q: Point) => Point | 'rejected' {
  return (Q: Point) => (targetCurve.isOnCurve(Q) ? targetCurve.multiply(secret, Q) : 'rejected')
}

/** Public key the victim publishes — what a frontal ECDLP attack would target. */
export function targetPubkey(secret: bigint): Point {
  return targetCurve.multiply(secret, targetG)
}

/** A point of exact prime order ℓ on curve E of order `ord` (or null). */
function pointOfOrder(E: Curve, ell: bigint, ord: bigint): Point {
  if (ord % ell !== 0n) return null
  const cofactor = ord / ell
  for (const P of E.points()) {
    if (P === null) continue
    const Q = E.multiply(cofactor, P)
    if (Q !== null) return Q // order divides the prime ℓ and is ≠ 1, so it is ℓ
  }
  return null
}

export interface InvalidHit {
  bPrime: bigint // the invalid curve y² = x³ + ax + b'
  invalidOrder: bigint // |E_{b'}(F_p)|
  prime: bigint // the small prime ℓ exploited
  point: Point // the order-ℓ point Q' sent to the oracle
  oracleResult: Point // d·Q', which equals (d mod ℓ)·Q'
  residue: bigint // the recovered d mod ℓ
  bruteSteps: number // brute-force steps to read off that residue
}

export interface InvalidCurveAttack {
  hits: InvalidHit[]
  modulus: bigint // ∏ ℓ — once ≥ n, the CRT value is unique in [0, n)
  recovered: bigint | null
  queries: number
  pinned: boolean // modulus ≥ n: the key is fully determined
}

// Combine residues by CRT (moduli are distinct primes ⇒ coprime).
function crt(items: { r: bigint; m: bigint }[]): { r: bigint; M: bigint } {
  let R = 0n
  let M = 1n
  for (const { r, m } of items) {
    const t = mod((r - R) * modInv(mod(M, m), m), m)
    R = R + M * t
    M = M * m
    R = mod(R, M)
  }
  return { r: R, M }
}

/**
 * Mount the full attack against a broken oracle. Scans candidate invalid curves
 * (same a, different b), harvests small-prime-order points, queries the oracle to
 * read d mod ℓ, and stops once the product of primes exceeds n so the CRT pins
 * the key uniquely.
 */
export function invalidCurveAttack(
  oracle: (Q: Point) => Point,
  maxPrime = 300n,
  scanLimit = 80n,
): InvalidCurveAttack {
  const { p, a, b, n } = TARGET
  const hits: InvalidHit[] = []
  const used = new Set<string>()
  let modulus = 1n
  let queries = 0

  for (let bb = 0n; bb < p && bb < scanLimit && modulus < n; bb++) {
    if (bb === b) continue
    const E = new Curve(a, bb, p)
    if (!E.isNonSingular()) continue
    const ord = BigInt(E.points().length)
    for (const f of factorize(ord)) {
      const ell = f.prime
      if (ell < 2n || ell > maxPrime || used.has(ell.toString())) continue
      if (modulus >= n) break
      const Qp = pointOfOrder(E, ell, ord)
      if (Qp === null) continue

      const R = oracle(Qp) // the only interaction with the secret
      queries++
      // Brute force d mod ℓ: walk multiples of Q' until one matches the reply.
      let residue = -1n
      let acc: Point = null
      let steps = 0
      for (let i = 0n; i < ell; i++) {
        if (eqPt(acc, R)) {
          residue = i
          break
        }
        acc = E.add(acc, Qp)
        steps++
      }
      if (residue < 0n) continue

      used.add(ell.toString())
      hits.push({ bPrime: bb, invalidOrder: ord, prime: ell, point: Qp, oracleResult: R, residue, bruteSteps: steps })
      modulus *= ell
    }
  }

  const { r } = crt(hits.map((h) => ({ r: h.residue, m: h.prime })))
  const recovered = hits.length ? mod(r, n) : null
  return { hits, modulus, recovered, queries, pinned: modulus >= n }
}
