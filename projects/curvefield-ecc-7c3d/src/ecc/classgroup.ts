// The class group of an imaginary quadratic order — a group of UNKNOWN ORDER
// with NO trusted setup, the ideal home for a verifiable delay function.
//
// A VDF squares in a group whose order nobody knows: y = g^(2^T). Over an RSA
// modulus N = p·q that group is (ℤ/N)* and its order φ(N) = (p−1)(q−1) is a
// TRAPDOOR — whoever generated N can skip the delay. Removing that trapdoor
// needs a modulus whose factorisation nobody knows, which in practice means a
// *trusted setup* (an RSA "ceremony", or Rabin's class-group setup) that the
// whole system must believe was honest.
//
// The class group Cl(Δ) of an imaginary quadratic field ℚ(√Δ) sidesteps that
// entirely. Its order is the CLASS NUMBER h(Δ) ≈ √|Δ|, and computing h(Δ) for a
// large Δ is a subexponential problem believed as hard as factoring — so for a
// random 256-bit Δ *nobody*, not even the party who chose Δ, knows the order.
// And Δ itself can be a public "nothing-up-my-sleeve" value hashed from a seed:
// no ceremony, no trapdoor, no trust. That is exactly why Chia's consensus runs
// its proof-of-time in a class group.
//
// Elements are PRIMITIVE POSITIVE-DEFINITE BINARY QUADRATIC FORMS
//     f(x,y) = a·x² + b·x·y + c·y²,     written (a, b, c),
// of a fixed discriminant Δ = b² − 4ac < 0. Gauss's composition of forms makes
// the *reduced* forms of discriminant Δ into a finite abelian group; this file
// implements that group from scratch on native BigInt: reduction (the canonical
// representative), Gauss composition (Cohen, Alg. 5.4.7), squaring, and
// square-and-multiply exponentiation. Everything is cross-checked on the
// Self-Test page against the group axioms on the full Cayley table of small
// discriminants (h up to 27) and against the known class numbers h(−23)=3,
// h(−47)=5, h(−71)=7, …
//
// Zero dependencies beyond the lab's own field/hash primitives.

import { modSqrt, mod, modPow } from './field'
import { sha256, concat, utf8, bigToBytes, bytesToBig } from './sha256'
import { isProbablePrime } from './vdf'

// ── A binary quadratic form (a, b, c), disc = b² − 4ac ──────────────────────
export interface Form {
  a: bigint
  b: bigint
  c: bigint
}

const absB = (x: bigint): bigint => (x < 0n ? -x : x)

/** Floor division for BigInt (handles negative operands correctly). */
export function floorDiv(a: bigint, b: bigint): bigint {
  let q = a / b
  if (a % b !== 0n && a < 0n !== b < 0n) q -= 1n
  return q
}

/** Extended Euclid: returns [g, x, y] with x·a + y·b = g and g ≥ 0. */
export function xgcd(a: bigint, b: bigint): [bigint, bigint, bigint] {
  let or = a
  let r = b
  let os = 1n
  let s = 0n
  let ot = 0n
  let t = 1n
  while (r !== 0n) {
    const q = floorDiv(or, r)
    ;[or, r] = [r, or - q * r]
    ;[os, s] = [s, os - q * s]
    ;[ot, t] = [t, ot - q * t]
  }
  if (or < 0n) {
    or = -or
    os = -os
    ot = -ot
  }
  return [or, os, ot]
}

export function discriminant(f: Form): bigint {
  return f.b * f.b - 4n * f.a * f.c
}

/** Recover c = (b² − Δ)/(4a); exact for any valid form of discriminant Δ. */
function cFrom(a: bigint, b: bigint, D: bigint): bigint {
  return (b * b - D) / (4n * a)
}

/** True iff (a,b,c) is Gauss-reduced: |b| ≤ a ≤ c, and b ≥ 0 at the boundaries. */
export function isReduced(f: Form): boolean {
  const { a, b, c } = f
  const ab = absB(b)
  if (!(ab <= a && a <= c)) return false
  if ((ab === a || a === c) && b < 0n) return false
  return true
}

