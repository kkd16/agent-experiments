import { Body } from '../body';
import { clamp, EPSILON, Vec2 } from '../math';

/**
 * The result of testing a soft-body particle (a small disc of some radius)
 * against a rigid body's shape.
 *
 * `normal` points *out of* the body toward the particle (world space), `depth`
 * is the positive overlap of the two surfaces, and `point` is the contact point
 * on the body's surface (world space). Returned only when the two overlap.
 */
export interface ParticleHit {
  normal: Vec2;
  depth: number;
  point: Vec2;
}

/**
 * Collide a particle — a disc of radius `radius` centred at world point `p` —
 * against a rigid `body`. This is the soft engine's bridge to the rigid world:
 * a particle is treated as a tiny circle and resolved with the same
 * core+skin-radius convex math the narrowphase uses, so a soft body feels every
 * rigid shape (circle, capsule, rounded polygon) exactly.
 *
 * The test runs in the body's local frame (one cheap transform of the point in,
 * one of the result out) and reuses the closest-feature analysis from
 * circle-vs-convex collision, generalised to the body's optional skin radius.
 */
export function collideParticle(body: Body, p: Vec2, radius: number): ParticleHit | null {
  const lp = body.localPoint(p);
  const shape = body.shape;
  let local: { n: Vec2; depth: number; cp: Vec2 } | null;

  if (shape.kind === 'circle') {
    local = circle(lp, shape.center, shape.radius, radius);
  } else if (shape.kind === 'capsule') {
    local = capsule(lp, shape.p1, shape.p2, shape.radius, radius);
  } else {
    local = polygon(lp, shape.vertices, shape.normals, shape.radius, radius);
  }
  if (!local) return null;

  return {
    normal: body.transform.q.apply(local.n),
    depth: local.depth,
    point: body.worldPoint(local.cp),
  };
}

/** Particle vs a local-space circle (centre `c`, radius `cr`). */
function circle(
  lp: Vec2,
  c: Vec2,
  cr: number,
  radius: number,
): { n: Vec2; depth: number; cp: Vec2 } | null {
  const d = lp.sub(c);
  const len = d.length();
  const R = cr + radius;
  if (len > R) return null;
  const n = len > EPSILON ? d.mul(1 / len) : new Vec2(0, 1);
  return { n, depth: R - len, cp: c.add(n.mul(cr)) };
}

/** Particle vs a local-space capsule (segment `a`→`b` swept by radius `cr`). */
function capsule(
  lp: Vec2,
  a: Vec2,
  b: Vec2,
  cr: number,
  radius: number,
): { n: Vec2; depth: number; cp: Vec2 } | null {
  const ab = b.sub(a);
  const lenSq = ab.lengthSq();
  const t = lenSq > EPSILON ? clamp(lp.sub(a).dot(ab) / lenSq, 0, 1) : 0;
  const closest = a.add(ab.mul(t));
  const d = lp.sub(closest);
  const len = d.length();
  const R = cr + radius;
  if (len > R) return null;
  const n = len > EPSILON ? d.mul(1 / len) : ab.perp().normalize();
  return { n, depth: R - len, cp: closest.add(n.mul(cr)) };
}

/**
 * Particle vs a local-space convex polygon with an optional skin radius `skin`.
 * Mirrors Box2D's polygon-vs-circle: the face of maximum separation localises
 * the contact to an edge or one of its two vertices; an interior centre falls
 * back to pushing straight out along the deepest face normal.
 */
function polygon(
  lp: Vec2,
  verts: readonly Vec2[],
  normals: readonly Vec2[],
  skin: number,
  radius: number,
): { n: Vec2; depth: number; cp: Vec2 } | null {
  const R = skin + radius;
  const n = verts.length;

  let sep = -Infinity;
  let mi = 0;
  for (let i = 0; i < n; i++) {
    const s = normals[i].dot(lp.sub(verts[i]));
    if (s > sep) {
      sep = s;
      mi = i;
    }
  }
  if (sep > R) return null;

  const v1 = verts[mi];
  const v2 = verts[(mi + 1) % n];

  // Centre inside the core polygon: exit along the least-penetrated face.
  if (sep < EPSILON) {
    const face = normals[mi];
    return {
      n: face,
      depth: R - sep,
      cp: lp.sub(face.mul(sep)).add(face.mul(skin)),
    };
  }

  // Outside: closest point is on edge [v1,v2] or one of its endpoints.
  const u1 = lp.sub(v1).dot(v2.sub(v1));
  const u2 = lp.sub(v2).dot(v1.sub(v2));
  let closest: Vec2;
  if (u1 <= 0) closest = v1;
  else if (u2 <= 0) closest = v2;
  else closest = v1.add(v2.sub(v1).mul(u1 / v2.sub(v1).lengthSq()));

  const d = lp.sub(closest);
  const len = d.length();
  if (len > R) return null;
  const face = len > EPSILON ? d.mul(1 / len) : normals[mi];
  return { n: face, depth: R - len, cp: closest.add(face.mul(skin)) };
}
