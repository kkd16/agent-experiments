import { Body } from './body';
import { collide, type Manifold } from './collision/manifold';
import { crossSV, Mat22, Vec2 } from './math';

/** Tunable constants for the contact solver. */
export interface SolverConfig {
  velocityIterations: number;
  positionIterations: number;
  /** Baumgarte position-correction factor (0–1). */
  baumgarte: number;
  /** Penetration allowed before correction kicks in (meters). */
  slop: number;
  /** Relative speed below which collisions are treated as inelastic. */
  restitutionThreshold: number;
  warmStarting: boolean;
  /** Sweep `bullet` bodies to their time of impact so they can't tunnel. */
  continuous: boolean;
  /**
   * Solve 2-point manifolds with the exact block LCP (Box2D-Lite) rather than
   * point-by-point Gauss–Seidel. Couples the two contacts so a stack of wide
   * bodies (a plank on two supports, boxes on boxes) settles flat in one pass
   * instead of rocking as each point fights the other.
   */
  blockSolver: boolean;
}

export const DEFAULT_CONFIG: SolverConfig = {
  velocityIterations: 10,
  positionIterations: 4,
  baumgarte: 0.2,
  slop: 0.005,
  restitutionThreshold: 1.0,
  warmStarting: true,
  continuous: true,
  blockSolver: true,
};

interface PersistentPoint {
  id: number;
  normalImpulse: number;
  tangentImpulse: number;
}

function combineFriction(a: number, b: number): number {
  return Math.sqrt(a * b);
}

function combineRestitution(a: number, b: number): number {
  return Math.max(a, b);
}

/**
 * A persistent contact between two bodies. Recreated geometry each step is fed
 * through {@link update}, which carries accumulated impulses forward by matching
 * contact-point feature ids — the warm starting that lets stacks settle fast.
 */
export class Contact {
  readonly a: Body;
  readonly b: Body;
  readonly friction: number;
  readonly restitution: number;
  manifold: Manifold;
  points: PersistentPoint[] = [];
  touching = false;

  constructor(a: Body, b: Body) {
    this.a = a;
    this.b = b;
    this.friction = combineFriction(a.friction, b.friction);
    this.restitution = combineRestitution(a.restitution, b.restitution);
    this.manifold = { normal: Vec2.ZERO, points: [] };
  }

  /** Recompute geometry and merge previous impulses by feature id. */
  update(): void {
    const next = collide(this.a.shape, this.a.transform, this.b.shape, this.b.transform);
    const merged: PersistentPoint[] = next.points.map((p) => {
      const prev = this.points.find((o) => o.id === p.id);
      return {
        id: p.id,
        normalImpulse: prev ? prev.normalImpulse : 0,
        tangentImpulse: prev ? prev.tangentImpulse : 0,
      };
    });
    this.manifold = next;
    this.points = merged;
    this.touching = next.points.length > 0;
  }
}

/** Per-contact-point working data built fresh each step. */
interface ConstraintPoint {
  rA: Vec2;
  rB: Vec2;
  normalMass: number;
  tangentMass: number;
  /** Penetration depth captured at the start of the step (for position solve). */
  penetration: number;
  /** Restitution target velocity. */
  velocityBias: number;
  normalImpulse: number;
  tangentImpulse: number;
  /** Accumulated pseudo-impulse for split-impulse position correction. */
  pseudoNormalImpulse: number;
  persistent: PersistentPoint;
}

interface VelocityConstraint {
  contact: Contact;
  normal: Vec2;
  tangent: Vec2;
  points: ConstraintPoint[];
  /** 2×2 normal-coupling matrix for the block solver (only for 2-point manifolds). */
  K: Mat22 | null;
}

/**
 * Solve the two-contact normal LCP exactly. Find total impulses `x ≥ 0` such that
 * the post-impulse residual `w = K·x + b ≥ 0` with complementarity `xᵀw = 0`,
 * where `b = vn − K·a` folds in the velocity targets `vn` (relative normal
 * velocity minus the restitution bias) and the already-accumulated impulses `a`.
 *
 * `K` is the symmetric positive-definite coupling matrix; a one-DOF inverse is
 * used per axis for the boundary cases. This is Box2D-Lite's four-case analysis,
 * lifted out as a pure function so the verification suite can assert the LCP
 * conditions directly on random systems.
 */
