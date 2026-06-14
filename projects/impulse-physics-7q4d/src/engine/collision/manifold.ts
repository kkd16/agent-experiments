import { clamp, Transform, Vec2 } from '../math';
import { Circle, Polygon, convexProxy, type ConvexProxy, type Shape } from '../shapes';
import { gjkDistance } from './gjk';

/** One point of a contact manifold (world space). */
export interface ManifoldPoint {
  point: Vec2;
  /** Positive penetration depth along the manifold normal. */
  penetration: number;
  /**
   * Feature id identifying which edge/vertex pair produced this point. The
   * solver matches ids across frames to carry accumulated impulses forward
   * (warm starting), which is what makes large stacks settle quickly.
   */
  id: number;
}

/** A contact manifold: a shared normal plus 1–2 contact points. */
export interface Manifold {
  /** Unit normal pointing from shape A toward shape B. */
  normal: Vec2;
  points: ManifoldPoint[];
}

const EMPTY: Manifold = { normal: Vec2.ZERO, points: [] };

/** Below this the GJK cores are treated as overlapping (deep contact path). */
const CORE_TOUCH = 1e-4;
/** Face must be at least this aligned with the contact normal to clip (else point). */
const FACE_ALIGN = 0.95;

/** Dispatch collision between two shapes; the normal always points A → B. */
export function collide(sa: Shape, xa: Transform, sb: Shape, xb: Transform): Manifold {
  if (sa.kind === 'circle' && sb.kind === 'circle') {
    return collideCircles(sa, xa, sb, xb);
  }
  // Circle paired with anything else → the analytic closest-feature routines.
  if (sa.kind === 'circle' || sb.kind === 'circle') {
    const circleIsA = sa.kind === 'circle';
    const circle = (circleIsA ? sa : sb) as Circle;
    const xc = circleIsA ? xa : xb;
    const other = circleIsA ? sb : sa;
    const xo = circleIsA ? xb : xa;
    if (other.kind === 'polygon') {
      return collidePolygonCircle(other, xo, circle, xc, circleIsA);
    }
    if (other.kind === 'capsule') {
      return collideCapsuleCircle(other, xo, circle, xc, circleIsA);
    }
    return EMPTY;
  }
  // Capsule/polygon pairs (no circles) → the unified radius-aware clip builder.
  return collideConvex(sa, xa, sb, xb);
}

function collideCircles(a: Circle, xa: Transform, b: Circle, xb: Transform): Manifold {
  const ca = xa.apply(a.center);
  const cb = xb.apply(b.center);
  const d = cb.sub(ca);
  const dist = d.length();
  const r = a.radius + b.radius;
  if (dist > r) return EMPTY;
  const normal = dist > 1e-9 ? d.mul(1 / dist) : new Vec2(0, 1);
  const pa = ca.add(normal.mul(a.radius));
  const pb = cb.sub(normal.mul(b.radius));
  return {
    normal,
    points: [{ point: pa.add(pb).mul(0.5), penetration: r - dist, id: 0 }],
  };
}

/**
 * Capsule vs circle. The capsule's core is a segment, so the contact reduces to
 * circle–circle between the circle and the closest point on that segment.
 * `flip` is set when the caller's A was the circle (normal kept A → B).
 */
function collideCapsuleCircle(
  cap: { p1: Vec2; p2: Vec2; radius: number },
  xcap: Transform,
  circle: Circle,
  xc: Transform,
  flip: boolean,
): Manifold {
  const center = xc.apply(circle.center);
  const a = xcap.apply(cap.p1);
  const b = xcap.apply(cap.p2);
  const ab = b.sub(a);
  const t = ab.lengthSq() > 1e-12 ? clamp(center.sub(a).dot(ab) / ab.lengthSq(), 0, 1) : 0;
  const closest = a.add(ab.mul(t));
  const d = center.sub(closest);
  const dist = d.length();
  const r = cap.radius + circle.radius;
  if (dist > r) return EMPTY;
  // Normal points capsule → circle.
  let normal = dist > 1e-9 ? d.mul(1 / dist) : new Vec2(ab.y, -ab.x).normalize();
  if (normal.lengthSq() < 0.5) normal = new Vec2(0, 1);
  const onCap = closest.add(normal.mul(cap.radius));
  const onCircle = center.sub(normal.mul(circle.radius));
  const point = onCap.add(onCircle).mul(0.5);
  return {
    normal: flip ? normal.neg() : normal,
    points: [{ point, penetration: r - dist, id: 0 }],
  };
}

