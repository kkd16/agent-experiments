// Shamir secret sharing + Feldman verifiable secret sharing (VSS).
//
// A secret s is hidden as the constant term of a random degree-(t−1) polynomial
//
//     f(X) = s + a₁X + a₂X² + … + a_{t−1}X^{t−1}   over F_n,
//
// and each of n parties gets the share (i, f(i)). Any t shares interpolate f and
// recover s = f(0); any t−1 shares leave s information-theoretically uniform.
// This is the classic threshold primitive under FROST, threshold ECDSA, and the
// distributed key generation of every real multisig.
//
// **Feldman VSS** layers verifiability on top for free: the dealer also publishes
// the curve commitments Cⱼ = aⱼ·G. Then *anyone* holding a share can check
//
//     yᵢ·G  ?=  Σⱼ Cⱼ · iʲ            (= f(i)·G)
//
// without learning the secret — so a cheating dealer who hands out an
// inconsistent share is caught immediately. C₀ = s·G is the public "group key".
//
// Everything is over the secp256k1 scalar field F_n and its generator G.

import { secp256k1, G, N } from './secp256k1'
import { type Point } from './curve'
import { mod } from './field'
import { lagrangeWeights, evaluate, type Poly } from './polynomial'
import { randomScalar } from './rng'

export interface Share {
  i: bigint // the party index (the evaluation point x = i, never 0)
  y: bigint // f(i), the secret share value
}

export interface SharingResult {
  secret: bigint
  threshold: number // t — the number of shares needed to reconstruct
  poly: Poly // [s, a₁, …, a_{t−1}] — the dealer's secret polynomial
  shares: Share[]
  commitments: Point[] // Feldman commitments Cⱼ = aⱼ·G, C₀ = s·G is the group key
}

/** Split `secret` into `n` shares with threshold `t` (2 ≤ t ≤ n). The dealer's
 *  random polynomial and the Feldman commitments are returned alongside so the
 *  lab can show the whole construction; in a real protocol the polynomial stays
 *  private and only the shares + commitments are published. */
export function split(secret: bigint, t: number, n: number): SharingResult {
  if (t < 1 || t > n) throw new Error('require 1 ≤ t ≤ n')
  const s = mod(secret, N)
  // f(X) = s + a₁X + … + a_{t−1}X^{t−1}, random coefficients in F_n.
  const poly: Poly = [s]
  for (let j = 1; j < t; j++) poly.push(randomScalar(N) || 1n)

  const shares: Share[] = []
  for (let i = 1; i <= n; i++) {
    const x = BigInt(i)
    shares.push({ i: x, y: evaluate(poly, x, N) })
  }
  const commitments = poly.map((aj) => secp256k1.multiply(aj, G))
  return { secret: s, threshold: t, poly, shares, commitments }
}

/** Recover f(0) = s from any `t` (or more) shares by Lagrange interpolation at 0.
 *  Fewer than t shares interpolate the *wrong* constant term — that is exactly
 *  the security guarantee, demonstrated live in the lab. */
export function reconstruct(shares: Share[]): bigint {
  const xs = shares.map((sh) => sh.i)
  const weights = lagrangeWeights(xs, 0n, N)
  let acc = 0n
  shares.forEach((sh, k) => {
    acc = mod(acc + weights[k] * sh.y, N)
  })
  return acc
}

/** Feldman check: does share (i, y) satisfy y·G = Σⱼ Cⱼ·iʲ ? Returns true iff
 *  the share is consistent with the published commitments. */
export function verifyShare(share: Share, commitments: Point[]): boolean {
  // Left: y·G.
  const lhs = secp256k1.multiply(share.y, G)
  // Right: Σⱼ Cⱼ·iʲ, accumulating iʲ by repeated multiplication.
  let rhs: Point = null
  let ipow = 1n
  for (const Cj of commitments) {
    rhs = secp256k1.add(rhs, secp256k1.multiply(ipow, Cj))
    ipow = mod(ipow * share.i, N)
  }
  const eq = (A: Point, B: Point) =>
    (A === null && B === null) || (A !== null && B !== null && A.x === B.x && A.y === B.y)
  return eq(lhs, rhs)
}

/** The public group key C₀ = s·G implied by a set of commitments. */
export function groupKey(commitments: Point[]): Point {
  return commitments[0] ?? null
}

/** Forge a single corrupted share (flip its value) — used by the lab to show
 *  Feldman VSS catching a dealer who lies to one party. */
export function corruptShare(share: Share): Share {
  return { i: share.i, y: mod(share.y + 1n, N) }
}

/** Enumerate the C(n, t) distinct t-subsets of share indices [0, n). Small n
 *  only — used to demonstrate that *every* qualifying subset recovers the same
 *  secret. */
export function subsets(n: number, t: number): number[][] {
  const out: number[][] = []
  const pick = (start: number, chosen: number[]) => {
    if (chosen.length === t) {
      out.push(chosen.slice())
      return
    }
    for (let i = start; i < n; i++) {
      chosen.push(i)
      pick(i + 1, chosen)
      chosen.pop()
    }
  }
  pick(0, [])
  return out
}
