import { Body } from '../body';
import { Mat22, Vec2 } from '../math';
import { applyBodyImpulse, pointVelocityDelta, type Joint, type JointContext } from './joint';

/**
 * A weld joint rigidly fixes the relative position and orientation of two
 * bodies. The angular (1-DOF) and point (2-DOF) constraints are solved
 * sequentially each iteration — enough to hold ragdoll torsos and welded
 * compounds together convincingly.
 */
export class WeldJoint implements Joint {
  readonly kind = 'weld';
  readonly bodyA: Body;
  readonly bodyB: Body;
  private localAnchorA: Vec2;
  private localAnchorB: Vec2;
  private referenceAngle: number;

  /** Breaking budgets: the weld breaks above this force (N) or torque (N·m). */
  breakForce = Infinity;
  breakTorque = Infinity;

  private rA = Vec2.ZERO;
  private rB = Vec2.ZERO;
  private mass = new Mat22();
  private angularMass = 0;
  private linearBias = Vec2.ZERO;
  private angularBias = 0;
  private impulse = Vec2.ZERO;
  private angularImpulse = 0;

  constructor(bodyA: Body, bodyB: Body, worldAnchor: Vec2) {
    this.bodyA = bodyA;
    this.bodyB = bodyB;
    this.localAnchorA = bodyA.localPoint(worldAnchor);
    this.localAnchorB = bodyB.localPoint(worldAnchor);
    this.referenceAngle = bodyB.angle - bodyA.angle;
  }

  initVelocityConstraints(ctx: JointContext): void {
    const a = this.bodyA;
    const b = this.bodyB;
    this.rA = a.transform.q.apply(this.localAnchorA.sub(a.localCenter));
    this.rB = b.transform.q.apply(this.localAnchorB.sub(b.localCenter));

    const mA = a.invMass;
    const mB = b.invMass;
    const iA = a.invInertia;
    const iB = b.invInertia;
    const k11 = mA + mB + iA * this.rA.y * this.rA.y + iB * this.rB.y * this.rB.y;
    const k12 = -iA * this.rA.x * this.rA.y - iB * this.rB.x * this.rB.y;
    const k22 = mA + mB + iA * this.rA.x * this.rA.x + iB * this.rB.x * this.rB.x;
    this.mass = new Mat22(k11, k12, k12, k22);
    this.angularMass = iA + iB > 0 ? 1 / (iA + iB) : 0;

    const pA = a.worldCenter.add(this.rA);
    const pB = b.worldCenter.add(this.rB);
    this.linearBias = pB.sub(pA).mul(0.2 * ctx.invDt);
    this.angularBias = (b.angle - a.angle - this.referenceAngle) * 0.2 * ctx.invDt;
  }

  warmStart(): void {
    applyBodyImpulse(this.bodyA, this.impulse.neg(), this.rA);
    applyBodyImpulse(this.bodyB, this.impulse, this.rB);
    this.bodyA.angularVelocity -= this.bodyA.invInertia * this.angularImpulse;
    this.bodyB.angularVelocity += this.bodyB.invInertia * this.angularImpulse;
  }

  solveVelocity(): void {
    const a = this.bodyA;
    const b = this.bodyB;

    // Angular constraint first.
    {
      const cdot = b.angularVelocity - a.angularVelocity + this.angularBias;
      const impulse = -this.angularMass * cdot;
      this.angularImpulse += impulse;
      a.angularVelocity -= a.invInertia * impulse;
      b.angularVelocity += b.invInertia * impulse;
    }
    // Linear point constraint.
    {
      const cdot = pointVelocityDelta(a, b, this.rA, this.rB).add(this.linearBias);
      const impulse = this.mass.solve(cdot.neg());
      this.impulse = this.impulse.add(impulse);
      applyBodyImpulse(a, impulse.neg(), this.rA);
      applyBodyImpulse(b, impulse, this.rB);
    }
  }

  /** Magnitude of the point-constraint reaction force (for breaking). */
  reactionForce(invDt: number): number {
    return this.impulse.length() * invDt;
  }
  /** Magnitude of the angular reaction torque (for breaking). */
  reactionTorque(invDt: number): number {
    return Math.abs(this.angularImpulse) * invDt;
  }

  anchorA(): Vec2 {
    return this.bodyA.worldPoint(this.localAnchorA);
  }

  anchorB(): Vec2 {
    return this.bodyB.worldPoint(this.localAnchorB);
  }
}
