import { Transform, Vec2 } from '../math';
import { Circle, Polygon, type Shape } from '../shapes';

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

/** Dispatch collision between two shapes; the normal always points A → B. */
export function collide(sa: Shape, xa: Transform, sb: Shape, xb: Transform): Manifold {
  if (sa.kind === 'circle' && sb.kind === 'circle') {
    return collideCircles(sa, xa, sb, xb);
  }
  if (sa.kind === 'polygon' && sb.kind === 'circle') {
    return collidePolygonCircle(sa, xa, sb, xb, false);
  }
  if (sa.kind === 'circle' && sb.kind === 'polygon') {
    return collidePolygonCircle(sb, xb, sa, xa, true);
  }
  return collidePolygons(sa as Polygon, xa, sb as Polygon, xb);
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
 * Polygon vs circle. `flip` is set when the caller's A was the circle, so the
 * returned normal is negated to keep the A → B convention.
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
  const r = circle.radius;

  // Find the face with the greatest separation from the circle center.
  let bestSep = -Infinity;
  let bestIdx = 0;
  const n = poly.vertices.length;
  for (let i = 0; i < n; i++) {
    const s = poly.normals[i].dot(center.sub(poly.vertices[i]));
    if (s > r) return EMPTY; // circle outside this face by more than its radius
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
  const worldPoint = xp.apply(localPoint);
  if (flip) worldNormal = worldNormal.neg();
  return {
    normal: worldNormal,
    points: [{ point: worldPoint, penetration: Math.max(penetration, 0), id: 0 }],
  };
}

interface WorldFace {
  v1: Vec2;
  v2: Vec2;
  normal: Vec2;
}

function worldVertices(poly: Polygon, xf: Transform): Vec2[] {
  return poly.vertices.map((v) => xf.apply(v));
}

function worldNormals(poly: Polygon, xf: Transform): Vec2[] {
  return poly.normals.map((nrm) => xf.q.apply(nrm));
}

/** Greatest separation of `b` from any face of `a`; negative ⇒ overlapping. */
function maxSeparation(
  aVerts: Vec2[],
  aNorms: Vec2[],
  bVerts: Vec2[],
): { separation: number; edge: number } {
  let bestSep = -Infinity;
  let bestEdge = 0;
  for (let i = 0; i < aVerts.length; i++) {
    const nrm = aNorms[i];
    // Support point of B most opposed to this face normal.
    let minDot = Infinity;
    let sv = bVerts[0];
    for (const v of bVerts) {
      const d = nrm.dot(v);
      if (d < minDot) {
        minDot = d;
        sv = v;
      }
    }
    const sep = nrm.dot(sv.sub(aVerts[i]));
    if (sep > bestSep) {
      bestSep = sep;
      bestEdge = i;
    }
  }
  return { separation: bestSep, edge: bestEdge };
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

/** Polygon vs polygon via SAT plus reference/incident-face clipping. */
function collidePolygons(a: Polygon, xa: Transform, b: Polygon, xb: Transform): Manifold {
  const aVerts = worldVertices(a, xa);
  const aNorms = worldNormals(a, xa);
  const bVerts = worldVertices(b, xb);
  const bNorms = worldNormals(b, xb);

  const sepA = maxSeparation(aVerts, aNorms, bVerts);
  if (sepA.separation > 0) return EMPTY;
  const sepB = maxSeparation(bVerts, bNorms, aVerts);
  if (sepB.separation > 0) return EMPTY;

  // Choose the reference polygon, with a small bias toward A for coherence.
  let refVerts: Vec2[];
  let refNorms: Vec2[];
  let incVerts: Vec2[];
  let incNorms: Vec2[];
  let refEdge: number;
  let flip: boolean;
  if (sepB.separation > sepA.separation + 0.1 * 1e-3) {
    refVerts = bVerts;
    refNorms = bNorms;
    incVerts = aVerts;
    incNorms = aNorms;
    refEdge = sepB.edge;
    flip = true;
  } else {
    refVerts = aVerts;
    refNorms = aNorms;
    incVerts = bVerts;
    incNorms = bNorms;
    refEdge = sepA.edge;
    flip = false;
  }

  const refNormal = refNorms[refEdge];
  const rv1 = refVerts[refEdge];
  const rv2 = refVerts[(refEdge + 1) % refVerts.length];

  // Incident edge: the face of the incident polygon most anti-parallel to refN.
  let incEdge = 0;
  let minDot = Infinity;
  for (let i = 0; i < incNorms.length; i++) {
    const d = refNormal.dot(incNorms[i]);
    if (d < minDot) {
      minDot = d;
      incEdge = i;
    }
  }
  const iv1 = incVerts[incEdge];
  const iv2 = incVerts[(incEdge + 1) % incVerts.length];

  let incident: ClipVertex[] = [
    { v: iv1, id: incEdge },
    { v: iv2, id: (incEdge + 1) % incVerts.length },
  ];

  // Clip the incident edge against the two side planes of the reference face.
  const tangent = rv2.sub(rv1).normalize();
  incident = clipSegment(incident, tangent.neg(), -tangent.dot(rv1), refEdge);
  if (incident.length < 2) return EMPTY;
  incident = clipSegment(incident, tangent, tangent.dot(rv2), (refEdge + 1) % refVerts.length);
  if (incident.length < 2) return EMPTY;

  const face: WorldFace = { v1: rv1, v2: rv2, normal: refNormal };
  const points: ManifoldPoint[] = [];
  for (const cv of incident) {
    const sep = face.normal.dot(cv.v.sub(face.v1));
    if (sep <= 0) {
      points.push({
        point: cv.v,
        penetration: -sep,
        id: (refEdge << 8) | (cv.id & 0xff) | (flip ? 0x10000 : 0),
      });
    }
  }
  if (points.length === 0) return EMPTY;

  // Normal must point A → B; reference normal points away from the reference.
  return { normal: flip ? refNormal.neg() : refNormal, points };
}
