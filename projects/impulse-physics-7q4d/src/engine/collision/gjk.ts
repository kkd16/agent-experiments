import { Transform, Vec2 } from '../math';
import { shapeSupport, type Shape } from '../shapes';

/**
 * A vertex of the Minkowski difference A ⊖ B together with the witness points on
 * each shape that produced it. Tracking the witnesses lets GJK report the
 * closest points, not just the distance.
 */
interface SupportPoint {
  /** `wA - wB`, a point of the Minkowski difference. */
  w: Vec2;
  wA: Vec2;
  wB: Vec2;
}

export interface DistanceResult {
  distance: number;
  /** Closest point on shape A (world space). */
  pointA: Vec2;
  /** Closest point on shape B (world space). */
  pointB: Vec2;
  /** True when the shapes overlap (distance is 0). */
  overlap: boolean;
  /** Final GJK simplex (Minkowski-difference points) for visualization. */
  simplex: Vec2[];
  iterations: number;
}

function support(
  sa: Shape,
  xa: Transform,
  sb: Shape,
  xb: Transform,
  dir: Vec2,
  core = false,
): SupportPoint {
  const wA = shapeSupport(sa, xa, dir, core);
  const wB = shapeSupport(sb, xb, dir.neg(), core);
  return { w: wA.sub(wB), wA, wB };
}

/** Closest point to the origin on segment [a, b], plus its barycentric weights. */
function closestOnSegment(a: Vec2, b: Vec2): { point: Vec2; u: number; v: number } {
  const ab = b.sub(a);
  const t = -a.dot(ab);
  if (t <= 0) return { point: a, u: 1, v: 0 };
  const denom = ab.lengthSq();
  if (t >= denom) return { point: b, u: 0, v: 1 };
  const v = t / denom;
  return { point: a.add(ab.mul(v)), u: 1 - v, v };
}

/**
 * The Gilbert–Johnson–Keerthi distance algorithm. Returns the minimum distance
 * and the closest pair of points between two convex shapes, or flags overlap.
 */
export function gjkDistance(
  sa: Shape,
  xa: Transform,
  sb: Shape,
  xb: Transform,
  maxIters = 32,
  core = false,
): DistanceResult {
  let dir = xa.position.sub(xb.position);
  if (dir.lengthSq() < 1e-12) dir = new Vec2(1, 0);

  let simplex: SupportPoint[] = [support(sa, xa, sb, xb, dir, core)];
  dir = simplex[0].w.neg();

  let iterations = 0;
  for (; iterations < maxIters; iterations++) {
    if (dir.lengthSq() < 1e-12) {
      // Origin lies on the simplex — shapes are touching/overlapping.
      return overlapResult(simplex, iterations);
    }

    const p = support(sa, xa, sb, xb, dir, core);

    // No progress toward the origin ⇒ converged on the closest feature.
    const progress = p.w.dot(dir.normalize());
    const best = simplex.reduce((m, s) => Math.min(m, s.w.dot(dir.normalize())), Infinity);
    if (progress - best < 1e-10) {
      break;
    }

    simplex.push(p);

    if (simplex.length === 3) {
      const region = closestOnTriangle(simplex);
      if (region.containsOrigin) {
        return overlapResult(simplex, iterations);
      }
      simplex = region.simplex;
      dir = region.closest.neg();
    } else {
      const seg = closestOnSegment(simplex[0].w, simplex[1].w);
      dir = seg.point.neg();
    }
  }

  return resolveClosest(simplex, iterations);
}

/** Reduce a 2-point simplex to its closest feature and report witness points. */
function resolveClosest(simplex: SupportPoint[], iterations: number): DistanceResult {
  if (simplex.length === 1) {
    const s = simplex[0];
    return {
      distance: s.w.length(),
      pointA: s.wA,
      pointB: s.wB,
      overlap: s.w.lengthSq() < 1e-12,
      simplex: simplex.map((x) => x.w),
      iterations,
    };
  }
  const [a, b] = simplex;
  const seg = closestOnSegment(a.w, b.w);
  const pointA = a.wA.mul(seg.u).add(b.wA.mul(seg.v));
  const pointB = a.wB.mul(seg.u).add(b.wB.mul(seg.v));
  const distance = seg.point.length();
  return {
    distance,
    pointA,
    pointB,
    overlap: distance < 1e-9,
    simplex: simplex.map((x) => x.w),
    iterations,
  };
}

function overlapResult(simplex: SupportPoint[], iterations: number): DistanceResult {
  const c = simplex
    .reduce((acc, s) => acc.add(s.wA), Vec2.ZERO)
    .mul(1 / simplex.length);
  return {
    distance: 0,
    pointA: c,
    pointB: c,
    overlap: true,
    simplex: simplex.map((x) => x.w),
    iterations,
  };
}

