import { Body } from './body';
import { collide, type Manifold } from './collision/manifold';
import { crossSV, Vec2 } from './math';

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
}

export const DEFAULT_CONFIG: SolverConfig = {
  velocityIterations: 10,
  positionIterations: 4,
  baumgarte: 0.2,
  slop: 0.005,
  restitutionThreshold: 1.0,
  warmStarting: true,
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
      this.constraints.push({ contact: c, normal, tangent, points });
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

      for (const p of vc.points) {
        // Friction (solved first, bounded by the current normal impulse).
        {
          const dv = relativeVelocity(a, b, p.rA, p.rB);
          const vt = dv.dot(vc.tangent);
          let lambda = -p.tangentMass * vt;
          const maxFriction = friction * p.normalImpulse;
          const newImpulse = clampSym(p.tangentImpulse + lambda, maxFriction);
          lambda = newImpulse - p.tangentImpulse;
          p.tangentImpulse = newImpulse;
          applyImpulse(a, b, vc.tangent.mul(lambda), p.rA, p.rB);
        }
        // Normal impulse with restitution (position error handled separately).
        {
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
