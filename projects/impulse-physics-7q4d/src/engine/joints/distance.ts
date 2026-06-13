import { Body } from '../body';
import { Vec2 } from '../math';
import {
  applyBodyImpulse,
  pointVelocityDelta,
  softConstraint,
  type Joint,
  type JointContext,
} from './joint';

/**
 * A distance joint holding two anchors a fixed `length` apart. With a non-zero
 * `frequencyHz` it becomes a damped spring (a soft constraint), which is how the
 * playground builds ropes, springs and suspension.
 */
export class DistanceJoint implements Joint {
  readonly kind = 'distance';
  readonly bodyA: Body;
  readonly bodyB: Body;
  private localAnchorA: Vec2;
  private localAnchorB: Vec2;
  length: number;

  /** 0 ⇒ rigid rod. >0 ⇒ spring at this frequency. */
  frequencyHz = 0;
  dampingRatio = 0.7;

  private rA = Vec2.ZERO;
  private rB = Vec2.ZERO;
  private u = Vec2.ZERO;
  private mass = 0;
  private gamma = 0;
  private bias = 0;
  private impulse = 0;

  constructor(bodyA: Body, bodyB: Body, anchorA: Vec2, anchorB: Vec2, length?: number) {
    this.bodyA = bodyA;
    this.bodyB = bodyB;
    this.localAnchorA = bodyA.localPoint(anchorA);
    this.localAnchorB = bodyB.localPoint(anchorB);
    this.length = length ?? anchorA.distanceTo(anchorB);
  }

  initVelocityConstraints(ctx: JointContext): void {
    const a = this.bodyA;
    const b = this.bodyB;
    this.rA = a.transform.q.apply(this.localAnchorA.sub(a.localCenter));
    this.rB = b.transform.q.apply(this.localAnchorB.sub(b.localCenter));
    const d = b.worldCenter.add(this.rB).sub(a.worldCenter.add(this.rA));
    const len = d.length();
    this.u = len > 1e-6 ? d.mul(1 / len) : Vec2.ZERO;

    const crA = this.rA.cross(this.u);
    const crB = this.rB.cross(this.u);
    const invMass =
      a.invMass + a.invInertia * crA * crA + b.invMass + b.invInertia * crB * crB;
    let mass = invMass > 0 ? 1 / invMass : 0;
    const c = len - this.length;

    if (this.frequencyHz > 0) {
      const soft = softConstraint(this.frequencyHz, this.dampingRatio, mass, ctx.dt);
      this.gamma = soft.gamma;
      this.bias = c * soft.biasFactor;
      mass = invMass + this.gamma > 0 ? 1 / (invMass + this.gamma) : 0;
      this.mass = mass;
    } else {
      this.gamma = 0;
      this.bias = c * 0.2 * ctx.invDt; // Baumgarte for the rigid case.
      this.mass = mass;
    }
  }

  warmStart(): void {
    const p = this.u.mul(this.impulse);
    applyBodyImpulse(this.bodyA, p.neg(), this.rA);
    applyBodyImpulse(this.bodyB, p, this.rB);
  }

  solveVelocity(): void {
    const cdot = pointVelocityDelta(this.bodyA, this.bodyB, this.rA, this.rB).dot(this.u);
    const impulse = -this.mass * (cdot + this.bias + this.gamma * this.impulse);
    this.impulse += impulse;
    const p = this.u.mul(impulse);
    applyBodyImpulse(this.bodyA, p.neg(), this.rA);
    applyBodyImpulse(this.bodyB, p, this.rB);
  }

  anchorA(): Vec2 {
    return this.bodyA.worldPoint(this.localAnchorA);
  }

  anchorB(): Vec2 {
    return this.bodyB.worldPoint(this.localAnchorB);
  }
}