interface TriangleRegion {
  containsOrigin: boolean;
  closest: Vec2;
  simplex: SupportPoint[];
}

/**
 * Closest feature of triangle (a, b, c) to the origin using Voronoi regions.
 * Returns the reduced simplex (1–3 points) and whether the origin is inside.
 */
function closestOnTriangle(tri: SupportPoint[]): TriangleRegion {
  const [a, b, c] = tri;
  const A = a.w;
  const B = b.w;
  const C = c.w;

  const ab = B.sub(A);
  const ac = C.sub(A);
  const ap = A.neg();

  const d1 = ab.dot(ap);
  const d2 = ac.dot(ap);
  if (d1 <= 0 && d2 <= 0) return { containsOrigin: false, closest: A, simplex: [a] };

  const bp = B.neg();
  const d3 = ab.dot(bp);
  const d4 = ac.dot(bp);
  if (d3 >= 0 && d4 <= d3) return { containsOrigin: false, closest: B, simplex: [b] };

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return { containsOrigin: false, closest: A.add(ab.mul(v)), simplex: [a, b] };
  }

  const cp = C.neg();
  const d5 = ab.dot(cp);
  const d6 = ac.dot(cp);
  if (d6 >= 0 && d5 <= d6) return { containsOrigin: false, closest: C, simplex: [c] };

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return { containsOrigin: false, closest: A.add(ac.mul(w)), simplex: [a, c] };
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return { containsOrigin: false, closest: B.add(C.sub(B).mul(w)), simplex: [b, c] };
  }

  // Origin projects inside the triangle.
  return { containsOrigin: true, closest: Vec2.ZERO, simplex: tri };
}

export interface PenetrationResult {
  /** Penetration depth (positive). */
  depth: number;
  /** Collision normal pointing from A to B. */
  normal: Vec2;
}

interface Edge {
  a: SupportPoint;
  b: SupportPoint;
  normal: Vec2;
  distance: number;
}

/**
 * The Expanding Polytope Algorithm. Given two overlapping convex shapes, it
 * grows the GJK simplex into the contact normal and penetration depth by
 * repeatedly pushing out the polytope edge closest to the origin.
 */
export function epaPenetration(
  sa: Shape,
  xa: Transform,
  sb: Shape,
  xb: Transform,
  maxIters = 32,
): PenetrationResult {
  // Build an initial triangle around the origin.
  const polytope = buildInitialSimplex(sa, xa, sb, xb);

  for (let iter = 0; iter < maxIters; iter++) {
    const edge = closestEdge(polytope);
    const p = support(sa, xa, sb, xb, edge.normal);
    const d = p.w.dot(edge.normal);
    if (d - edge.distance < 1e-6) {
      return { depth: d, normal: edge.normal };
    }
    // Insert the new support point, splitting the closest edge.
    const idx = polytope.indexOf(edge.b);
    polytope.splice(idx === 0 ? polytope.length : idx, 0, p);
  }

  const edge = closestEdge(polytope);
  return { depth: edge.distance, normal: edge.normal };
}

function buildInitialSimplex(
  sa: Shape,
  xa: Transform,
  sb: Shape,
  xb: Transform,
): SupportPoint[] {
  const s0 = support(sa, xa, sb, xb, new Vec2(1, 0));
  const s1 = support(sa, xa, sb, xb, new Vec2(-1, 0));
  let dir = s1.w.sub(s0.w).perp();
  if (dir.lengthSq() < 1e-12) dir = new Vec2(0, 1);
  const s2 = support(sa, xa, sb, xb, dir);
  // Ensure CCW winding so edge normals point outward.
  const area = s1.w.sub(s0.w).cross(s2.w.sub(s0.w));
  return area >= 0 ? [s0, s1, s2] : [s0, s2, s1];
}

function closestEdge(polytope: SupportPoint[]): Edge {
  let best: Edge | null = null;
  for (let i = 0; i < polytope.length; i++) {
    const a = polytope[i];
    const b = polytope[(i + 1) % polytope.length];
    const e = b.w.sub(a.w);
    // Outward normal for CCW polytope, robust against a near-origin edge.
    let n = new Vec2(e.y, -e.x).normalize();
    let dist = n.dot(a.w);
    if (dist < 0) {
      n = n.neg();
      dist = -dist;
    }
    if (best === null || dist < best.distance) {
      best = { a, b, normal: n, distance: dist };
    }
  }
  return best as Edge;
}
