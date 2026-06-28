// Exact linear arithmetic over the integers, on BigInt.
//
// The Omega test (omega.ts) manipulates linear constraints whose coefficients
// can grow large as variables are eliminated (a dark-shadow combination
// multiplies two coefficients together), so every coefficient is a BigInt and
// there is no floating point anywhere in the decision procedure. A `Lin` is an
// affine form  `c + Σ tᵢ·xᵢ`  with variables identified by small integer ids;
// the term map only ever holds nonzero coefficients so structural emptiness ==
// "this form is a constant".

/** An affine integer form `c + Σ t[v]·x_v`. The map holds only nonzero terms. */
export interface Lin {
  c: bigint
  t: Map<number, bigint>
}

export const zero = (): Lin => ({ c: 0n, t: new Map() })

export function constant(c: bigint): Lin {
  return { c, t: new Map() }
}

/** A bare variable `x_v`. */
export function variable(v: number): Lin {
  return { c: 0n, t: new Map([[v, 1n]]) }
}

export function cloneLin(a: Lin): Lin {
  return { c: a.c, t: new Map(a.t) }
}

/** a + s·b (s a scalar). */
export function addScaled(a: Lin, b: Lin, s: bigint): Lin {
  const out: Lin = { c: a.c + s * b.c, t: new Map(a.t) }
  for (const [v, k] of b.t) {
    const nk = (out.t.get(v) ?? 0n) + s * k
    if (nk === 0n) out.t.delete(v)
    else out.t.set(v, nk)
  }
  return out
}

export const add = (a: Lin, b: Lin): Lin => addScaled(a, b, 1n)
export const sub = (a: Lin, b: Lin): Lin => addScaled(a, b, -1n)

export function scale(a: Lin, s: bigint): Lin {
  if (s === 0n) return zero()
  const out: Lin = { c: a.c * s, t: new Map() }
  for (const [v, k] of a.t) out.t.set(v, k * s)
  return out
}

export const negate = (a: Lin): Lin => scale(a, -1n)

export function addConst(a: Lin, c: bigint): Lin {
  return { c: a.c + c, t: new Map(a.t) }
}

export function coeff(a: Lin, v: number): bigint {
  return a.t.get(v) ?? 0n
}

/** Remove the `v` term, returning a fresh form (the var's coefficient is lost). */
export function dropVar(a: Lin, v: number): Lin {
  const t = new Map(a.t)
  t.delete(v)
  return { c: a.c, t }
}

/** Evaluate the form at an assignment; absent variables are treated as 0. */
export function evalLin(a: Lin, model: Map<number, bigint>): bigint {
  let s = a.c
  for (const [v, k] of a.t) s += k * (model.get(v) ?? 0n)
  return s
}

export function isConst(a: Lin): boolean {
  return a.t.size === 0
}

function absBig(x: bigint): bigint {
  return x < 0n ? -x : x
}

export function gcdBig(a: bigint, b: bigint): bigint {
  a = absBig(a)
  b = absBig(b)
  while (b) [a, b] = [b, a % b]
  return a
}

/** gcd of all (nonzero) variable coefficients; 0n if the form is constant. */
export function varGcd(a: Lin): bigint {
  let g = 0n
  for (const k of a.t.values()) g = gcdBig(g, k)
  return g
}

/** floor(a / b) for b > 0, correct for negative a. */
export function floorDiv(a: bigint, b: bigint): bigint {
  let q = a / b
  if (a % b !== 0n && a < 0n) q -= 1n
  return q
}

/** ceil(a / b) for b > 0, correct for negative a. */
export function ceilDiv(a: bigint, b: bigint): bigint {
  let q = a / b
  if (a % b !== 0n && a > 0n) q += 1n
  return q
}

/**
 * Centered remainder of `a` modulo `m > 0`, landing in (−m/2, m/2]. Returns the
 * remainder `r` and the matching quotient `q` with `a = q·m + r`. This is the
 * balanced division that drives the Omega test's equality elimination — each
 * reduced coefficient shrinks by at least a factor of two, so the procedure
 * mirrors the Euclidean algorithm and terminates.
 */
export function centered(a: bigint, m: bigint): { q: bigint; r: bigint } {
  let r = ((a % m) + m) % m // [0, m)
  if (2n * r > m) r -= m // (−m/2, m/2]
  const q = (a - r) / m
  return { q, r }
}

/** Render a form as `2x + 3y - 1`, using a names lookup (falls back to v#id). */
export function formatLin(a: Lin, names: (v: number) => string): string {
  const parts: string[] = []
  const ids = [...a.t.keys()].sort((x, y) => x - y)
  for (const v of ids) {
    const k = a.t.get(v)!
    const mag = absBig(k)
    const sign = k < 0n ? '−' : parts.length ? '+' : ''
    const body = mag === 1n ? names(v) : `${mag}${names(v)}`
    parts.push(parts.length ? `${sign} ${body}` : `${k < 0n ? '−' : ''}${body}`)
  }
  if (a.c !== 0n || parts.length === 0) {
    const mag = absBig(a.c)
    if (parts.length === 0) parts.push(`${a.c}`)
    else parts.push(`${a.c < 0n ? '−' : '+'} ${mag}`)
  }
  return parts.join(' ')
}