export function solveBlockLcp(K: Mat22, a: Vec2, vn: Vec2): Vec2 {
  const b = vn.sub(K.mulV(a));
  const invK11 = K.a > 0 ? 1 / K.a : 0;
  const invK22 = K.d > 0 ? 1 / K.d : 0;

  // Case 1: both contacts active. x = −K⁻¹·b.
  {
    const x = K.solve(b.neg());
    if (x.x >= 0 && x.y >= 0) return x;
  }
  // Case 2: contact 1 active, contact 2 inactive (x2 = 0).
  {
    const x1 = -invK11 * b.x;
    const w2 = K.c * x1 + b.y;
    if (x1 >= 0 && w2 >= 0) return new Vec2(x1, 0);
  }
  // Case 3: contact 2 active, contact 1 inactive (x1 = 0).
  {
    const x2 = -invK22 * b.y;
    const w1 = K.b * x2 + b.x;
    if (x2 >= 0 && w1 >= 0) return new Vec2(0, x2);
  }
  // Case 4: both inactive.
  if (b.x >= 0 && b.y >= 0) return Vec2.ZERO;
  // Degenerate fallback (shouldn't happen for an SPD K): clamp the 1-DOF guesses.
  return new Vec2(Math.max(-invK11 * b.x, 0), Math.max(-invK22 * b.y, 0));
}

/**
 * Builds and solves velocity constraints for a batch of contacts using the
 * sequential-impulse method (Erin Catto / Box2D-Lite): friction and normal
 * impulses are accumulated and clamped per point, iterated to convergence.
 */
export class ContactSolver {
  private constraints: VelocityConstraint[] = [];
  private config: SolverConfig;
  private invDt: number;

  constructor(config: SolverConfig, dt: number) {
    this.config = config;
    this.invDt = dt > 0 ? 1 / dt : 0;
  }

  init(contacts: Contact[]): void {
    this.constraints = [];
    for (const c of contacts) {
      if (!c.touching) continue;
      const normal = c.manifold.normal;
      const tangent = crossSV(1, normal);
      const a = c.a;
      const b = c.b;
      const points: ConstraintPoint[] = [];
      for (let i = 0; i < c.manifold.points.length; i++) {
        const mp = c.manifold.points[i];
        const persistent = c.points[i];
        const rA = mp.point.sub(a.worldCenter);
        const rB = mp.point.sub(b.worldCenter);

        const rnA = rA.cross(normal);
        const rnB = rB.cross(normal);
        const kNormal =
          a.invMass + b.invMass + a.invInertia * rnA * rnA + b.invInertia * rnB * rnB;

        const rtA = rA.cross(tangent);
        const rtB = rB.cross(tangent);
        const kTangent =
          a.invMass + b.invMass + a.invInertia * rtA * rtA + b.invInertia * rtB * rtB;

        // Relative normal velocity for restitution.
        const dv = b.velocityAt(mp.point).sub(a.velocityAt(mp.point));
        const vn = dv.dot(normal);
        const velocityBias = vn < -this.config.restitutionThreshold
          ? -c.restitution * vn
          : 0;

        points.push({
          rA,
          rB,
          normalMass: kNormal > 0 ? 1 / kNormal : 0,
          tangentMass: kTangent > 0 ? 1 / kTangent : 0,
          penetration: mp.penetration,
          velocityBias,
          normalImpulse: this.config.warmStarting ? persistent.normalImpulse : 0,
          tangentImpulse: this.config.warmStarting ? persistent.tangentImpulse : 0,
          pseudoNormalImpulse: 0,
          persistent,
        });
      }

      // Build the 2×2 normal-coupling matrix for the block solver. Only assemble
      // it when the two points are well-conditioned (Box2D's near-parallel guard)
      // so a degenerate manifold falls back to the robust point-by-point solve.
      let K: Mat22 | null = null;
      if (this.config.blockSolver && points.length === 2) {
        const [p1, p2] = points;
        const rn1A = p1.rA.cross(normal);
        const rn1B = p1.rB.cross(normal);
        const rn2A = p2.rA.cross(normal);
        const rn2B = p2.rB.cross(normal);
        const k11 = a.invMass + b.invMass + a.invInertia * rn1A * rn1A + b.invInertia * rn1B * rn1B;
        const k22 = a.invMass + b.invMass + a.invInertia * rn2A * rn2A + b.invInertia * rn2B * rn2B;
        const k12 = a.invMass + b.invMass + a.invInertia * rn1A * rn2A + b.invInertia * rn1B * rn2B;
        const MAX_CONDITION = 1000;
        if (k11 * k11 < MAX_CONDITION * (k11 * k22 - k12 * k12)) {
          K = new Mat22(k11, k12, k12, k22);
        }
      }

      this.constraints.push({ contact: c, normal, tangent, points, K });
    }
  }

  /** Seed the solve with last frame's impulses so it converges in fewer iters. */
  warmStart(): void {
    if (!this.config.warmStarting) return;
    for (const vc of this.constraints) {
      const { a, b } = vc.contact;
      for (const p of vc.points) {
        const impulse = vc.normal.mul(p.normalImpulse).add(vc.tangent.mul(p.tangentImpulse));
        applyImpulse(a, b, impulse, p.rA, p.rB);
      }
    }
  }

