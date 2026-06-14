import { AABB } from './aabb';
import { EPSILON, Transform, Vec2 } from './math';

/** Mass, centroid and rotational inertia of a shape at a given density. */
export interface MassData {
  /** Total mass. */
  mass: number;
  /** Local-space center of mass. */
  center: Vec2;
  /** Rotational inertia about the center of mass. */
  inertia: number;
}

/** A circle centered at `center` in body-local coordinates. */
export class Circle {
  readonly kind = 'circle';
  readonly center: Vec2;
  readonly radius: number;

  constructor(radius: number, center: Vec2 = Vec2.ZERO) {
    this.radius = radius;
    this.center = center;
  }
}

/**
 * A capsule (stadium): the segment from `p1` to `p2` swept by `radius`. Its
 * convex *core* is the segment; the radius is a skin, exactly like the
 * core+radius model used for rounded polygons. Capsules roll like wheels on
 * their caps yet rest flat on their side, which makes them the natural shape for
 * limbs, projectiles and wheels.
 */
export class Capsule {
  readonly kind = 'capsule';
  readonly p1: Vec2;
  readonly p2: Vec2;
  readonly radius: number;

  constructor(p1: Vec2, p2: Vec2, radius: number) {
    this.p1 = p1;
    this.p2 = p2;
    this.radius = radius;
  }

  /** A capsule of total length `length` along the local x-axis (default) or y. */
  static of(length: number, radius: number, vertical = false): Capsule {
    const h = Math.max(length, 0) * 0.5;
    return vertical
      ? new Capsule(new Vec2(0, -h), new Vec2(0, h), radius)
      : new Capsule(new Vec2(-h, 0), new Vec2(h, 0), radius);
  }

  /** Midpoint of the core segment (the centroid for uniform density). */
  center(): Vec2 {
    return this.p1.add(this.p2).mul(0.5);
  }

  /** Length of the straight (core) section. */
  length(): number {
    return this.p1.distanceTo(this.p2);
  }
}

/**
 * A convex polygon stored as CCW vertices with precomputed outward edge
 * normals. Construct via the factories so winding and convexity are guaranteed.
 */
export class Polygon {
  readonly kind = 'polygon';
  readonly vertices: readonly Vec2[];
  readonly normals: readonly Vec2[];
  readonly centroid: Vec2;
  /** Optional skin radius — a positive value rounds every corner and edge. */
  readonly radius: number;

  private constructor(
    vertices: readonly Vec2[],
    normals: readonly Vec2[],
    centroid: Vec2,
    radius: number,
  ) {
    this.vertices = vertices;
    this.normals = normals;
    this.centroid = centroid;
    this.radius = radius;
  }

  /** Axis-aligned box of half-width `hx` and half-height `hy`. */
  static box(hx: number, hy: number): Polygon {
    return Polygon.fromVertices([
      new Vec2(-hx, -hy),
      new Vec2(hx, -hy),
      new Vec2(hx, hy),
      new Vec2(-hx, hy),
    ]);
  }

  /** A rounded box: the same hull as {@link box} carrying a skin `radius`. */
  static rounded(hx: number, hy: number, radius: number): Polygon {
    return Polygon.fromVertices(
      [
        new Vec2(-hx, -hy),
        new Vec2(hx, -hy),
        new Vec2(hx, hy),
        new Vec2(-hx, hy),
      ],
      radius,
    );
  }

  /** A regular `n`-gon inscribed in a circle of the given radius. */
  static regular(n: number, radius: number, phase = 0, skin = 0): Polygon {
    const verts: Vec2[] = [];
    for (let i = 0; i < n; i++) {
      const a = phase + (i / n) * Math.PI * 2;
      verts.push(new Vec2(Math.cos(a) * radius, Math.sin(a) * radius));
    }
    return Polygon.fromVertices(verts, skin);
  }

  /**
   * Build a convex polygon from an arbitrary point cloud. The points are
   * reduced to their convex hull (Andrew's monotone chain) wound CCW, then
   * outward normals are computed per edge. An optional `radius` rounds the
   * hull into a capsule-like skin.
   */
  static fromVertices(points: readonly Vec2[], radius = 0): Polygon {
    const hull = convexHull(points);
    if (hull.length < 3) {
      throw new Error('Polygon needs at least 3 non-collinear vertices');
    }
    const normals: Vec2[] = [];
    for (let i = 0; i < hull.length; i++) {
      const edge = hull[(i + 1) % hull.length].sub(hull[i]);
      // Right-hand perpendicular of a CCW edge points outward.
      normals.push(new Vec2(edge.y, -edge.x).normalize());
    }
    return new Polygon(hull, normals, polygonCentroid(hull), radius);
  }
}

