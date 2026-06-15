import { AABB } from './aabb';
import { Body, BodyType } from './body';
import { BroadPhase } from './broadphase';
import { gjkDistance } from './collision/gjk';
import { timeOfImpact } from './collision/toi';
import { Contact, ContactSolver, DEFAULT_CONFIG, type SolverConfig } from './contact';
import { BuoyancyZone } from './fluid';
import { type Joint } from './joints/joint';
import { clamp, EPSILON, Transform, Vec2 } from './math';
import { boundingRadius, computeAABB, type Shape } from './shapes';

/** Per-step statistics surfaced to the UI HUD. */
export interface StepStats {
  bodies: number;
  awakeBodies: number;
  contacts: number;
  contactPoints: number;
  joints: number;
  islands: number;
  pairs: number;
  treeHeight: number;
  stepMs: number;
}

/** Result of a world ray cast. */
export interface RayHit {
  body: Body;
  point: Vec2;
  normal: Vec2;
  fraction: number;
}

/** Result of a world shape cast (sweeping a convex shape through the world). */
export interface ShapeCastHit {
  body: Body;
  /** Contact point on the hit body's surface (world space). */
  point: Vec2;
  /** Surface normal at the hit, pointing out of the hit body toward the caster. */
  normal: Vec2;
  /** Fraction of the cast translation at first contact, in [0,1]. */
  fraction: number;
}

const LINEAR_SLEEP_TOLERANCE = 0.01;
const ANGULAR_SLEEP_TOLERANCE = 2 * (Math.PI / 180);
const TIME_TO_SLEEP = 0.5;

function pairKey(a: number, b: number): number {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return lo * 0x400000 + hi;
}

/**
 * The simulation world. Owns the body set, the broadphase, the persistent
 * contact graph and the joints, and advances everything one fixed step at a
 * time: broadphase → narrowphase → island assembly → sequential-impulse solve →
 * integration → sleeping.
 */
export class World {
  gravity: Vec2;
  config: SolverConfig;
  readonly bodies: Body[] = [];
  readonly joints: Joint[] = [];
  readonly fluidZones: BuoyancyZone[] = [];
  private broadphase = new BroadPhase<Body>();
  private contacts = new Map<number, Contact>();
  /** Body-pair keys for which collision is disabled (jointed bodies). */
  private nonColliding = new Set<number>();
  enableSleep = true;
  stats: StepStats = {
    bodies: 0,
    awakeBodies: 0,
    contacts: 0,
    contactPoints: 0,
    joints: 0,
    islands: 0,
    pairs: 0,
    treeHeight: 0,
    stepMs: 0,
  };

  constructor(gravity = new Vec2(0, -9.8), config: SolverConfig = { ...DEFAULT_CONFIG }) {
    this.gravity = gravity;
    this.config = config;
  }

  addBody(body: Body): Body {
    body.proxyId = this.broadphase.createProxy(body.worldAABB(), body);
    this.bodies.push(body);
    return body;
  }

  removeBody(body: Body): void {
    const idx = this.bodies.indexOf(body);
    if (idx < 0) return;
    this.bodies.splice(idx, 1);
    this.broadphase.destroyProxy(body.proxyId);
    // Drop contacts and joints referencing this body.
    for (const [key, c] of this.contacts) {
      if (c.a === body || c.b === body) this.contacts.delete(key);
    }
    for (let i = this.joints.length - 1; i >= 0; i--) {
      const j = this.joints[i];
      if (j.bodyA === body || j.bodyB === body) this.joints.splice(i, 1);
    }
  }

  /** Add a body of water that applies buoyancy + drag to submerged bodies. */
  addFluid(zone: BuoyancyZone): BuoyancyZone {
    this.fluidZones.push(zone);
    return zone;
  }

  addJoint(joint: Joint, collideConnected = false): Joint {
    this.joints.push(joint);
    if (!collideConnected && joint.bodyA !== joint.bodyB) {
      this.nonColliding.add(pairKey(joint.bodyA.id, joint.bodyB.id));
    }
    return joint;
  }

  removeJoint(joint: Joint): void {
    const idx = this.joints.indexOf(joint);
    if (idx >= 0) this.joints.splice(idx, 1);
    this.nonColliding.delete(pairKey(joint.bodyA.id, joint.bodyB.id));
  }

  clear(): void {
    this.bodies.length = 0;
    this.joints.length = 0;
    this.fluidZones.length = 0;
    this.contacts.clear();
    this.nonColliding.clear();
    this.broadphase = new BroadPhase<Body>();
  }

