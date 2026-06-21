/**
 * Convex-polygon clipping and area primitives for the fracture subsystem.
 *
 * Everything here operates on a polygon given as an ordered ring of `Vec2`
 * vertices (counter-clockwise for the area/containment helpers). These three
 * tiny functions are the entire geometric foundation the Voronoi shatterer is
 * built from — a half-plane clip, a signed area, and a convex point test — so
 * each is verified directly in the suite.
 */
import { Vec2 } from '../math';

/**
 * Sutherland–Hodgman clip of a convex polygon `poly` against the half-plane
 * `{ p : n·p ≤ offset }`, returning the part on the inside (the `≤` side) wound
 * the same way as the input. An entirely-outside polygon clips to the empty
 * ring; an entirely-inside polygon is returned unchanged.
 *
 * The bisector of two Voronoi sites is exactly a half-plane, so clipping a
 * shape against one bisector per neighbouring site carves out that site's cell.
 */
export function clipHalfPlane(poly: readonly Vec2[], n: Vec2, offset: number): Vec2[] {
  const out: Vec2[] = [];
  const count = poly.length;
  if (count === 0) return out;
  for (let i = 0; i < count; i++) {
    const cur = poly[i];
    const nxt = poly[(i + 1) % count];
    const dCur = n.dot(cur) - offset; // ≤ 0 ⇒ inside
    const dNxt = n.dot(nxt) - offset;
    const curIn = dCur <= 0;
    const nxtIn = dNxt <= 0;
    if (curIn) out.push(cur);
    // The edge crosses the plane exactly when its endpoints straddle it.
    if (curIn !== nxtIn) {
      const denom = dCur - dNxt;
      const t = Math.abs(denom) > 1e-15 ? dCur / denom : 0;
      out.push(cur.add(nxt.sub(cur).mul(t)));
    }
  }
  return out;
}

/** Signed area of a polygon ring (positive when wound counter-clockwise). */
export function polygonArea(poly: readonly Vec2[]): number {
  let a = 0;
  const count = poly.length;
  for (let i = 0; i < count; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % count];
    a += p.cross(q);
  }
  return a * 0.5;
}

/**
 * True when `p` lies inside (or on the boundary of) a counter-clockwise convex
 * polygon — i.e. it sits weakly to the left of every directed edge.
 */
export function pointInConvex(poly: readonly Vec2[], p: Vec2, tol = 1e-9): boolean {
  const count = poly.length;
  if (count < 3) return false;
  for (let i = 0; i < count; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % count];
    if (b.sub(a).cross(p.sub(a)) < -tol) return false;
  }
  return true;
}

/** Axis-aligned bounds of a polygon ring as `[min, max]`. */
export function polygonBounds(poly: readonly Vec2[]): [Vec2, Vec2] {
  let min = poly[0];
  let max = poly[0];
  for (let i = 1; i < poly.length; i++) {
    min = min.min(poly[i]);
    max = max.max(poly[i]);
  }
  return [min, max];
}