/**
 * Polygon vs circle. `flip` is set when the caller's A was the circle, so the
 * returned normal is negated to keep the A → B convention. A polygon skin
 * radius is folded into the effective contact radius.
 */
function collidePolygonCircle(
  poly: Polygon,
  xp: Transform,
  circle: Circle,
  xc: Transform,
  flip: boolean,
): Manifold {
  // Circle center in polygon-local space.
  const center = xp.applyInv(xc.apply(circle.center));
  const r = circle.radius + poly.radius;

  // Find the face with the greatest separation from the circle center.
  let bestSep = -Infinity;
  let bestIdx = 0;
  const n = poly.vertices.length;
  for (let i = 0; i < n; i++) {
    const s = poly.normals[i].dot(center.sub(poly.vertices[i]));
    if (s > r) return EMPTY; // circle outside this face by more than the radius
    if (s > bestSep) {
      bestSep = s;
      bestIdx = i;
    }
  }

  const v1 = poly.vertices[bestIdx];
  const v2 = poly.vertices[(bestIdx + 1) % n];

  let localNormal: Vec2;
  let localPoint: Vec2;
  if (bestSep < 1e-9) {
    // Center is inside the polygon.
    localNormal = poly.normals[bestIdx];
    localPoint = center.sub(localNormal.mul(r));
  } else {
    const u1 = center.sub(v1).dot(v2.sub(v1));
    const u2 = center.sub(v2).dot(v1.sub(v2));
    if (u1 <= 0) {
      if (center.distanceTo(v1) > r) return EMPTY;
      localNormal = center.sub(v1).normalize();
      localPoint = v1;
    } else if (u2 <= 0) {
      if (center.distanceTo(v2) > r) return EMPTY;
      localNormal = center.sub(v2).normalize();
      localPoint = v2;
    } else {
      localNormal = poly.normals[bestIdx];
      if (center.sub(v1).dot(localNormal) > r) return EMPTY;
      localPoint = center.sub(localNormal.mul(r));
    }
  }

  const penetration = r - center.sub(localPoint).length();
  // Normal points polygon → circle in world space.
  let worldNormal = xp.q.apply(localNormal);
  // Place the contact on the polygon skin surface.
  const worldPoint = xp.apply(localPoint).add(worldNormal.mul(poly.radius));
  if (flip) worldNormal = worldNormal.neg();
  return {
    normal: worldNormal,
    points: [{ point: worldPoint, penetration: Math.max(penetration, 0), id: 0 }],
  };
}

interface ClipVertex {
  v: Vec2;
  id: number;
}

/** Sutherland–Hodgman clip of a 2-vertex segment against a half-plane. */
function clipSegment(
  input: ClipVertex[],
  normal: Vec2,
  offset: number,
  clipEdge: number,
): ClipVertex[] {
  const out: ClipVertex[] = [];
  const d0 = normal.dot(input[0].v) - offset;
  const d1 = normal.dot(input[1].v) - offset;
  if (d0 <= 0) out.push(input[0]);
  if (d1 <= 0) out.push(input[1]);
  if (d0 * d1 < 0) {
    const t = d0 / (d0 - d1);
    out.push({
      v: input[0].v.add(input[1].v.sub(input[0].v).mul(t)),
      // Tag the new vertex with the clipping edge for warm-start id stability.
      id: 0x100 | clipEdge,
    });
  }
  return out;
}

/** Greatest separation of B's core from any face of A's core. */
function maxSeparation(a: ConvexProxy, b: ConvexProxy): { separation: number; edge: number } {
  let bestSep = -Infinity;
  let bestEdge = 0;
  for (let i = 0; i < a.verts.length; i++) {
    const nrm = a.normals[i];
    if (!nrm) continue;
    let minDot = Infinity;
    for (const v of b.verts) {
      const d = nrm.dot(v);
      if (d < minDot) minDot = d;
    }
    const sep = minDot - nrm.dot(a.verts[i]);
    if (sep > bestSep) {
      bestSep = sep;
      bestEdge = i;
    }
  }
  return { separation: bestSep, edge: bestEdge };
}

/** Face of `p` whose outward normal is most aligned with `dir`. */
function bestFace(p: ConvexProxy, dir: Vec2): { index: number; dot: number } {
  let bestDot = -Infinity;
  let index = -1;
  for (let i = 0; i < p.normals.length; i++) {
    const d = p.normals[i].dot(dir);
    if (d > bestDot) {
      bestDot = d;
      index = i;
    }
  }
  return { index, dot: bestDot };
}