  /** Advance the simulation by one fixed timestep. */
  step(dt: number): void {
    const t0 = now();
    const ctx = { dt, invDt: dt > 0 ? 1 / dt : 0 };

    // 1. Broadphase: refit moved proxies and gather candidate pairs.
    for (const b of this.bodies) {
      if (b.type === BodyType.Static) continue;
      this.broadphase.moveProxy(b.proxyId, b.worldAABB(), b.linearVelocity.mul(dt));
    }
    const pairs = this.broadphase.computePairs();
    for (const p of pairs) {
      this.addPair(this.broadphase.tree.get(p.a) as Body, this.broadphase.tree.get(p.b) as Body);
    }

    // 2. Narrowphase: refresh or drop persistent contacts.
    let contactPoints = 0;
    for (const [key, c] of this.contacts) {
      if (!this.broadphase.tree.fatAABB(c.a.proxyId).overlaps(this.broadphase.tree.fatAABB(c.b.proxyId))) {
        this.contacts.delete(key);
        continue;
      }
      c.update();
      contactPoints += c.manifold.points.length;
    }

    // 3. Assemble islands and wake any island with a moving member.
    const islands = this.buildIslands();
    for (const island of islands) {
      if (island.some((b) => b.awake)) {
        // Wake only the sleeping members; never reset an awake body's timer.
        for (const b of island) if (!b.awake) b.wake();
      }
    }

    // 3b. Fluid: buoyancy + drag forces, added before velocity integration so
    // they ride the same semi-implicit step as gravity.
    if (this.fluidZones.length > 0) {
      for (const b of this.bodies) {
        if (b.type !== BodyType.Dynamic || !b.awake) continue;
        for (const zone of this.fluidZones) zone.apply(b, this.gravity);
      }
    }

    // 4. Integrate velocities for awake dynamic bodies; clear pseudo-velocities.
    for (const b of this.bodies) {
      if (!b.awake) continue;
      b.integrateVelocity(this.gravity, dt);
      b.resetPseudoVelocity();
    }

    // 5. Solve velocity constraints (warm-started sequential impulses).
    const active: Contact[] = [];
    for (const c of this.contacts.values()) {
      if (c.touching && (this.isSolved(c.a) || this.isSolved(c.b))) active.push(c);
    }
    const activeJoints = this.joints.filter(
      (j) => this.isSolved(j.bodyA) || this.isSolved(j.bodyB),
    );

    const solver = new ContactSolver(this.config, dt);
    solver.init(active);
    for (const j of activeJoints) j.initVelocityConstraints(ctx);
    solver.warmStart();
    for (const j of activeJoints) j.warmStart();
    for (let i = 0; i < this.config.velocityIterations; i++) {
      for (const j of activeJoints) j.solveVelocity();
      solver.solveVelocity();
    }
    solver.storeImpulses();

    // 5b. Split-impulse position correction (pseudo-velocities only).
    for (let i = 0; i < this.config.positionIterations; i++) {
      solver.solvePosition();
    }

    // 6. Integrate positions.
    for (const b of this.bodies) {
      if (b.awake) b.integratePosition(dt);
      b.force = Vec2.ZERO;
      b.torque = 0;
    }

    // 6b. Continuous collision: sweep bullet bodies to their time of impact so
    // fast/thin bodies stop at the wall instead of teleporting through it.
    if (this.config.continuous) this.solveContinuous();

    // 7. Sleeping.
    if (this.enableSleep) this.updateSleep(islands, dt);

    this.stats = {
      bodies: this.bodies.length,
      awakeBodies: this.bodies.filter((b) => b.awake && b.type === BodyType.Dynamic).length,
      contacts: this.contacts.size,
      contactPoints,
      joints: this.joints.length,
      islands: islands.length,
      pairs: pairs.length,
      treeHeight: this.broadphase.tree.height(),
      stepMs: now() - t0,
    };
  }

  private isSolved(b: Body): boolean {
    return b.awake && b.type === BodyType.Dynamic;
  }

  private addPair(a: Body, b: Body): void {
    if (a === b) return;
    if (a.type !== BodyType.Dynamic && b.type !== BodyType.Dynamic) return;
    const key = pairKey(a.id, b.id);
    if (this.nonColliding.has(key)) return;
    if (this.contacts.has(key)) return;
    this.contacts.set(key, new Contact(a, b));
  }

