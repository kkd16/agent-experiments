// The pumping lemma for context-free languages, as an interactive playground.
//
// If L is context-free there is a pumping length p such that every z ∈ L with |z| ≥ p splits as
// z = u v x y z′ with |v x y| ≤ p, |v y| ≥ 1, and u vⁱ x yⁱ z′ ∈ L for every i ≥ 0. To *disprove*
// context-freeness you (the adversary) pick a hard z; the lemma forces a split; you find an i that
// kicks the pumped word out of L. This module just computes pumped words and checks the side
// conditions — membership is decided by the Earley engine in the UI.

/** Cut points 0 ≤ a ≤ b ≤ c ≤ d ≤ |z| partitioning z into u=[0,a) v=[a,b) x=[b,c) y=[c,d) z′=[d,…). */
export interface Decomposition {
  a: number
  b: number
  c: number
  d: number
}

export interface Parts {
  u: string
  v: string
  x: string
  y: string
  tail: string
}

export function parts(z: string, dec: Decomposition): Parts {
  return {
    u: z.slice(0, dec.a),
    v: z.slice(dec.a, dec.b),
    x: z.slice(dec.b, dec.c),
    y: z.slice(dec.c, dec.d),
    tail: z.slice(dec.d),
  }
}

/** Build the pumped word u vⁱ x yⁱ z′. */
export function pump(z: string, dec: Decomposition, i: number): string {
  const p = parts(z, dec)
  return p.u + p.v.repeat(i) + p.x + p.y.repeat(i) + p.tail
}

export interface DecompChecks {
  /** |v x y| ≤ p */
  windowOk: boolean
  /** |v y| ≥ 1 */
  nonemptyOk: boolean
  vxyLen: number
  vyLen: number
}

export function checkDecomposition(dec: Decomposition, p: number): DecompChecks {
  const vxyLen = dec.d - dec.a
  const vyLen = dec.b - dec.a + (dec.d - dec.c)
  return { windowOk: vxyLen <= p, nonemptyOk: vyLen >= 1, vxyLen, vyLen }
}

/** Clamp/repair an arbitrary decomposition so the cut points stay ordered and in range. */
export function normalizeDecomposition(dec: Decomposition, len: number): Decomposition {
  const a = Math.max(0, Math.min(dec.a, len))
  const b = Math.max(a, Math.min(dec.b, len))
  const c = Math.max(b, Math.min(dec.c, len))
  const d = Math.max(c, Math.min(dec.d, len))
  return { a, b, c, d }
}
