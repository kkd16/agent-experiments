// The elliptic-curve discrete logarithm problem (ECDLP): given P and Q = k·P,
// recover k. The security of every curve in this lab rests on this being hard.
// These solvers make "hard" concrete — they work on toy curves and let you watch
// the cost grow with the group order.

import { Curve, type Point } from './curve'
import { mod } from './field'

export interface DlogResult {
  k: bigint | null
  steps: number
  method: string
}

const eq = (A: Point, B: Point): boolean =>
  (A === null && B === null) || (A !== null && B !== null && A.x === B.x && A.y === B.y)

/** Brute force: try k = 0, 1, 2, … until k·P = Q. O(order) — the baseline. */
export function bruteForce(curve: Curve, P: Point, Q: Point, order: bigint): DlogResult {
  let acc: Point = null
  for (let k = 0n; k < order; k++) {
    if (eq(acc, Q)) return { k, steps: Number(k) + 1, method: 'brute force' }
    acc = curve.add(acc, P)
  }
  return { k: null, steps: Number(order), method: 'brute force' }
}

/**
 * Baby-step giant-step: a time/memory tradeoff. Build a table of j·P for
 * j ∈ [0, m), then take giant strides of m·P from Q. Solves in O(√order) steps
 * and O(√order) memory.
 */
export function babyStepGiantStep(
  curve: Curve,
  P: Point,
  Q: Point,
  order: bigint,
): DlogResult {
  const m = BigInt(Math.ceil(Math.sqrt(Number(order))))
  let steps = 0

  // Baby steps: table[j·P] = j.
  const table = new Map<string, bigint>()
  let baby: Point = null
  for (let j = 0n; j < m; j++) {
    const key = baby === null ? 'O' : `${baby.x},${baby.y}`
    if (!table.has(key)) table.set(key, j)
    baby = curve.add(baby, P)
    steps++
  }

  // Giant step factor: −m·P.
  const mP = curve.multiply(m, P)
  const negMP = curve.negate(mP)

  let gamma: Point = Q
  for (let i = 0n; i < m; i++) {
    const key = gamma === null ? 'O' : `${gamma.x},${gamma.y}`
    const j = table.get(key)
    if (j !== undefined) {
      const k = mod(i * m + j, order)
      return { k, steps, method: 'baby-step giant-step' }
    }
    gamma = curve.add(gamma, negMP)
    steps++
  }
  return { k: null, steps, method: 'baby-step giant-step' }
}

/**
 * Pollard's rho: a pseudo-random walk that needs O(√order) steps but only O(1)
 * memory, found via Floyd's tortoise-and-hare cycle detection. We track each
 * point as a·P + b·Q; a collision a₁P+b₁Q = a₂P+b₂Q gives k = (a₁−a₂)/(b₂−b₁).
 */
export function pollardRho(curve: Curve, P: Point, Q: Point, order: bigint): DlogResult {
  // Partition points into three classes by x mod 3 to drive the walk.
  const partition = (X: Point): number => (X === null ? 0 : Number(mod(X.x, 3n)))

  type State = { X: Point; a: bigint; b: bigint }
  const step = ({ X, a, b }: State): State => {
    switch (partition(X)) {
      case 0:
        return { X: curve.add(X, Q), a, b: mod(b + 1n, order) }
      case 1:
        return { X: curve.add(X, X), a: mod(2n * a, order), b: mod(2n * b, order) }
      default:
        return { X: curve.add(X, P), a: mod(a + 1n, order), b }
    }
  }

  const maxSteps = 20 * Math.ceil(Math.sqrt(Number(order))) + 64
  let totalSteps = 0

  // A degenerate collision (b₁ = b₂) yields no information; rather than give up,
  // restart the walk from a fresh offset a₀·P + b₀·Q. Small groups need this most.
  for (let attempt = 0n; attempt < 32n && attempt < order; attempt++) {
    const start: State = {
      X: curve.add(curve.multiply(attempt, P), curve.multiply(attempt + 1n, Q)),
      a: mod(attempt, order),
      b: mod(attempt + 1n, order),
    }
    let tortoise = start
    let hare = start
    let steps = 0

    do {
      tortoise = step(tortoise)
      hare = step(step(hare))
      steps++
      totalSteps++
    } while (!eq(tortoise.X, hare.X) && steps <= maxSteps)

    if (steps > maxSteps) continue
    const bDiff = mod(tortoise.b - hare.b, order)
    if (bDiff === 0n) continue // degenerate — try another start
    const aDiff = mod(hare.a - tortoise.a, order)
    const inv = modInvOrder(bDiff, order)
    if (inv === null) continue
    const k = mod(aDiff * inv, order)
    if (eq(curve.multiply(k, P), Q)) {
      return { k, steps: totalSteps, method: "Pollard's rho" }
    }
  }
  return { k: null, steps: totalSteps, method: "Pollard's rho" }
}

// Inverse modulo the (possibly composite) group order; null if not invertible.
function modInvOrder(a: bigint, m: bigint): bigint | null {
  let [oldR, r] = [mod(a, m), m]
  let [oldS, s] = [1n, 0n]
  while (r !== 0n) {
    const q = oldR / r
    ;[oldR, r] = [r, oldR - q * r]
    ;[oldS, s] = [s, oldS - q * s]
  }
  if (oldR !== 1n) return null
  return mod(oldS, m)
}