/**
 * The unified radius-aware narrowphase for any pair of convex cores (capsules
 * and polygons, rounded or not). GJK gives the exact contact normal for shallow
 * separations — including vertex/cap contacts that pure SAT would miss — while
 * SAT supplies a clean face normal for deep overlap. Reference/incident face
 * clipping then produces stable 1–2 point manifolds offset by the skin radii.
 */
function collideConvex(sa: Shape, xa: Transform, sb: Shape, xb: Transform): Manifold {
  const pa = convexProxy(sa, xa);
  const pb = convexProxy(sb, xb);
  const total = pa.radius + pb.radius;

  const dist = gjkDistance(sa, xa, sb, xb, 32, /* core */ true);
  let normal: Vec2; // A → B
  if (dist.distance > total) return EMPTY;

  if (dist.distance > CORE_TOUCH) {
    // Shallow: the cores are separated — the exact closest direction is correct
    // even when the closest features are two vertices (capsule cap-to-cap).
    normal = dist.pointB.sub(dist.pointA).normalize();
    if (normal.lengthSq() < 0.5) normal = new Vec2(0, 1);
  } else {
    // Deep overlap: choose the SAT axis of least penetration.
    const sepA = maxSeparation(pa, pb);
    const sepB = maxSeparation(pb, pa);
    if (sepA.separation >= sepB.separation) {
      normal = pa.normals[sepA.edge];
    } else {
      normal = pb.normals[sepB.edge].neg();
    }
  }

  return buildManifold(pa, pb, normal, total, dist);
}

/**
 * Build a manifold from two convex cores and a known A → B contact normal. A
 * face well aligned with the normal becomes the reference face and the contact
 * is clipped (1–2 points); otherwise the contact is a single point along the
 * closest-feature direction.
 */
function buildManifold(
  pa: ConvexProxy,
  pb: ConvexProxy,
  normal: Vec2,
  total: number,
  dist: { distance: number; pointA: Vec2; pointB: Vec2},
): Manifold {
  const alignA = bestFace(pa, normal);
  const alignB = bestFace(pb, normal.neg());
  const bestAlign = Math.max(alignA.dot, alignB.dot);

  if (bestAlign < FACE_ALIGN) {
    // Vertex / curved contact: a single point along the closest direction.
    if (dist.distance <= CORE_TOUCH) return EMPTY;
    const onA = dist.pointA.add(normal.mul(pa.radius));
    const onB = dist.pointB.sub(normal.mul(pb.radius));
    return {
      normal,
      points: [{ point: onA.add(onB).mul(0.5), penetration: total - dist.distance, id: 0 }],
    };
  }

  // Face contact: reference is the more parallel face; clip the other's edge.
  const refIsA = alignA.dot >= alignB.dot;
  const ref = refIsA ? pa : pb;
  const inc = refIsA ? pb : pa;
  const refEdge = refIsA ? alignA.index : alignB.index;
  const refNormal = ref.normals[refEdge]; // points away from the reference shape
  const rv1 = ref.verts[refEdge];
  const rv2 = ref.verts[(refEdge + 1) % ref.verts.length];

  // Incident edge: the incident face most anti-parallel to the reference normal.
  let incEdge = 0;
  let minDot = Infinity;
  for (let i = 0; i < inc.normals.length; i++) {
    const d = refNormal.dot(inc.normals[i]);
    if (d < minDot) {
      minDot = d;
      incEdge = i;
    }
  }
  const ci = inc.verts.length;
  const iv1 = inc.verts[incEdge];
  const iv2 = inc.verts[(incEdge + 1) % ci];
  let incident: ClipVertex[] = [
    { v: iv1, id: incEdge },
    { v: iv2, id: (incEdge + 1) % ci },
  ];

  const tangent = rv2.sub(rv1).normalize();
  incident = clipSegment(incident, tangent.neg(), -tangent.dot(rv1), refEdge);
  if (incident.length < 2) return EMPTY;
  incident = clipSegment(incident, tangent, tangent.dot(rv2), (refEdge + 1) % ref.verts.length);
  if (incident.length < 2) return EMPTY;

  const rIncident = inc.radius;
  const points: ManifoldPoint[] = [];
  for (const cv of incident) {
    const sep = refNormal.dot(cv.v.sub(rv1));
    if (sep > total) continue;
    const penetration = total - sep;
    // Place the contact midway between the two skin surfaces.
    const point = cv.v.sub(refNormal.mul(rIncident - penetration * 0.5));
    points.push({
      point,
      penetration,
      id: (refEdge << 8) | (cv.id & 0xff) | (refIsA ? 0 : 0x10000),
    });
  }
  if (points.length === 0) return EMPTY;

  return { normal: refIsA ? refNormal : refNormal.neg(), points };
}
