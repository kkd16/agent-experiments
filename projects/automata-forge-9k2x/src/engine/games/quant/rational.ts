// Exact rational arithmetic — the mean-payoff *value* of a game is a rational number with a small
// denominator (at most the number of vertices), so to report it *exactly* we never touch floating
// point. A `Rational` is always kept reduced with a strictly-positive denominator, so equality is a
// pair compare and ordering is one cross-multiplication. Also here: Karp's minimum-cycle-mean
// algorithm (the exact value a fixed pair of positional strategies yields) and best-rational
// rounding (the last step of Zwick–Paterson value iteration).

/** A reduced fraction p/q with q > 0. Integers are p/1. */
export interface Rational {
  p: number
  q: number
}

function gcd(a: number, b: number): number {
  a = Math.abs(a)
  b = Math.abs(b)
  while (b) {
    ;[a, b] = [b, a % b]
  }
  return a
}

/** Build a reduced rational from any integer numerator/denominator (denominator ≠ 0). */
export function rat(p: number, q = 1): Rational {
  if (q === 0) throw new Error('rational with zero denominator')
  if (q < 0) {
    p = -p
    q = -q
  }
  const g = gcd(p, q) || 1
  return { p: p / g, q: q / g }
}

export const ZERO: Rational = { p: 0, q: 1 }

export function ratAdd(a: Rational, b: Rational): Rational {
  return rat(a.p * b.q + b.p * a.q, a.q * b.q)
}
export function ratSub(a: Rational, b: Rational): Rational {
  return rat(a.p * b.q - b.p * a.q, a.q * b.q)
}
export function ratMul(a: Rational, b: Rational): Rational {
  return rat(a.p * b.p, a.q * b.q)
}
export function ratNeg(a: Rational): Rational {
  return { p: -a.p, q: a.q }
}

/** sign(a − b): −1, 0, or +1. */
export function ratCmp(a: Rational, b: Rational): number {
  const d = a.p * b.q - b.p * a.q
  return d < 0 ? -1 : d > 0 ? 1 : 0
}
export function ratEq(a: Rational, b: Rational): boolean {
  return a.p === b.p && a.q === b.q
}
export function ratToNumber(a: Rational): number {
  return a.p / a.q
}

/** A compact display: an integer prints plainly, otherwise `p/q`. */
export function ratStr(a: Rational): string {
  return a.q === 1 ? String(a.p) : `${a.p}/${a.q}`
}

/**
 * The rational with denominator ≤ `maxDen` closest to x = num/den. This is the exact-recovery step
 * of Zwick–Paterson: the iterate f_k(v)/k lands within 1/(2n²) of the true value, and distinct
 * candidate values (denominators ≤ n) are ≥ 1/n² apart, so the nearest small-denominator rational
 * *is* the value. `maxDen` is small (the vertex count) so a direct scan is more than fast enough.
 */
export function bestRational(num: number, den: number, maxDen: number): Rational {
  if (den < 0) {
    num = -num
    den = -den
  }
  const x = num / den
  let best = rat(Math.round(x), 1)
  let bestErr = Math.abs(ratToNumber(best) - x)
  for (let q = 1; q <= maxDen; q++) {
    const p = Math.round((num * q) / den)
    const err = Math.abs(p / q - x)
    if (err < bestErr - 1e-12) {
      bestErr = err
      best = rat(p, q)
    }
  }
  return best
}

// ---------------------------------------------------------------------------
// Karp's minimum cycle mean — the exact objective a play's eventual cycle realises.
// ---------------------------------------------------------------------------

/** A weighted directed edge used by the cycle-mean routines. */
export interface WEdge {
  to: number
  w: number
}

/** Tarjan SCCs restricted to `present`, using only edges that stay inside it. */
function sccs(n: number, out: WEdge[][], present: boolean[]): number[][] {
  const index = new Array(n).fill(-1)
  const low = new Array(n).fill(0)
  const onStack = new Array(n).fill(false)
  const stack: number[] = []
  const comps: number[][] = []
  let idx = 0
  for (let s = 0; s < n; s++) {
    if (!present[s] || index[s] !== -1) continue
    const work: { v: number; i: number }[] = [{ v: s, i: 0 }]
    index[s] = low[s] = idx++
    stack.push(s)
    onStack[s] = true
    while (work.length) {
      const top = work[work.length - 1]
      const v = top.v
      const es = out[v]
      if (top.i < es.length) {
        const w = es[top.i++].to
        if (!present[w]) continue
        if (index[w] === -1) {
          index[w] = low[w] = idx++
          stack.push(w)
          onStack[w] = true
          work.push({ v: w, i: 0 })
        } else if (onStack[w]) {
          low[v] = Math.min(low[v], index[w])
        }
      } else {
        if (low[v] === index[v]) {
          const comp: number[] = []
          for (;;) {
            const w = stack.pop() as number
            onStack[w] = false
            comp.push(w)
            if (w === v) break
          }
          comps.push(comp)
        }
        work.pop()
        if (work.length) {
          const parent = work[work.length - 1].v
          low[parent] = Math.min(low[parent], low[v])
        }
      }
    }
  }
  return comps
}

/**
 * The minimum cycle mean of the sub-graph induced by `present`, as an exact rational — or `null`
 * if that sub-graph is acyclic. Karp's theorem is applied per strongly-connected component:
 * for a component with vertex set S rooted at any s ∈ S,
 *   λ* = min_v  max_{0 ≤ k < |S|}  (d_{|S|}(v) − d_k(v)) / (|S| − k),
 * where d_k(v) is the least weight of a length-k walk from s. We take the min λ* over all components.
 */
export function minCycleMean(n: number, out: WEdge[][], present: boolean[]): Rational | null {
  let best: Rational | null = null
  for (const comp of sccs(n, out, present)) {
    const inComp = new Array(n).fill(false)
    for (const v of comp) inComp[v] = true
    const selfOnly = comp.length === 1 && !out[comp[0]].some((e) => e.to === comp[0])
    if (selfOnly) continue // a lone vertex with no self-loop carries no cycle

    const m = comp.length
    const INF = Infinity
    const s = comp[0]
    // d[k][v]: least weight of a walk of exactly k edges from s to v, inside the component.
    const d: number[][] = Array.from({ length: m + 1 }, () => new Array(n).fill(INF))
    d[0][s] = 0
    for (let k = 0; k < m; k++) {
      for (const v of comp) {
        if (d[k][v] === INF) continue
        for (const e of out[v]) {
          if (!inComp[e.to]) continue
          const nv = d[k][v] + e.w
          if (nv < d[k + 1][e.to]) d[k + 1][e.to] = nv
        }
      }
    }
    for (const v of comp) {
      if (d[m][v] === INF) continue
      // max over k of (d_m(v) − d_k(v))/(m − k); the vertex value is a candidate cycle mean.
      let vMax: Rational | null = null
      for (let k = 0; k < m; k++) {
        if (d[k][v] === INF) continue
        const cand = rat(d[m][v] - d[k][v], m - k)
        if (vMax === null || ratCmp(cand, vMax) > 0) vMax = cand
      }
      if (vMax !== null && (best === null || ratCmp(vMax, best) < 0)) best = vMax
    }
  }
  return best
}
