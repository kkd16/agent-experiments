// DIFFERENCE BOUND MATRICES — the workhorse representation of a clock ZONE.
//
// A zone is a convex set of clock valuations defined by difference constraints
// `x_i − x_j ≤ c` (or `< c`). Introduce a fictitious reference clock `x_0 ≡ 0`
// so a plain bound `x ≤ c` is `x − x_0 ≤ c` and `x ≥ c` is `x_0 − x ≤ −c`. Then
// an n-clock zone is an (n+1)×(n+1) matrix `D` of bounds, `D[i][j]` bounding
// `x_i − x_j`. The whole geometry of real-time verification — delay, reset,
// guard intersection, inclusion, extrapolation — becomes small matrix surgery,
// and the canonical (tightest) form is just all-pairs shortest paths.
//
// A BOUND is a pair `(value, strict?)` meaning `≤ value` or `< value`, with `∞`
// for "no constraint". Bounds are ordered (tighter = smaller), added
// (`x≤a ∧ y≤b ⟹ x+y ≤ a+b`, strict if either is), and min-ed — that is the
// entire algebra the algorithms below are built from.

/** A bound on a difference: `value` with `strict` = using `<` instead of `≤`. `value === Infinity` is ∞. */
export interface Bound {
  value: number
  strict: boolean
}

/** A difference bound matrix: `m[i][j]` bounds `x_i − x_j`; index 0 is the reference clock ≡ 0. */
export interface DBM {
  /** number of real clocks (matrix dimension is `n + 1`) */
  n: number
  m: Bound[][]
}

export const INF: Bound = { value: Infinity, strict: true }
export const LE0: Bound = { value: 0, strict: false }

export function le(v: number): Bound {
  return { value: v, strict: false }
}
export function lt(v: number): Bound {
  return { value: v, strict: true }
}

/** Is bound `a` strictly tighter than `b`? (`≤` is tighter than `<` at equal value.) */
export function tighter(a: Bound, b: Bound): boolean {
  if (a.value !== b.value) return a.value < b.value
  // equal value: (< v) is tighter than (≤ v)
  return a.strict && !b.strict
}

/** Equality of bounds. */
export function boundEq(a: Bound, b: Bound): boolean {
  if (a.value === Infinity && b.value === Infinity) return true
  return a.value === b.value && a.strict === b.strict
}

/** The tighter (smaller) of two bounds. */
export function minBound(a: Bound, b: Bound): Bound {
  return tighter(a, b) ? a : b
}

/** Add two bounds: `(a) + (b)`. ∞ absorbs; strict if either operand is strict. */
export function addBound(a: Bound, b: Bound): Bound {
  if (a.value === Infinity || b.value === Infinity) return INF
  return { value: a.value + b.value, strict: a.strict || b.strict }
}

function cloneRow(r: Bound[]): Bound[] {
  return r.map((b) => ({ value: b.value, strict: b.strict }))
}

export function cloneDBM(d: DBM): DBM {
  return { n: d.n, m: d.m.map(cloneRow) }
}

/** The universe zone (every clock ≥ 0, otherwise unconstrained). */
export function universe(n: number): DBM {
  const m: Bound[][] = []
  for (let i = 0; i <= n; i++) {
    m.push([])
    for (let j = 0; j <= n; j++) {
      // diagonal and "x_i - x_0 ≤ 0" style: default ∞, except x_0 - x_i ≤ 0 (clocks ≥ 0) and diagonal ≤ 0.
      if (i === j) m[i].push(le(0))
      else if (i === 0) m[i].push(le(0)) // x_0 - x_j ≤ 0  ⟺  x_j ≥ 0
      else m[i].push({ ...INF })
    }
  }
  return m2dbm(n, m)
}

/** The single point where every clock is 0. */
export function zeroZone(n: number): DBM {
  const m: Bound[][] = []
  for (let i = 0; i <= n; i++) {
    m.push([])
    for (let j = 0; j <= n; j++) m[i].push(le(0))
  }
  return { n, m }
}

function m2dbm(n: number, m: Bound[][]): DBM {
  return { n, m }
}

