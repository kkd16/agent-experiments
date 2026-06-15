import { Body, BodyType } from './body';
import { Transform, Vec2 } from './math';
import { type Shape } from './shapes';

/**
 * A body of water (or any fluid) bounded above by a horizontal surface. Each
 * step the world hands every submerged body to {@link apply}, which computes the
 * exact submerged area + centroid and pushes back with Archimedes buoyancy and
 * an area-scaled drag.
 *
 * The model is deliberately first-principles: buoyancy is ρ_fluid · A_submerged ·
 * (−g) applied at the centroid of the *submerged* region — not the body centre —
 * so a half-sunk box feels a restoring torque and floats upright on its own,
 * exactly as a real hull does. Nothing here is faked with ad-hoc springs.
 */
export interface BuoyancyDef {
  /** World-space height of the still-water surface. */
  surface: number;
  /** Horizontal extent of the pool (a body is only affected over this span). */
  minX?: number;
  maxX?: number;
  /** Fluid mass density. A body floats when its density is below this. */
  density?: number;
  /** Linear drag coefficient (area-scaled viscous damping). */
  linearDrag?: number;
  /** Angular drag coefficient (area-scaled rotational damping). */
  angularDrag?: number;
  /** Bulk fluid velocity (a current that pushes floaters along). */
  current?: Vec2;
  /** Visual-only depth used by the renderer to fill the pool downward. */
  depth?: number;
}

export class BuoyancyZone {
  surface: number;
  minX: number;
  maxX: number;
  density: number;
  linearDrag: number;
  angularDrag: number;
  current: Vec2;
  depth: number;

  constructor(def: BuoyancyDef) {
    this.surface = def.surface;
    this.minX = def.minX ?? -Infinity;
    this.maxX = def.maxX ?? Infinity;
    this.density = def.density ?? 1;
    this.linearDrag = def.linearDrag ?? 1.4;
    this.angularDrag = def.angularDrag ?? 0.9;
    this.current = def.current ?? Vec2.ZERO;
    this.depth = def.depth ?? 1000;
  }

  /**
   * Submerged area and its centroid for a body under this surface. The shape is
   * approximated by a world-space polygon (circle → n-gon, capsule → stadium,
   * polygon → hull), clipped against the surface half-plane (Sutherland–Hodgman),
   * then integrated in closed form. Returns zero area when the body is clear of
   * the water or outside the pool span.
   */
  submerged(body: Body): { area: number; centroid: Vec2 } {
    if (body.worldCenter.x < this.minX || body.worldCenter.x > this.maxX) {
      return { area: 0, centroid: Vec2.ZERO };
    }
    const outline = worldOutline(body.shape, body.transform);
    const below = clipBelowSurface(outline, this.surface);
    if (below.length < 3) return { area: 0, centroid: Vec2.ZERO };
    return polygonAreaCentroid(below);
  }

  /**
   * Apply buoyancy + drag to a body for this step. Forces are added straight to
   * the accumulators (not via {@link Body.applyForce}) so a settled floater is
   * still free to fall asleep instead of being woken every frame.
   */
  apply(body: Body, gravity: Vec2): void {
    if (body.type !== BodyType.Dynamic || !body.awake) return;
    const { area, centroid } = this.submerged(body);
    if (area <= 0) return;

    // Archimedes: weight of the displaced fluid, opposing gravity, at the
    // submerged centroid (the centre of buoyancy).
    const buoyancy = gravity.mul(-this.density * area);
    addForceAt(body, buoyancy, centroid);

    // Viscous drag, scaled by submerged area, resisting motion through the fluid.
    const vRel = body.velocityAt(centroid).sub(this.current);
    const drag = vRel.mul(-this.linearDrag * this.density * area);
    addForceAt(body, drag, centroid);
    body.torque += -this.angularDrag * this.density * area * body.angularVelocity;
  }
}

/** Add a world-space force at a world point straight to a body's accumulators. */
function addForceAt(body: Body, force: Vec2, point: Vec2): void {
  body.force = body.force.add(force);
  body.torque += point.sub(body.worldCenter).cross(force);
}

const CIRCLE_SEGMENTS = 24;
const CAP_SEGMENTS = 8;

/** A closed world-space polygon approximating a shape's boundary (CCW). */
function worldOutline(shape: Shape, xf: Transform): Vec2[] {
  if (shape.kind === 'circle') {
    const c = xf.apply(shape.center);
    const pts: Vec2[] = [];
    for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
      const a = (i / CIRCLE_SEGMENTS) * Math.PI * 2;
      pts.push(new Vec2(c.x + Math.cos(a) * shape.radius, c.y + Math.sin(a) * shape.radius));
    }
    return pts;
  }
  if (shape.kind === 'capsule') {
    const p1 = xf.apply(shape.p1);
    const p2 = xf.apply(shape.p2);
    const r = shape.radius;
    const theta = Math.atan2(p2.y - p1.y, p2.x - p1.x);
    const pts: Vec2[] = [];
    // Outer semicircle around p2, then around p1 — a closed stadium.
    for (let i = 0; i <= CAP_SEGMENTS; i++) {
      const a = theta - Math.PI / 2 + (i / CAP_SEGMENTS) * Math.PI;
      pts.push(new Vec2(p2.x + Math.cos(a) * r, p2.y + Math.sin(a) * r));
    }
    for (let i = 0; i <= CAP_SEGMENTS; i++) {
      const a = theta + Math.PI / 2 + (i / CAP_SEGMENTS) * Math.PI;
      pts.push(new Vec2(p1.x + Math.cos(a) * r, p1.y + Math.sin(a) * r));
    }
    return pts;
  }
  // Polygon: its world hull (skin radius is ignored — a small under-estimate).
  return shape.vertices.map((v) => xf.apply(v));
}

/** Sutherland–Hodgman clip of a polygon against the half-plane y ≤ surface. */
function clipBelowSurface(pts: Vec2[], surface: number): Vec2[] {
  const out: Vec2[] = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const A = pts[i];
    const B = pts[(i + 1) % n];
    const aIn = A.y <= surface;
    const bIn = B.y <= surface;
    if (aIn) out.push(A);
    if (aIn !== bIn) {
      const t = (surface - A.y) / (B.y - A.y);
      out.push(new Vec2(A.x + (B.x - A.x) * t, surface));
    }
  }
  return out;
}

/** Absolute area and area-weighted centroid of a simple polygon. */
function polygonAreaCentroid(pts: Vec2[]): { area: number; centroid: Vec2 } {
  let a2 = 0;
  let cx = 0;
  let cy = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % n];
    const cross = p.x * q.y - q.x * p.y;
    a2 += cross;
    cx += (p.x + q.x) * cross;
    cy += (p.y + q.y) * cross;
  }
  if (Math.abs(a2) < 1e-12) return { area: 0, centroid: pts[0] };
  // a2 = 2·signed-area; the signed factor cancels in the centroid quotient.
  return { area: Math.abs(a2) * 0.5, centroid: new Vec2(cx / (3 * a2), cy / (3 * a2)) };
}
