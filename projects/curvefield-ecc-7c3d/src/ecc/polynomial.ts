// Polynomial algebra over a prime field F_m, written modulus-generic so the
// *same* code serves two very different jobs:
//
//   • Shamir secret sharing / FROST  — polynomials over the secp256k1 scalar
//     field F_n, evaluated at small integer x and interpolated back to f(0).
//   • KZG commitments                — polynomials over the BLS12-381 scalar
//     field F_r, committed at the secret point τ.
//
// Coefficients are stored **little-endian**: `coeffs[i]` is the coefficient of
// Xⁱ, so `[a, b, c]` is a + b·X + c·X². Everything reduces mod a field prime
// passed in explicitly — there is no global modulus. The functions are pure and
// carry no curve knowledge, which is what lets them be unit-tested in isolation.

import { mod, modInv } from './field'

/** A dense polynomial: coeffs[i] multiplies Xⁱ. The zero polynomial is `[]`. */
export type Poly = bigint[]

/** Drop trailing (high-degree) zero coefficients so equal polynomials compare
 *  structurally. The canonical zero polynomial is the empty array. */
export function trim(p: Poly, m: bigint): Poly {
  const out = p.map((c) => mod(c, m))
  while (out.length > 0 && out[out.length - 1] === 0n) out.pop()
  return out
}

/** Degree of p (the zero polynomial has degree −∞, reported as −1). */
export function degree(p: Poly, m: bigint): number {
  return trim(p, m).length - 1
}

/** Evaluate p(x) by Horner's method — one multiply + one add per coefficient. */
export function evaluate(p: Poly, x: bigint, m: bigint): bigint {
  let acc = 0n
  for (let i = p.length - 1; i >= 0; i--) acc = mod(acc * x + p[i], m)
  return acc
}

/** (p + q) coefficient-wise, padding the shorter operand with zeros. */
export function add(p: Poly, q: Poly, m: bigint): Poly {
  const n = Math.max(p.length, q.length)
  const out: Poly = []
  for (let i = 0; i < n; i++) out.push(mod((p[i] ?? 0n) + (q[i] ?? 0n), m))
  return trim(out, m)
}

/** (p − q). */
export function sub(p: Poly, q: Poly, m: bigint): Poly {
  const n = Math.max(p.length, q.length)
  const out: Poly = []
  for (let i = 0; i < n; i++) out.push(mod((p[i] ?? 0n) - (q[i] ?? 0n), m))
  return trim(out, m)
}

/** Multiply every coefficient by a scalar. */
export function scale(p: Poly, k: bigint, m: bigint): Poly {
  return trim(
    p.map((c) => mod(c * k, m)),
    m,
  )
}

/** Schoolbook convolution: (p · q). Quadratic, which is plenty for the small
 *  degrees these labs use. */
export function mul(p: Poly, q: Poly, m: bigint): Poly {
  if (p.length === 0 || q.length === 0) return []
  const out: Poly = new Array(p.length + q.length - 1).fill(0n)
  for (let i = 0; i < p.length; i++) {
    if (p[i] === 0n) continue
    for (let j = 0; j < q.length; j++) {
      out[i + j] = mod(out[i + j] + p[i] * q[j], m)
    }
  }
  return trim(out, m)
}

/** Euclidean division: returns { q, r } with p = q·d + r and deg(r) < deg(d).
 *  Throws on division by the zero polynomial. Because F_m is a field, the
 *  leading coefficient of d is always invertible, so this never fails. */
export function divmod(p: Poly, d: Poly, m: bigint): { q: Poly; r: Poly } {
  const dd = trim(d, m)
  if (dd.length === 0) throw new Error('polynomial division by zero')
  let r = trim(p, m)
  const dDeg = dd.length - 1
  const lcInv = modInv(dd[dDeg], m)
  const q: Poly = new Array(Math.max(0, r.length - dd.length + 1)).fill(0n)
  while (r.length - 1 >= dDeg && r.length > 0) {
    const shift = r.length - 1 - dDeg
    const factor = mod(r[r.length - 1] * lcInv, m)
    q[shift] = factor
    // r := r − factor·Xˢʰⁱᶠᵗ·d
    for (let i = 0; i < dd.length; i++) {
      r[shift + i] = mod(r[shift + i] - factor * dd[i], m)
    }
    r = trim(r, m)
  }
  return { q: trim(q, m), r }
}

/** The monic vanishing polynomial Z(X) = ∏ᵢ (X − xᵢ) of a set of roots. */
export function vanishing(roots: bigint[], m: bigint): Poly {
  let z: Poly = [1n]
  for (const r of roots) z = mul(z, [mod(-r, m), 1n], m) // (X − r)
  return z
}

/** Lagrange interpolation: the unique polynomial of degree < k through k points
 *  (xᵢ, yᵢ). The xᵢ must be distinct. Returns its coefficient vector. */
export function interpolate(points: { x: bigint; y: bigint }[], m: bigint): Poly {
  let result: Poly = []
  for (let i = 0; i < points.length; i++) {
    // Build the i-th Lagrange basis polynomial ℓᵢ(X) = ∏_{j≠i} (X−xⱼ)/(xᵢ−xⱼ),
    // then add yᵢ·ℓᵢ to the running total.
    let num: Poly = [1n]
    let den = 1n
    for (let j = 0; j < points.length; j++) {
      if (j === i) continue
      num = mul(num, [mod(-points[j].x, m), 1n], m)
      den = mod(den * (points[i].x - points[j].x), m)
    }
    const coeff = mod(points[i].y * modInv(den, m), m)
    result = add(result, scale(num, coeff, m), m)
  }
  return result
}

/** The Lagrange basis weights λᵢ evaluated at a single point `at` — i.e.
 *  ℓᵢ(at) = ∏_{j≠i} (at − xⱼ)/(xᵢ − xⱼ). With `at = 0` these are exactly the
 *  coefficients Shamir/FROST use to recombine shares into the secret f(0),
 *  without ever materialising the full interpolating polynomial. */
export function lagrangeWeights(xs: bigint[], at: bigint, m: bigint): bigint[] {
  return xs.map((xi, i) => {
    let num = 1n
    let den = 1n
    for (let j = 0; j < xs.length; j++) {
      if (j === i) continue
      num = mod(num * (at - xs[j]), m)
      den = mod(den * (xi - xs[j]), m)
    }
    return mod(num * modInv(den, m), m)
  })
}

/** The formal derivative p'(X) = Σ i·cᵢ·Xⁱ⁻¹. */
export function derivative(p: Poly, m: bigint): Poly {
  const out: Poly = []
  for (let i = 1; i < p.length; i++) out.push(mod(BigInt(i) * p[i], m))
  return trim(out, m)
}

/** Pretty-print a polynomial as `c₀ + c₁·X + c₂·X² …` (low-degree first). */
export function fmtPoly(p: Poly, m: bigint, varName = 'X'): string {
  const t = trim(p, m)
  if (t.length === 0) return '0'
  const terms: string[] = []
  for (let i = 0; i < t.length; i++) {
    if (t[i] === 0n) continue
    const c = t[i].toString()
    if (i === 0) terms.push(c)
    else if (i === 1) terms.push(`${c}·${varName}`)
    else terms.push(`${c}·${varName}^${i}`)
  }
  return terms.length ? terms.join(' + ') : '0'
}