/**
 * Canonicalise to the TIGHTEST equivalent DBM via Floyd–Warshall all-pairs
 * shortest paths. After this, `m[i][j]` is the strongest derivable bound on
 * `x_i − x_j`, and two zones are equal iff their canonical DBMs are identical.
 */
export function canonicalize(d: DBM): DBM {
  const n = d.n
  const m = d.m
  for (let k = 0; k <= n; k++) {
    for (let i = 0; i <= n; i++) {
      const mik = m[i][k]
      if (mik.value === Infinity) continue
      for (let j = 0; j <= n; j++) {
        const through = addBound(mik, m[k][j])
        if (tighter(through, m[i][j])) m[i][j] = through
      }
    }
  }
  return d
}

/** Is the zone empty? (a negative cycle ⟺ some diagonal bound < 0 after canonicalisation) */
export function isEmpty(d: DBM): boolean {
  for (let i = 0; i <= d.n; i++) {
    const b = d.m[i][i]
    if (b.value < 0 || (b.value === 0 && b.strict)) return true
  }
  return false
}

/** A fresh canonical copy known to be non-empty, or null if the zone is empty. */
export function normalized(d: DBM): DBM | null {
  const c = canonicalize(cloneDBM(d))
  return isEmpty(c) ? null : c
}

/**
 * DELAY (a.k.a. `up` / time-elapse): let an arbitrary δ ≥ 0 pass. Every clock
 * grows by the same δ, so all *upper* bounds relative to 0 are released
 * (`x_i − x_0 ≤ ∞`) while lower bounds and differences are preserved. On a
 * canonical DBM this stays canonical.
 */
export function up(d: DBM): DBM {
  const r = cloneDBM(d)
  for (let i = 1; i <= r.n; i++) r.m[i][0] = { ...INF }
  return r
}

/**
 * DOWN (`past`): the set of valuations that can *reach* this zone by delay —
 * the time-predecessor. Releases lower bounds relative to 0 (then re-tightens
 * with clocks ≥ 0). Handy for backward reasoning; kept for completeness.
 */
export function down(d: DBM): DBM {
  const r = cloneDBM(d)
  for (let i = 1; i <= r.n; i++) {
    r.m[0][i] = le(0)
    for (let j = 1; j <= r.n; j++) {
      if (tighter(r.m[j][i], r.m[0][i])) r.m[0][i] = { value: r.m[j][i].value, strict: r.m[j][i].strict }
    }
  }
  return canonicalize(r)
}

/** Intersect in place with one difference bound `x_i − x_j ⋈ (bound)`; returns the DBM (not re-canonicalised). */
function tightenDiff(d: DBM, i: number, j: number, b: Bound): void {
  if (tighter(b, d.m[i][j])) d.m[i][j] = { value: b.value, strict: b.strict }
}

/**
 * Intersect with an atomic clock constraint `x ⋈ c` (x is real-clock index
 * `ci`, so DBM index `ci+1`). Returns a NEW canonical DBM (may be empty).
 */
export function applyAtom(d: DBM, ci: number, op: CmpForDbm, c: number): DBM {
  const r = cloneDBM(d)
  const x = ci + 1
  switch (op) {
    case '<':
      tightenDiff(r, x, 0, lt(c)) // x - 0 < c
      break
    case '<=':
      tightenDiff(r, x, 0, le(c))
      break
    case '>':
      tightenDiff(r, 0, x, lt(-c)) // 0 - x < -c
      break
    case '>=':
      tightenDiff(r, 0, x, le(-c))
      break
    case '=':
      tightenDiff(r, x, 0, le(c))
      tightenDiff(r, 0, x, le(-c))
      break
  }
  return canonicalize(r)
}

export type CmpForDbm = '<' | '<=' | '=' | '>=' | '>'

/**
 * RESET clock `ci` to 0. In DBM terms clock `x` becomes a copy of the reference
 * clock 0: row and column `x` are set from row/column 0. Stays canonical.
 */
export function reset(d: DBM, ci: number): DBM {
  const r = cloneDBM(d)
  const x = ci + 1
  for (let j = 0; j <= r.n; j++) {
    r.m[x][j] = { value: r.m[0][j].value, strict: r.m[0][j].strict }
    r.m[j][x] = { value: r.m[j][0].value, strict: r.m[j][0].strict }
  }
  r.m[x][x] = le(0)
  return r
}

