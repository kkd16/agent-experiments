import { AABB } from './aabb';
import { Body, BodyType } from './body';
import { BroadPhase } from './broadphase';
import { gjkDistance } from './collision/gjk';
import { Contact, ContactSolver, DEFAULT_CONFIG, type SolverConfig } from './contact';
import { type Joint } from './joints/joint';
import { Vec2 } from './math';

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
    if (body.shape.kind === 'circle') {
      return local.sub(body.shape.center).lengthSq() <= body.shape.radius * body.shape.radius;
    }
    for (let i = 0; i < body.shape.vertices.length; i++) {
      if (body.shape.normals[i].dot(local.sub(body.shape.vertices[i])) > 0) return false;
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

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