export type Shape = Circle | Polygon | Capsule;

/** Skin radius of any shape under the unified core+radius collision model. */
export function shapeRadius(shape: Shape): number {
  return shape.radius;
}

/** Andrew's monotone-chain convex hull, returned in CCW order. */
export function convexHull(points: readonly Vec2[]): Vec2[] {
  const pts = [...points].sort((p, q) => (p.x === q.x ? p.y - q.y : p.x - q.x));
  // Deduplicate to avoid degenerate edges.
  const uniq: Vec2[] = [];
  for (const p of pts) {
    if (uniq.length === 0 || !uniq[uniq.length - 1].equals(p, 1e-7)) uniq.push(p);
  }
  if (uniq.length < 3) return uniq;

  const cross = (o: Vec2, a: Vec2, b: Vec2): number =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const lower: Vec2[] = [];
  for (const p of uniq) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: Vec2[] = [];
  for (let i = uniq.length - 1; i >= 0; i--) {
    const p = uniq[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** Area-weighted centroid of a simple polygon. */
export function polygonCentroid(verts: readonly Vec2[]): Vec2 {
  let cx = 0;
  let cy = 0;
  let area = 0;
  const ref = verts[0];
  for (let i = 1; i < verts.length - 1; i++) {
    const e1 = verts[i].sub(ref);
    const e2 = verts[i + 1].sub(ref);
    const a = e1.cross(e2) * 0.5;
    area += a;
    // Centroid of a triangle is the average of its vertices.
    cx += a * (e1.x + e2.x) / 3;
    cy += a * (e1.y + e2.y) / 3;
  }
  if (Math.abs(area) < 1e-12) return ref;
  return new Vec2(ref.x + cx / area, ref.y + cy / area);
}

/** Compute the mass, centroid and inertia of a shape at `density`. */
export function computeMass(shape: Shape, density: number): MassData {
  if (shape.kind === 'circle') {
    const mass = density * Math.PI * shape.radius * shape.radius;
    // I about centroid for a disc, plus parallel-axis shift to the body origin
    // is unnecessary here because `center` is reported separately.
    const inertia = mass * 0.5 * shape.radius * shape.radius;
    return { mass, center: shape.center, inertia };
  }

  if (shape.kind === 'capsule') {
    // A capsule = a rectangle (the straight 2r×L core) plus a full disc (the two
    // half-cap ends combined). Closed-form mass properties, with the two caps
    // shifted to ±L/2 by the parallel-axis theorem. As L→0 this collapses to the
    // solid-disc formula (verified in the suite).
    const r = shape.radius;
    const rr = r * r;
    const length = shape.length();
    const ll = length * length;
    const circleMass = density * Math.PI * rr;
    const boxMass = density * (2 * r * length);
    const mass = circleMass + boxMass;
    const h = 0.5 * length;
    const lc = (4 * r) / (3 * Math.PI); // centroid of a semicircle from its flat edge
    // Inertia about the capsule centre (midpoint of the segment).
    const circleInertia = circleMass * (0.5 * rr + h * h + 2 * h * lc);
    const boxInertia = (boxMass * (4 * rr + ll)) / 12;
    return { mass, center: shape.center(), inertia: circleInertia + boxInertia };
  }

  // Polygon: integrate area, first moment and second moment over a fan of
  // triangles anchored at the first vertex, then apply the parallel-axis
  // theorem to report inertia about the centroid.
  const verts = shape.vertices;
  const ref = verts[0];
  const inv3 = 1 / 3;
  let area = 0;
  let cx = 0;
  let cy = 0;
  let momentAboutRef = 0;
  for (let i = 1; i < verts.length - 1; i++) {
    const e1 = verts[i].sub(ref);
    const e2 = verts[i + 1].sub(ref);
    const d = e1.cross(e2);
    const triArea = 0.5 * d;
    area += triArea;
    cx += triArea * inv3 * (e1.x + e2.x);
    cy += triArea * inv3 * (e1.y + e2.y);
    // Second moment of a triangle about `ref` (Box2D's closed form).
    const intx2 = e1.x * e1.x + e2.x * e1.x + e2.x * e2.x;
    const inty2 = e1.y * e1.y + e2.y * e1.y + e2.y * e2.y;
    momentAboutRef += 0.25 * inv3 * d * (intx2 + inty2);
  }
  const mass = density * area;
  const centroidFromRef = new Vec2(cx / area, cy / area);
  const inertia = density * momentAboutRef - mass * centroidFromRef.lengthSq();
  return { mass, center: ref.add(centroidFromRef), inertia };
}

/** World-space AABB of a shape under transform `xf`. */
export function computeAABB(shape: Shape, xf: Transform): AABB {
  if (shape.kind === 'circle') {
    const c = xf.apply(shape.center);
    const r = new Vec2(shape.radius, shape.radius);
    return new AABB(c.sub(r), c.add(r));
  }
  if (shape.kind === 'capsule') {
    const a = xf.apply(shape.p1);
    const b = xf.apply(shape.p2);
    const r = new Vec2(shape.radius, shape.radius);
    return new AABB(a.min(b).sub(r), a.max(b).add(r));
  }
  const world = shape.vertices.map((v) => xf.apply(v));
  const aabb = AABB.fromPoints(world);
  if (shape.radius <= 0) return aabb;
  const r = new Vec2(shape.radius, shape.radius);
  return new AABB(aabb.lower.sub(r), aabb.upper.add(r));
}

/**
 * GJK support: the farthest point of the shape (in world space) along `dir`.
 * With `core` set the skin radius is ignored, so the support traces the shape's
 * convex *core* (segment, hull or point) — which is what the radius-aware
 * narrowphase and the time-of-impact solver measure between.
 */
export function shapeSupport(shape: Shape, xf: Transform, dir: Vec2, core = false): Vec2 {
  if (shape.kind === 'circle') {
    const c = xf.apply(shape.center);
    return core ? c : c.add(dir.normalize().mul(shape.radius));
  }
  if (shape.kind === 'capsule') {
    const a = xf.apply(shape.p1);
    const b = xf.apply(shape.p2);
    const pt = dir.dot(a) >= dir.dot(b) ? a : b;
    return core ? pt : pt.add(dir.normalize().mul(shape.radius));
  }
  // Transform the direction into local space, find the extreme vertex.
  const localDir = xf.q.applyT(dir);
  let best = shape.vertices[0];
  let bestDot = best.dot(localDir);
  for (let i = 1; i < shape.vertices.length; i++) {
    const d = shape.vertices[i].dot(localDir);
    if (d > bestDot) {
      bestDot = d;
      best = shape.vertices[i];
    }
  }
  const world = xf.apply(best);
  return core || shape.radius <= 0 ? world : world.add(dir.normalize().mul(shape.radius));
}

/** Bounding radius of a shape from its local origin (used for broadphase margins). */
export function boundingRadius(shape: Shape): number {
  if (shape.kind === 'circle') return shape.center.length() + shape.radius;
  if (shape.kind === 'capsule') {
    return Math.max(shape.p1.length(), shape.p2.length()) + shape.radius;
  }
  let r = 0;
  for (const v of shape.vertices) r = Math.max(r, v.length());
  return r + shape.radius;
}

/**
 * The convex core of a shape as a world-space vertex/normal set used by the
 * radius-aware manifold builder. Circles collapse to a single vertex (no faces);
 * capsules become a 2-vertex segment with its two side normals; polygons keep
 * their hull. The skin radius is returned separately.
 */
export interface ConvexProxy {
  verts: Vec2[];
  normals: Vec2[];
  radius: number;
}

export function convexProxy(shape: Shape, xf: Transform): ConvexProxy {
  if (shape.kind === 'circle') {
    return { verts: [xf.apply(shape.center)], normals: [], radius: shape.radius };
  }
  if (shape.kind === 'capsule') {
    const a = xf.apply(shape.p1);
    const b = xf.apply(shape.p2);
    const edge = b.sub(a);
    const n = edge.lengthSq() > EPSILON ? new Vec2(edge.y, -edge.x).normalize() : new Vec2(0, -1);
    return { verts: [a, b], normals: [n, n.neg()], radius: shape.radius };
  }
  const verts = shape.vertices.map((v) => xf.apply(v));
  const normals = shape.normals.map((n) => xf.q.apply(n));
  return { verts, normals, radius: shape.radius };
}