/** Reset several clocks (indices) to 0. */
export function resetMany(d: DBM, cis: number[]): DBM {
  let r = d
  for (const ci of cis) r = reset(r, ci)
  return r
}

/**
 * Zone INCLUSION `d ⊆ e` on canonical DBMs: every bound of `d` is at least as
 * tight as the corresponding bound of `e`.
 */
export function includes(e: DBM, d: DBM): boolean {
  // returns true iff  d ⊆ e
  for (let i = 0; i <= d.n; i++)
    for (let j = 0; j <= d.n; j++) {
      // need d.m[i][j] ≤ e.m[i][j]  (d at least as tight)
      if (tighter(e.m[i][j], d.m[i][j])) return false
    }
  return true
}

/** Structural equality of two canonical DBMs. */
export function equalDBM(a: DBM, b: DBM): boolean {
  if (a.n !== b.n) return false
  for (let i = 0; i <= a.n; i++) for (let j = 0; j <= a.n; j++) if (!boundEq(a.m[i][j], b.m[i][j])) return false
  return true
}

/**
 * EXTRAPOLATION (classic maximal-bound abstraction, Extra_M). Guards, invariants
 * and resets only ever compare a clock to constants up to `M(x)`; any tighter
 * information beyond that constant is irrelevant to reachability. Coarsening the
 * zone accordingly bounds the number of distinct zones per location, which is
 * exactly what makes forward reachability TERMINATE. Sound: `d ⊆ ExtraM(d)`.
 */
export function extrapolate(d: DBM, max: number[]): DBM {
  const r = cloneDBM(d)
  const n = r.n
  const M = (i: number) => (i === 0 ? 0 : max[i - 1]) // reference clock's max is 0
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      if (i === j) continue
      const b = r.m[i][j]
      if (b.value === Infinity) continue
      if (b.value > M(i)) {
        r.m[i][j] = { ...INF }
      } else if (b.value < -M(j)) {
        r.m[i][j] = lt(-M(j))
      }
    }
  }
  return canonicalize(r)
}

/** Does a concrete valuation lie in the zone? (checks every difference bound, with x_0 ≡ 0) */
export function contains(d: DBM, v: number[]): boolean {
  const x = [0, ...v] // reference clock 0
  for (let i = 0; i <= d.n; i++)
    for (let j = 0; j <= d.n; j++) {
      const b = d.m[i][j]
      if (b.value === Infinity) continue
      const diff = x[i] - x[j]
      if (b.strict ? !(diff < b.value + 1e-9) : !(diff <= b.value + 1e-9)) return false
    }
  return true
}

/**
 * Render the zone as human-readable constraints (bounds vs 0 and the tighter
 * pairwise differences), for the DBM inspector in the UI.
 */
export function describeZone(d: DBM, clocks: string[]): string[] {
  const out: string[] = []
  const n = d.n
  for (let i = 1; i <= n; i++) {
    const x = clocks[i - 1]
    const ub = d.m[i][0]
    const lbNeg = d.m[0][i] // 0 - x ≤ v  ⟺  x ≥ -v
    const lo = -lbNeg.value
    const loStrict = lbNeg.strict
    if (ub.value === Infinity) {
      out.push(`${x} ${loStrict ? '>' : '≥'} ${lo}`)
    } else if (lo === ub.value && !loStrict && !ub.strict) {
      out.push(`${x} = ${lo}`)
    } else {
      out.push(`${lo} ${loStrict ? '<' : '≤'} ${x} ${ub.strict ? '<' : '≤'} ${ub.value}`)
    }
  }
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= n; j++) {
      if (i === j) continue
      const b = d.m[i][j]
      if (b.value === Infinity) continue
      // only surface a genuinely constraining diagonal
      if (b.value <= 0 && !(b.value === 0 && !b.strict)) continue
      out.push(`${clocks[i - 1]} − ${clocks[j - 1]} ${b.strict ? '<' : '≤'} ${b.value}`)
    }
  return out
}