// ── Normalisation and reduction ─────────────────────────────────────────────
// Normalise brings b into the half-open interval (−a, a] by a shift b ← b + 2at,
// recomputing c from Δ (exact). Reduction then applies the ρ operator
// (a,b,c) ↦ (c,−b,a) whenever a > c, until the form is canonical. Every reduced
// form has a ≤ √(|Δ|/3), so coordinates stay ~half the size of Δ no matter how
// many times we compose — the fact that keeps VDF squaring cheap.
function normalize(a: bigint, b: bigint, D: bigint): Form {
  const t = floorDiv(a - b, 2n * a)
  const nb = b + 2n * a * t
  return { a, b: nb, c: cFrom(a, nb, D) }
}

export function reduce(form: Form, D?: bigint): Form {
  const disc = D ?? discriminant(form)
  let { a, b, c } = normalize(form.a, form.b, disc)
  while (a > c || (a === c && b < 0n)) {
    // ρ step: (a,b,c) → (c,−b,a), then re-normalise b into (−c, c].
    ;({ a, b, c } = normalize(c, -b, disc))
  }
  return { a, b, c }
}

// ── The group: identity, composition, squaring, inverse, exponentiation ─────
/** The principal (identity) form of discriminant Δ. Requires Δ ≡ 0 or 1 (mod 4). */
export function identity(D: bigint): Form {
  const b0 = ((D % 2n) + 2n) % 2n // 1 if Δ odd, 0 if Δ even
  return reduce({ a: 1n, b: b0, c: cFrom(1n, b0, D) }, D)
}

/** Inverse of (a,b,c) is (a,−b,c) — reflection — reduced. */
export function inverse(f: Form, D?: bigint): Form {
  return reduce({ a: f.a, b: -f.b, c: f.c }, D)
}

/**
 * Gauss composition of two forms of the same discriminant Δ (Cohen, *A Course
 * in Computational Algebraic Number Theory*, Algorithm 5.4.7). The composite
 * corresponds to the product of the underlying ideal classes; the result is
 * reduced. Validated to satisfy closure, associativity, commutativity,
 * identity, and inverses on the full Cayley table of small discriminants.
 */
export function compose(f1: Form, f2: Form, D: bigint): Form {
  let { a: a1, b: b1 } = f1
  let { a: a2, b: b2, c: c2 } = f2
  if (a1 > a2) {
    // keep a1 ≤ a2 (the algorithm's normalising assumption)
    ;[a1, a2] = [a2, a1]
    ;[b1, b2] = [b2, b1]
    c2 = f1.c
  }
  const s = (b1 + b2) / 2n
  const n = b2 - s

  // d = gcd(a2, a1) = y1·a2 + (·)·a1
  const [d, u] = xgcd(a2, a1)
  const y1 = u
  let x2: bigint
  let y2: bigint
  let d1: bigint
  if (s % d === 0n) {
    d1 = d
    x2 = 0n
    y2 = -1n
  } else {
    const [g, uu, vv] = xgcd(s, d) // g = uu·s + vv·d
    d1 = g
    x2 = uu
    y2 = -vv
  }
  const v1 = a1 / d1
  const v2 = a2 / d1
  const r = (((((y1 * y2) % v1) * n - x2 * c2) % v1) + v1) % v1
  const a3 = v1 * v2
  const b3 = b2 + 2n * v2 * r
  return reduce({ a: a3, b: b3, c: cFrom(a3, b3, D) }, D)
}

/** Squaring g² = g ∘ g (the VDF's inner step). */
export function square(f: Form, D: bigint): Form {
  return compose(f, f, D)
}

/** g^e by square-and-multiply — used for Wesolowski's π = g^q and g^r. */
export function power(f: Form, e: bigint, D: bigint): Form {
  if (e < 0n) return power(inverse(f, D), -e, D)
  let result = identity(D)
  let base = f
  while (e > 0n) {
    if (e & 1n) result = compose(result, base, D)
    base = square(base, D)
    e >>= 1n
  }
  return result
}

export function formEq(f: Form, g: Form): boolean {
  return f.a === g.a && f.b === g.b && f.c === g.c
}

export function isIdentity(f: Form, D: bigint): boolean {
  return formEq(f, identity(D))
}

// ── Integer square root (for coordinate-size bounds and displays) ───────────
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error('isqrt of negative')
  if (n < 2n) return n
  let x = n
  let y = (x + 1n) / 2n
  while (y < x) {
    x = y
    y = (x + n / x) / 2n
  }
  return x
}