  solveVelocity(): void {
    for (const vc of this.constraints) {
      const { a, b } = vc.contact;
      const friction = vc.contact.friction;

      // Friction first (solved per point, bounded by the current normal impulse).
      for (const p of vc.points) {
        const dv = relativeVelocity(a, b, p.rA, p.rB);
        const vt = dv.dot(vc.tangent);
        let lambda = -p.tangentMass * vt;
        const maxFriction = friction * p.normalImpulse;
        const newImpulse = clampSym(p.tangentImpulse + lambda, maxFriction);
        lambda = newImpulse - p.tangentImpulse;
        p.tangentImpulse = newImpulse;
        applyImpulse(a, b, vc.tangent.mul(lambda), p.rA, p.rB);
      }

      // Normal impulses: the exact 2-point block LCP when conditioned, else the
      // robust point-by-point Gauss–Seidel relaxation.
      if (vc.K) {
        const [p1, p2] = vc.points;
        const aOld = new Vec2(p1.normalImpulse, p2.normalImpulse);
        const vn1 = relativeVelocity(a, b, p1.rA, p1.rB).dot(vc.normal) - p1.velocityBias;
        const vn2 = relativeVelocity(a, b, p2.rA, p2.rB).dot(vc.normal) - p2.velocityBias;
        const x = solveBlockLcp(vc.K, aOld, new Vec2(vn1, vn2));
        const d1 = x.x - aOld.x;
        const d2 = x.y - aOld.y;
        applyImpulse(a, b, vc.normal.mul(d1), p1.rA, p1.rB);
        applyImpulse(a, b, vc.normal.mul(d2), p2.rA, p2.rB);
        p1.normalImpulse = x.x;
        p2.normalImpulse = x.y;
      } else {
        for (const p of vc.points) {
          const dv = relativeVelocity(a, b, p.rA, p.rB);
          const vn = dv.dot(vc.normal);
          let lambda = p.normalMass * (-vn + p.velocityBias);
          const newImpulse = Math.max(p.normalImpulse + lambda, 0);
          lambda = newImpulse - p.normalImpulse;
          p.normalImpulse = newImpulse;
          applyImpulse(a, b, vc.normal.mul(lambda), p.rA, p.rB);
        }
      }
    }
  }

  /**
   * Split-impulse position correction. Operates on the bodies' pseudo-velocities
   * so penetration is pushed out without adding energy to the real motion —
   * which keeps stacks crisp and lets resting bodies actually fall asleep.
   */
  solvePosition(): void {
    const beta = this.config.baumgarte;
    const slop = this.config.slop;
    for (const vc of this.constraints) {
      const { a, b } = vc.contact;
      for (const p of vc.points) {
        const bias = beta * this.invDt * Math.max(p.penetration - slop, 0);
        if (bias <= 0) continue;
        const dv = relativePseudoVelocity(a, b, p.rA, p.rB);
        const vn = dv.dot(vc.normal);
        let lambda = p.normalMass * (-vn + bias);
        const newImpulse = Math.max(p.pseudoNormalImpulse + lambda, 0);
        lambda = newImpulse - p.pseudoNormalImpulse;
        p.pseudoNormalImpulse = newImpulse;
        applyPseudoImpulse(a, b, vc.normal.mul(lambda), p.rA, p.rB);
      }
    }
  }

  /** Write solved impulses back to the persistent contact for next frame. */
  storeImpulses(): void {
    for (const vc of this.constraints) {
      for (const p of vc.points) {
        p.persistent.normalImpulse = p.normalImpulse;
        p.persistent.tangentImpulse = p.tangentImpulse;
      }
    }
  }
}

function relativeVelocity(a: Body, b: Body, rA: Vec2, rB: Vec2): Vec2 {
  const vA = a.linearVelocity.add(crossSV(a.angularVelocity, rA));
  const vB = b.linearVelocity.add(crossSV(b.angularVelocity, rB));
  return vB.sub(vA);
}

function relativePseudoVelocity(a: Body, b: Body, rA: Vec2, rB: Vec2): Vec2 {
  const vA = a.pseudoLinear.add(crossSV(a.pseudoAngular, rA));
  const vB = b.pseudoLinear.add(crossSV(b.pseudoAngular, rB));
  return vB.sub(vA);
}

function applyImpulse(a: Body, b: Body, impulse: Vec2, rA: Vec2, rB: Vec2): void {
  a.linearVelocity = a.linearVelocity.sub(impulse.mul(a.invMass));
  a.angularVelocity -= a.invInertia * rA.cross(impulse);
  b.linearVelocity = b.linearVelocity.add(impulse.mul(b.invMass));
  b.angularVelocity += b.invInertia * rB.cross(impulse);
}

function applyPseudoImpulse(a: Body, b: Body, impulse: Vec2, rA: Vec2, rB: Vec2): void {
  a.pseudoLinear = a.pseudoLinear.sub(impulse.mul(a.invMass));
  a.pseudoAngular -= a.invInertia * rA.cross(impulse);
  b.pseudoLinear = b.pseudoLinear.add(impulse.mul(b.invMass));
  b.pseudoAngular += b.invInertia * rB.cross(impulse);
}

function clampSym(x: number, limit: number): number {
  return x < -limit ? -limit : x > limit ? limit : x;
}
