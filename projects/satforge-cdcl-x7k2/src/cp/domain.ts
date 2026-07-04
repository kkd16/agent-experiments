// Finite-domain integer variable domains.
//
// A `Domain` is an immutable, sorted-ascending array of distinct integers — the
// set of values a variable may still take. Every narrowing operation returns a
// *new* array when it removes something and the *same* array reference when it
// does not, so the propagation engine can detect "did this domain change?" with
// an O(1) reference comparison, and the trail can restore a domain by simply
// swapping back the old reference (immutable arrays ⇒ no defensive copies).
//
// Domains may have holes (e.g. {0,2,3}), which is exactly what a
// domain-consistent all-different (Régin) needs — it can carve a single value
// out of the middle of a range, not just shrink the endpoints.

/** An immutable, sorted-ascending set of distinct integers. */
export type Domain = readonly number[]

/** The inclusive integer range [lo, hi] as a domain. Empty if lo > hi. */
export function range(lo: number, hi: number): Domain {
  const out: number[] = []
  for (let v = lo; v <= hi; v++) out.push(v)
  return out
}

/** A domain from an arbitrary list of integers (deduplicated + sorted). */
export function fromValues(vals: Iterable<number>): Domain {
  const s = new Set<number>()
  for (const v of vals) s.add(v)
  return [...s].sort((a, b) => a - b)
}

/** A singleton domain {v}. */
export function singleton(v: number): Domain {
  return [v]
}

export const isEmpty = (d: Domain): boolean => d.length === 0
export const isFixed = (d: Domain): boolean => d.length === 1
export const min = (d: Domain): number => d[0]
export const max = (d: Domain): number => d[d.length - 1]
export const size = (d: Domain): number => d.length

/** The single value of a fixed domain (caller guarantees `isFixed`). */
export function value(d: Domain): number {
  return d[0]
}

/** Binary search: is `v` present? Domains are sorted so this is O(log n). */
export function contains(d: Domain, v: number): boolean {
  let lo = 0
  let hi = d.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const x = d[mid]
    if (x === v) return true
    if (x < v) lo = mid + 1
    else hi = mid - 1
  }
  return false
}

/**
 * Remove one value. Returns the same reference if `v` was absent (no change),
 * otherwise a new domain (possibly empty).
 */
export function removeValue(d: Domain, v: number): Domain {
  if (!contains(d, v)) return d
  const out: number[] = []
  for (const x of d) if (x !== v) out.push(x)
  return out
}

/** Keep only values ≥ lo (raise the lower bound). Same ref if unchanged. */
export function removeBelow(d: Domain, lo: number): Domain {
  if (d.length === 0 || d[0] >= lo) return d
  const out: number[] = []
  for (const x of d) if (x >= lo) out.push(x)
  return out
}

/** Keep only values ≤ hi (lower the upper bound). Same ref if unchanged. */
export function removeAbove(d: Domain, hi: number): Domain {
  if (d.length === 0 || d[d.length - 1] <= hi) return d
  const out: number[] = []
  for (const x of d) if (x <= hi) out.push(x)
  return out
}

/** Intersect with the inclusive interval [lo, hi]. */
export function keepInterval(d: Domain, lo: number, hi: number): Domain {
  return removeAbove(removeBelow(d, lo), hi)
}

/** Remove every value inside the inclusive interval [lo, hi]. Same ref if none. */
export function removeInterval(d: Domain, lo: number, hi: number): Domain {
  let hit = false
  const out: number[] = []
  for (const x of d) {
    if (x >= lo && x <= hi) hit = true
    else out.push(x)
  }
  return hit ? out : d
}

/** Fix the domain to the single value {v} (empty if v ∉ d). Same ref if already {v}. */
export function assign(d: Domain, v: number): Domain {
  if (d.length === 1 && d[0] === v) return d
  return contains(d, v) ? [v] : []
}

/**
 * Intersect with a set of allowed values. Returns the same reference if nothing
 * was removed; a new (possibly empty) domain otherwise.
 */
export function keepOnly(d: Domain, allowed: ReadonlySet<number>): Domain {
  let changed = false
  const out: number[] = []
  for (const x of d) {
    if (allowed.has(x)) out.push(x)
    else changed = true
  }
  return changed ? out : d
}

/** Set intersection of two domains (sorted-merge). */
export function intersect(a: Domain, b: Domain): Domain {
  const out: number[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(a[i])
      i++
      j++
    } else if (a[i] < b[j]) i++
    else j++
  }
  return out
}

/** Human-readable form: "{1,2,5}" or "0..8" when the domain is a full range. */
export function format(d: Domain): string {
  if (d.length === 0) return '∅'
  if (d.length === 1) return String(d[0])
  // Contiguous? render as a range.
  if (d[d.length - 1] - d[0] === d.length - 1) return `${d[0]}..${d[d.length - 1]}`
  if (d.length <= 12) return `{${d.join(',')}}`
  return `{${d.slice(0, 10).join(',')},… (${d.length})}`
}