  /** Union-find over dynamic bodies connected by touching contacts and joints. */
  private buildIslands(): Body[][] {
    const parent = new Map<number, Body>();
    const find = (b: Body): Body => {
      let root = b;
      while (parent.get(root.id) && parent.get(root.id) !== root) {
        root = parent.get(root.id) as Body;
      }
      let cur = b;
      while (parent.get(cur.id) && parent.get(cur.id) !== root) {
        const next = parent.get(cur.id) as Body;
        parent.set(cur.id, root);
        cur = next;
      }
      return root;
    };
    const union = (x: Body, y: Body): void => {
      if (x.type !== BodyType.Dynamic || y.type !== BodyType.Dynamic) return;
      parent.set(find(x).id, find(y));
    };
    for (const b of this.bodies) {
      if (b.type === BodyType.Dynamic && !parent.has(b.id)) parent.set(b.id, b);
    }
    for (const c of this.contacts.values()) {
      if (c.touching) union(c.a, c.b);
    }
    for (const j of this.joints) union(j.bodyA, j.bodyB);

    const groups = new Map<number, Body[]>();
    for (const b of this.bodies) {
      if (b.type !== BodyType.Dynamic) continue;
      const root = find(b);
      const list = groups.get(root.id) ?? [];
      list.push(b);
      groups.set(root.id, list);
    }
    return [...groups.values()];
  }

  /**
   * Sweep every awake bullet body across the step and, if it would reach contact
   * with another body, roll it back to that time of impact. The discrete solver
   * then resolves the now-touching contact on the following step. Only bodies
   * that moved more than their own size are tested (slow bodies can't tunnel).
   */
  private solveContinuous(): void {
    for (const a of this.bodies) {
      if (!a.bullet || a.type !== BodyType.Dynamic || !a.awake) continue;
      const travel = a.worldCenter.sub(a.center0).length();
      if (travel < boundingRadius(a.shape) * 0.5) continue;

      // Swept AABB of A over the step, for a cheap broadphase-style reject.
      const sweptA = computeAABB(a.shape, a.sweepTransform(0)).union(a.worldAABB());

      let minT = 1;
      let hit = false;
      for (const b of this.bodies) {
        if (b === a) continue;
        // Resolve each bullet pair once; bullet-vs-bullet handled by id order.
        if (b.bullet && b.type === BodyType.Dynamic && b.id < a.id) continue;
        if (this.nonColliding.has(pairKey(a.id, b.id))) continue;
        const sweptB = computeAABB(b.shape, b.sweepTransform(0)).union(b.worldAABB());
        if (!sweptA.overlaps(sweptB)) continue;
        const res = timeOfImpact(a, b);
        if (res.hit && res.t < minT) {
          minT = res.t;
          hit = true;
        }
      }
      if (hit && minT < 1) a.advanceTo(minT);
    }
  }

  private updateSleep(islands: Body[][], dt: number): void {
    const linTolSq = LINEAR_SLEEP_TOLERANCE * LINEAR_SLEEP_TOLERANCE;
    const angTolSq = ANGULAR_SLEEP_TOLERANCE * ANGULAR_SLEEP_TOLERANCE;
    for (const island of islands) {
      let minSleep = Infinity;
      for (const b of island) {
        if (
          !b.allowSleep ||
          b.linearVelocity.lengthSq() > linTolSq ||
          b.angularVelocity * b.angularVelocity > angTolSq
        ) {
          b.sleepTime = 0;
        } else {
          b.sleepTime += dt;
        }
        minSleep = Math.min(minSleep, b.sleepTime);
      }
      if (minSleep >= TIME_TO_SLEEP) {
        for (const b of island) b.sleep();
      }
    }
  }

  /** Closest distance between two bodies' shapes (GJK) — used by the inspector. */
  distanceBetween(a: Body, b: Body) {
    return gjkDistance(a.shape, a.transform, b.shape, b.transform);
  }

  /** Find the topmost body whose shape contains the world point. */
  queryPoint(point: Vec2): Body | null {
    let found: Body | null = null;
    const probe = new AABB(point, point);
    this.broadphase.tree.query(probe, (id) => {
      const body = this.broadphase.tree.get(id) as Body;
      const d = this.pointInside(body, point);
      if (d) found = body;
    });
    return found;
  }

  private pointInside(body: Body, point: Vec2): boolean {
    const local = body.localPoint(point);
    const shape = body.shape;
    if (shape.kind === 'circle') {
      return local.sub(shape.center).lengthSq() <= shape.radius * shape.radius;
    }
    if (shape.kind === 'capsule') {
      const ab = shape.p2.sub(shape.p1);
      const t = ab.lengthSq() > 1e-12 ? clamp(local.sub(shape.p1).dot(ab) / ab.lengthSq(), 0, 1) : 0;
      const closest = shape.p1.add(ab.mul(t));
      return local.sub(closest).lengthSq() <= shape.radius * shape.radius;
    }
    for (let i = 0; i < shape.vertices.length; i++) {
      const d = shape.normals[i].dot(local.sub(shape.vertices[i]));
      if (d > shape.radius) return false;
    }
    return true;
  }

