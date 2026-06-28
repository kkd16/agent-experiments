// Geometry for the 2-D shadow view. For a system over exactly two variables
// (ids 0 and 1) it produces three layers the studio draws on an SVG:
//
//   • the integer LATTICE classified feasible / infeasible (exact, BigInt — the
//     same evaluation the solver and brute force use, so the dots never lie);
//   • the rational FEASIBLE POLYGON (the real region over ℚ), obtained by
//     Sutherland–Hodgman clipping of the view rectangle against each ≥ half-plane
//     — cosmetic, so floating point is fine here;
//   • the bounding LINES of every constraint, clipped to the viewport.
//
// The lattice layer is the exact part the self-check pins down; the polygon and
// lines are presentation only and never feed a correctness assertion.

import { evalLin } from './lin'
import type { Cons } from './omega'

export interface LatticePt {
  x: bigint
  y: bigint
  feasible: boolean
}

/** Is every constraint over only variables {0,1}? (drawable in 2-D). */
export function isTwoVar(cons: Cons[]): boolean {
  for (const c of cons) for (const v of c.lin.t.keys()) if (v !== 0 && v !== 1) return false
  return true
}

/** Classify every integer point of the box [xLo,xHi]×[yLo,yHi]. */
export function lattice(cons: Cons[], xLo: bigint, xHi: bigint, yLo: bigint, yHi: bigint): LatticePt[] {
  const out: LatticePt[] = []
  const model = new Map<number, bigint>()
  for (let y = yHi; y >= yLo; y--) {
    for (let x = xLo; x <= xHi; x++) {
      model.set(0, x)
      model.set(1, y)
      let ok = true
      for (const c of cons) {
        const v = evalLin(c.lin, model)
        if (c.op === 'eq' ? v !== 0n : v < 0n) {
          ok = false
          break
        }
      }
      out.push({ x, y, feasible: ok })
    }
  }
  return out
}

type P = [number, number]

function coeffNum(c: Cons, v: number): number {
  return Number(c.lin.t.get(v) ?? 0n)
}

/** Clip a convex polygon to the half-plane a·x + b·y + c ≥ 0. */
function clipHalfPlane(poly: P[], a: number, b: number, c: number): P[] {
  if (poly.length === 0) return poly
  const eps = 1e-9
  const inside = (p: P) => a * p[0] + b * p[1] + c >= -eps
  const out: P[] = []
  for (let i = 0; i < poly.length; i++) {
    const cur = poly[i]
    const nxt = poly[(i + 1) % poly.length]
    const curIn = inside(cur)
    const nxtIn = inside(nxt)
    if (curIn) out.push(cur)
    if (curIn !== nxtIn) {
      const dc = a * cur[0] + b * cur[1] + c
      const dn = a * nxt[0] + b * nxt[1] + c
      const t = dc / (dc - dn)
      out.push([cur[0] + t * (nxt[0] - cur[0]), cur[1] + t * (nxt[1] - cur[1])])
    }
  }
  return out
}

/**
 * The rational feasible polygon clipped to the viewport. Equalities clip both
 * ways (collapsing the region onto the line). Returns viewport-space points, or
 * an empty array if the region is empty within the box.
 */
export function feasiblePolygon(cons: Cons[], xLo: number, xHi: number, yLo: number, yHi: number): P[] {
  let poly: P[] = [
    [xLo, yLo],
    [xHi, yLo],
    [xHi, yHi],
    [xLo, yHi],
  ]
  for (const c of cons) {
    const a = coeffNum(c, 0)
    const b = coeffNum(c, 1)
    const k = Number(c.lin.c)
    poly = clipHalfPlane(poly, a, b, k) // a·x + b·y + k ≥ 0
    if (c.op === 'eq') poly = clipHalfPlane(poly, -a, -b, -k) // … and ≤ 0
    if (poly.length === 0) break
  }
  return poly
}

export interface ConstraintLine {
  /** Two endpoints clipped to the viewport, or null if it doesn't cross it. */
  seg: [P, P] | null
  op: 'eq' | 'ge'
  /** The inward side as a small label hint (a, b of a·x+b·y+c≥0). */
  a: number
  b: number
}

/** Bounding line a·x + b·y + c = 0 for each constraint, clipped to the box. */
export function constraintLines(cons: Cons[], xLo: number, xHi: number, yLo: number, yHi: number): ConstraintLine[] {
  const out: ConstraintLine[] = []
  for (const c of cons) {
    const a = coeffNum(c, 0)
    const b = coeffNum(c, 1)
    const k = Number(c.lin.c)
    out.push({ seg: clipLineToBox(a, b, k, xLo, xHi, yLo, yHi), op: c.op, a, b })
  }
  return out
}

/** Intersection of the line a·x+b·y+c=0 with the box, as a segment. */
function clipLineToBox(a: number, b: number, c: number, xLo: number, xHi: number, yLo: number, yHi: number): [P, P] | null {
  const pts: P[] = []
  const push = (x: number, y: number) => {
    if (x >= xLo - 1e-9 && x <= xHi + 1e-9 && y >= yLo - 1e-9 && y <= yHi + 1e-9) pts.push([x, y])
  }
  if (Math.abs(b) > 1e-12) {
    push(xLo, -(a * xLo + c) / b)
    push(xHi, -(a * xHi + c) / b)
  }
  if (Math.abs(a) > 1e-12) {
    push(-(b * yLo + c) / a, yLo)
    push(-(b * yHi + c) / a, yHi)
  }
  if (pts.length < 2) return null
  // pick the two most separated points
  let best: [P, P] | null = null
  let bestD = -1
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++) {
      const d = (pts[i][0] - pts[j][0]) ** 2 + (pts[i][1] - pts[j][1]) ** 2
      if (d > bestD) {
        bestD = d
        best = [pts[i], pts[j]]
      }
    }
  return best
}