/** Number of bits in |n|. */
export function bitLength(n: bigint): number {
  const a = absB(n)
  return a === 0n ? 0 : a.toString(2).length
}

// ── Discriminant generation — public randomness, no trusted setup ───────────
// Hash a seed to a prime p ≡ 3 (mod 4) and take Δ = −p. Then Δ ≡ 1 (mod 4) is a
// fundamental discriminant, |Δ| is prime, and the class number h(Δ) — the group
// order — is nobody's secret: it can only be found by a subexponential
// computation. The seed is public, so anyone can reproduce Δ and check it was
// not cooked; there is nothing up the sleeve and no ceremony to trust.
export function nextPrime(n: bigint): bigint {
  let p = n
  if (p <= 2n) return 2n
  if (p % 2n === 0n) p += 1n
  while (!isProbablePrime(p)) p += 2n
  return p
}

export function generateDiscriminant(seed: Uint8Array, bits = 256): bigint {
  for (let ctr = 0; ctr < 1 << 20; ctr++) {
    const blocks: Uint8Array[] = []
    const need = Math.ceil(bits / 8)
    for (let i = 0; blocks.reduce((s, b) => s + b.length, 0) < need; i++) {
      blocks.push(sha256(concat(utf8('curvefield/cg/disc'), seed, bigToBytes(BigInt(ctr), 4), bigToBytes(BigInt(i), 4))))
    }
    let p = bytesToBig(concat(...blocks)) & ((1n << BigInt(bits)) - 1n)
    p |= 1n << BigInt(bits - 1) // full width
    p = p - (p % 4n) + 3n // force p ≡ 3 (mod 4)
    // walk up in steps of 4 (staying ≡ 3 mod 4) to the next prime
    for (let step = 0; step < 8192; step++, p += 4n) {
      if (isProbablePrime(p)) return -p
    }
  }
  throw new Error('generateDiscriminant: exhausted counter')
}

// ── A canonical generator: the smallest odd prime form ──────────────────────
// A "prime form" (q, b, c) has q the least odd prime for which Δ is a quadratic
// residue mod q; then b solves b² ≡ Δ (mod 4q) with b odd (Δ is odd). Prime
// forms generate a large cyclic subgroup — a fine base g for the VDF. (Its exact
// order is, like h(Δ), unknown, which is precisely what we want.)
export function primeForm(D: bigint): Form {
  for (let q = 3n; q < 1n << 20n; q += 2n) {
    if (!isProbablePrime(q)) continue
    if (modPow(mod(D, q), (q - 1n) / 2n, q) !== 1n) continue // need (Δ|q) = 1
    let b = modSqrt(mod(D, q), q)
    if (b === null) continue
    // Lift the root so b is odd (Δ odd ⇒ b must be odd) and b² ≡ Δ (mod 4q).
    if (b % 2n === 0n) b = q - b // q odd ⇒ this flips the parity
    if ((b * b - D) % (4n * q) !== 0n) {
      b = b + 2n * q // adjust representative mod 2q to fix the mod-4q condition
      if ((b * b - D) % (4n * q) !== 0n) continue
    }
    return reduce({ a: q, b, c: cFrom(q, b, D) }, D)
  }
  throw new Error('primeForm: no small prime form found')
}

// ── Serialisation (fixed-width, for Fiat–Shamir transcripts) ────────────────
// A reduced form is pinned by (a, b) — c is recovered from Δ. Each is written as
// a 1-byte sign followed by |value| in a fixed width derived from |Δ| (reduced
// coordinates never exceed ~√|Δ|, so the full |Δ| width is always enough).
export function formByteWidth(D: bigint): number {
  return Math.ceil(absB(D).toString(16).length / 2)
}

export function serializeForm(f: Form, D: bigint): Uint8Array {
  const w = formByteWidth(D)
  const enc = (n: bigint): Uint8Array => {
    const out = new Uint8Array(w + 1)
    out[0] = n < 0n ? 1 : 0
    const mag = bigToBytes(absB(n), w)
    out.set(mag, 1)
    return out
  }
  return concat(enc(f.a), enc(f.b))
}

/** A short hex label for the UI (a | b). */
export function formLabel(f: Form): string {
  const hx = (n: bigint) => (n < 0n ? '-' : '') + absB(n).toString(16)
  return `${hx(f.a)} | ${hx(f.b)}`
}