  /** Cast a ray and return the nearest body hit, if any. */
  rayCast(origin: Vec2, target: Vec2): RayHit | null {
    let best: RayHit | null = null;
    this.broadphase.tree.rayCast(origin, target, (id) => {
      const body = this.broadphase.tree.get(id) as Body;
      const hit = rayShape(body, origin, target);
      if (hit && (best === null || hit.fraction < best.fraction)) {
        best = hit;
      }
      // Always continue; we want the closest across all candidates.
      return 1;
    });
    return best;
  }

  /**
   * Every body whose tight world AABB overlaps `region`. The broadphase narrows
   * the candidates to those whose fat AABB overlaps; each is then refined against
   * its exact AABB so the result is precise (no fat-margin false positives).
   */
  queryAABB(region: AABB): Body[] {
    const out: Body[] = [];
    this.broadphase.tree.query(region, (id) => {
      const body = this.broadphase.tree.get(id) as Body;
      if (body.worldAABB().overlaps(region)) out.push(body);
    });
    return out;
  }

  /**
   * Sweep a convex `shape` (placed at `xf`) along `translation` and return the
   * first body it touches. Each candidate is resolved by conservative advancement
   * on the exact GJK distance — the same never-overshoot logic the CCD solver
   * uses — so the reported fraction is the true first-contact time. Returns the
   * nearest hit, or null if the swept shape stays clear.
   */
  shapeCast(shape: Shape, xf: Transform, translation: Vec2): ShapeCastHit | null {
    const dist = translation.length();
    if (dist < EPSILON) return null;
    const startAABB = computeAABB(shape, xf);
    const endAABB = computeAABB(shape, new Transform(xf.position.add(translation), xf.q));
    const swept = startAABB.union(endAABB);

    let best: ShapeCastHit | null = null;
    this.broadphase.tree.query(swept, (id) => {
      const body = this.broadphase.tree.get(id) as Body;
      const hit = castShapeAtBody(shape, xf, translation, dist, body);
      if (hit && (best === null || hit.fraction < best.fraction)) best = hit;
    });
    return best;
  }

  /** Live contact points with their world normals, for the debug overlay. */
  contactPoints(): Array<{ point: Vec2; normal: Vec2 }> {
    const out: Array<{ point: Vec2; normal: Vec2 }> = [];
    for (const c of this.contacts.values()) {
      if (!c.touching) continue;
      for (const p of c.manifold.points) out.push({ point: p.point, normal: c.manifold.normal });
    }
    return out;
  }

  /** Visit the broadphase BVH nodes (for the broadphase debug overlay). */
  eachTreeNode(cb: (aabb: AABB, leaf: boolean, depth: number) => void): void {
    this.broadphase.tree.traverse(cb);
  }

  /** Total kinetic energy of the dynamic bodies — used by the verifier. */
  totalKineticEnergy(): number {
    let e = 0;
    for (const b of this.bodies) if (b.type === BodyType.Dynamic) e += b.kineticEnergy();
    return e;
  }
}

/**
 * Conservative-advancement shape cast of a moving convex `shape` (translating by
 * `translation`, no rotation) against a single fixed `body`. Mirrors the CCD
 * time-of-impact loop but for a free shape: measure the exact gap with GJK, then
 * advance by the most that cannot overshoot first contact.
 */
function castShapeAtBody(
  shape: Shape,
  xf: Transform,
  translation: Vec2,
  dist: number,
  body: Body,
  tolerance = 0.005,
): ShapeCastHit | null {
  let t = 0;
  for (let iter = 0; iter < 32; iter++) {
    const pose = new Transform(xf.position.add(translation.mul(t)), xf.q);
    const d = gjkDistance(shape, pose, body.shape, body.transform);
    if (d.distance <= tolerance) {
      let n = d.pointA.sub(d.pointB);
      n = n.lengthSq() > EPSILON ? n.normalize() : translation.mul(-1 / dist);
      return { body, point: d.pointB, normal: n, fraction: t };
    }
    t += (d.distance - tolerance) / dist; // cannot overshoot: surfaces close ≤ dist
    if (t >= 1) return null;
  }
  return null;
}

