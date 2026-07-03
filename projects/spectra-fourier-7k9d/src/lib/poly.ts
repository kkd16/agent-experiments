// Polynomial helpers over complex coefficients, plus a from-scratch root finder.
//
// Filter design leans on polynomials in two directions:
//   - building a transfer function's numerator/denominator from a set of roots
//     (∏ (z − rᵢ)), and
//   - going the other way, factoring a coefficient vector back into its roots so
//     an FIR filter's many zeros can be plotted on the z-plane.
//
// The forward direction is a convolution; the reverse is the interesting part —
// we use the Durand–Kerner (Weierstrass) iteration, a clean simultaneous method
// that converges to *all* roots of a polynomial at once with no external math.

import type { Cx } from './cplx'
import { cadd, cdiv, cmul, csub, cabs, cx, cpolar, CONE } from './cplx'

/** Coefficients are stored highest-degree-first: [aₙ, …, a₁, a₀]. */
export type Poly = Cx[]

/** Multiply two polynomials (convolution of coefficient vectors). */
export function polyMul(a: Poly, b: Poly): Poly {
  const out: Poly = Array.from({ length: a.length + b.length - 1 }, () => cx(0))
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      out[i + j] = cadd(out[i + j], cmul(a[i], b[j]))
    }
  }
  return out
}

/**
 * Expand ∏ (x − rᵢ) into a monic coefficient vector (highest degree first).
 * An empty root set is the constant polynomial 1.
 */
export function polyFromRoots(roots: Cx[]): Poly {
  let p: Poly = [CONE]
  for (const r of roots) {
    // multiply by (x − r): [1, −r]
    p = polyMul(p, [CONE, cx(-r.re, -r.im)])
  }
  return p
}

/** Evaluate a polynomial at a complex point via Horner's rule. */
export function polyEval(p: Poly, x: Cx): Cx {
  let acc = cx(0)
  for (const c of p) acc = cadd(cmul(acc, x), c)
  return acc
}

/** The formal derivative p′(x). */
export function polyDeriv(p: Poly): Poly {
  const n = p.length - 1 // degree
  if (n <= 0) return [cx(0)]
  const out: Poly = []
  for (let i = 0; i < n; i++) {
    const power = n - i
    out.push(cmul(p[i], cx(power)))
  }
  return out
}

/**
 * Find every root of a polynomial with the Durand–Kerner method.
 *
 * All roots are refined simultaneously: each estimate steps by
 *   rᵢ ← rᵢ − p(rᵢ) / ∏_{j≠i}(rᵢ − rⱼ),
 * which is Newton's method sharing the deflation across every root at once.
 * Leading zeros (from cancellation) are trimmed first; a scale-spread initial
 * guess avoids the classic failure where equal-radius starts stall on symmetry.
 */
export function polyRoots(coeffs: Poly, iterations = 200, tol = 1e-12): Cx[] {
  // Trim leading (highest-degree) zeros so the true degree is correct.
  let start = 0
  while (start < coeffs.length - 1 && cabs(coeffs[start]) < 1e-14) start++
  const p = coeffs.slice(start)
  const degree = p.length - 1
  if (degree <= 0) return []

  // Make monic for numerical comfort.
  const lead = p[0]
  const monic = p.map((c) => cdiv(c, lead))

  if (degree === 1) {
    // x + a₀ ⇒ root −a₀
    return [cx(-monic[1].re, -monic[1].im)]
  }

  // Initial guesses on a spiral of increasing radius — spread in angle *and*
  // magnitude so no two collide and symmetric configurations don't stall.
  const roots: Cx[] = []
  const seed = 0.4 + 0.9 // fixed, deterministic
  for (let i = 0; i < degree; i++) {
    const ang = (2 * Math.PI * i) / degree + 0.1
    const rad = seed * Math.pow(1.15, i % 7)
    roots.push(cpolar(rad, ang))
  }

  for (let iter = 0; iter < iterations; iter++) {
    let maxDelta = 0
    for (let i = 0; i < degree; i++) {
      const ri = roots[i]
      const num = polyEval(monic, ri)
      // denominator = ∏_{j≠i} (ri − rj)
      let den = CONE
      for (let j = 0; j < degree; j++) {
        if (j === i) continue
        den = cmul(den, csub(ri, roots[j]))
      }
      const step = cdiv(num, den)
      roots[i] = csub(ri, step)
      const d = cabs(step)
      if (d > maxDelta) maxDelta = d
    }
    if (maxDelta < tol) break
  }
  return roots
}
