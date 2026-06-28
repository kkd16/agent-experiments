// The elliptic-curve group law over the REAL numbers, y² = x³ + ax + b.
//
// This is the picture everyone draws: a smooth cubic where "adding" two points
// means drawing the line through them, finding the third intersection, and
// reflecting it across the x-axis. The finite-field labs use the same algebra
// over F_p; here we keep it in floating point purely to render the geometry.

export type RPoint = { x: number; y: number } | null // null = point at infinity

export interface RealCurve {
  a: number
  b: number
}

/** Discriminant; the curve is smooth iff this is non-zero. */
export function discriminant({ a, b }: RealCurve): number {
  return -16 * (4 * a * a * a + 27 * b * b)
}

/** Evaluate the right-hand side x³ + ax + b. */
export function rhs(curve: RealCurve, x: number): number {
  return x * x * x + curve.a * x + curve.b
}

/** The two y-branches (±√rhs) at a given x, or null where rhs < 0. */
export function yAt(curve: RealCurve, x: number): [number, number] | null {
  const r = rhs(curve, x)
  if (r < 0) return null
  const y = Math.sqrt(r)
  return [y, -y]
}

/** Negation: reflect across the x-axis. */
export function negate(P: RPoint): RPoint {
  return P === null ? null : { x: P.x, y: -P.y }
}

/**
 * Real group law P + Q. Returns the sum together with the geometric scaffolding
 * (the chord/tangent slope and the pre-reflection third intersection point R)
 * so the UI can draw the construction.
 */
export function add(
  curve: RealCurve,
  P: RPoint,
  Q: RPoint,
): { sum: RPoint; slope: number | null; third: RPoint } {
  if (P === null) return { sum: Q, slope: null, third: negate(Q) }
  if (Q === null) return { sum: P, slope: null, third: negate(P) }

  // P + (−P) = O (a vertical line, no finite third point).
  if (Math.abs(P.x - Q.x) < 1e-12 && Math.abs(P.y + Q.y) < 1e-12) {
    return { sum: null, slope: null, third: null }
  }

  let slope: number
  if (Math.abs(P.x - Q.x) < 1e-12 && Math.abs(P.y - Q.y) < 1e-12) {
    // Tangent at P.
    if (Math.abs(P.y) < 1e-12) return { sum: null, slope: null, third: null }
    slope = (3 * P.x * P.x + curve.a) / (2 * P.y)
  } else {
    slope = (Q.y - P.y) / (Q.x - P.x)
  }

  const x3 = slope * slope - P.x - Q.x
  const yLine = slope * (x3 - P.x) + P.y // y of the line at x3 (the third hit)
  const third: RPoint = { x: x3, y: yLine }
  const sum: RPoint = { x: x3, y: -yLine } // reflect
  return { sum, slope, third }
}

/** Closest x on a chosen branch (sign of y) to a target — for drag-to-snap. */
export function snapToCurve(curve: RealCurve, x: number, preferUpper: boolean): RPoint {
  // March x toward the nearest region where rhs ≥ 0.
  let xv = x
  if (rhs(curve, xv) < 0) {
    // Step outward until we land on the curve's support.
    const step = 0.001
    let found = false
    for (let d = 0; d < 5000; d++) {
      if (rhs(curve, x + d * step) >= 0) {
        xv = x + d * step
        found = true
        break
      }
      if (rhs(curve, x - d * step) >= 0) {
        xv = x - d * step
        found = true
        break
      }
    }
    if (!found) return null
  }
  const ys = yAt(curve, xv)
  if (!ys) return null
  return { x: xv, y: preferUpper ? ys[0] : ys[1] }
}

/**
 * Sample polylines for the curve over [xmin, xmax]. The cubic may have one or
 * two real components, so we return separate segments where rhs ≥ 0.
 */
export function sampleCurve(
  curve: RealCurve,
  xmin: number,
  xmax: number,
  steps = 600,
): { upper: RPoint[]; lower: RPoint[] }[] {
  const segments: { upper: RPoint[]; lower: RPoint[] }[] = []
  let cur: { upper: RPoint[]; lower: RPoint[] } | null = null
  const dx = (xmax - xmin) / steps
  for (let i = 0; i <= steps; i++) {
    const x = xmin + i * dx
    const ys = yAt(curve, x)
    if (ys) {
      if (!cur) {
        cur = { upper: [], lower: [] }
        segments.push(cur)
      }
      cur.upper.push({ x, y: ys[0] })
      cur.lower.push({ x, y: ys[1] })
    } else {
      cur = null
    }
  }
  return segments
}