function rayShape(body: Body, origin: Vec2, target: Vec2): RayHit | null {
  // Transform the ray into local space, intersect, transform the hit back.
  const p1 = body.localPoint(origin);
  const p2 = body.localPoint(target);
  const d = p2.sub(p1);

  if (body.shape.kind === 'circle') {
    const c = body.shape.center;
    const m = p1.sub(c);
    const bq = m.dot(d);
    const cq = m.lengthSq() - body.shape.radius * body.shape.radius;
    const aq = d.lengthSq();
    const disc = bq * bq - aq * cq;
    if (disc < 0 || aq < 1e-12) return null;
    const t = (-bq - Math.sqrt(disc)) / aq;
    if (t < 0 || t > 1) return null;
    const localHit = p1.add(d.mul(t));
    return {
      body,
      point: body.worldPoint(localHit),
      normal: body.transform.q.apply(localHit.sub(c).normalize()),
      fraction: t,
    };
  }

  if (body.shape.kind === 'capsule') {
    const hit = rayCapsuleLocal(p1, d, body.shape.p1, body.shape.p2, body.shape.radius);
    if (!hit) return null;
    const localHit = p1.add(d.mul(hit.t));
    return {
      body,
      point: body.worldPoint(localHit),
      normal: body.transform.q.apply(hit.normal),
      fraction: hit.t,
    };
  }

  // Polygon: clip the ray against each face plane (slab method).
  let lower = 0;
  let upper = 1;
  let normalIdx = -1;
  const poly = body.shape;
  for (let i = 0; i < poly.vertices.length; i++) {
    const num = poly.normals[i].dot(poly.vertices[i].sub(p1));
    const den = poly.normals[i].dot(d);
    if (Math.abs(den) < 1e-12) {
      if (num < 0) return null;
    } else if (den < 0 && num < lower * den) {
      lower = num / den;
      normalIdx = i;
    } else if (den > 0 && num < upper * den) {
      upper = num / den;
    }
    if (upper < lower) return null;
  }
  if (normalIdx < 0) return null;
  const localHit = p1.add(d.mul(lower));
  return {
    body,
    point: body.worldPoint(localHit),
    normal: body.transform.q.apply(poly.normals[normalIdx]),
    fraction: lower,
  };
}

/**
 * Ray vs capsule in the capsule's local frame: the minimum of the ray against
 * the side cylinder (clamped to the segment span) and against the two end caps.
 */
function rayCapsuleLocal(
  p: Vec2,
  d: Vec2,
  A: Vec2,
  B: Vec2,
  r: number,
): { t: number; normal: Vec2 } | null {
  const ab = B.sub(A);
  const len = ab.length();
  if (len < 1e-9) {
    return raySphereLocal(p, d, A, r);
  }
  const u = ab.mul(1 / len);
  let best: { t: number; normal: Vec2 } | null = null;
  const consider = (cand: { t: number; normal: Vec2 } | null): void => {
    if (cand && cand.t >= 0 && cand.t <= 1 && (best === null || cand.t < best.t)) best = cand;
  };

  // Side (infinite cylinder, then clamp the projection to [0, len]).
  const m = p.sub(A);
  const dPerp = d.sub(u.mul(d.dot(u)));
  const mPerp = m.sub(u.mul(m.dot(u)));
  const aq = dPerp.dot(dPerp);
  if (aq > 1e-12) {
    const bq = mPerp.dot(dPerp);
    const cq = mPerp.dot(mPerp) - r * r;
    const disc = bq * bq - aq * cq;
    if (disc >= 0) {
      const t = (-bq - Math.sqrt(disc)) / aq;
      const hit = p.add(d.mul(t));
      const s = hit.sub(A).dot(u);
      if (s >= 0 && s <= len) {
        const onAxis = A.add(u.mul(s));
        consider({ t, normal: hit.sub(onAxis).normalize() });
      }
    }
  }
  // End caps.
  consider(raySphereLocal(p, d, A, r));
  consider(raySphereLocal(p, d, B, r));
  return best;
}

function raySphereLocal(p: Vec2, d: Vec2, c: Vec2, r: number): { t: number; normal: Vec2 } | null {
  const m = p.sub(c);
  const aq = d.dot(d);
  if (aq < 1e-12) return null;
  const bq = m.dot(d);
  const cq = m.dot(m) - r * r;
  const disc = bq * bq - aq * cq;
  if (disc < 0) return null;
  const t = (-bq - Math.sqrt(disc)) / aq;
  const hit = p.add(d.mul(t));
  return { t, normal: hit.sub(c).normalize() };
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
