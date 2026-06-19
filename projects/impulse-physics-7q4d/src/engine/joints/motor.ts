import { Body } from '../body';
import { clamp, Vec2 } from '../math';
import { type Joint, type JointContext } from './joint';

/**
 * A motor joint drives body B to hold a target position + angle *relative to*
 * body A, with a bounded force and torque — so it behaves like a powered
 * actuator that can be stalled or overpowered rather than an infinitely-stiff
 * weld. It's the natural way to script a moving platform that still interacts
 * physically: push back on it hard enough (beyond `maxForce`) and it gives.
 *
 * Ported from Box2D's `b2MotorJoint`, with the constraint applied at each body's
 * centre of mass (the `linearOffset` is the desired displacement of B's centre
 * from A's, expressed in A's rotating frame).
 */
export class MotorJoint implements Joint {
  readonly kind = 'motor';
  readonly bodyA: Body;
  readonly bodyB: Body;

  /** Desired position of B's centre relative to A's, in A's local frame. */
  linearOffset: Vec2;
  /** Desired angle of B relative to A (radians). */
  angularOffset: number;
  /** Maximum drive force (N). */
  maxForce = 1000;
  /** Maximum drive torque (N·m). */
  maxTorque = 1000;
  /** Fraction of the position error corrected each step (0–1). */
  correctionFactor = 0.3;

  private linearMass = 0;
  private angularMass = 0;
  private linearError = Vec2.ZERO;
  private angularError = 0;
  private linearImpulse = Vec2.ZERO;
  private angularImpulse = 0;
  private invDt = 0;
  private dt = 0;

  constructor(bodyA: Body, bodyB: Body, linearOffset?: Vec2, angularOffset?: number) {
    this.bodyA = bodyA;
    this.bodyB = bodyB;
    // Default the targets to the bodies' current relative pose (no initial jerk).
    this.linearOffset =
      linearOffset ?? bodyA.transform.q.applyT(bodyB.worldCenter.sub(bodyA.worldCenter));
    this.angularOffset = angularOffset ?? bodyB.angle - bodyA.angle;
  }

  initVelocityConstraints(ctx: JointContext): void {
    const a = this.bodyA;
    const b = this.bodyB;
    this.invDt = ctx.invDt;
    this.dt = ctx.dt;

    // Constraint points at the centres of mass (rA = rB = 0) ⇒ the linear
    // effective mass is the isotropic (mA + mB)·I, inverted as a scalar.
    const invMassSum = a.invMass + b.invMass;
    this.linearMass = invMassSum > 0 ? 1 / invMassSum : 0;
    const invInertiaSum = a.invInertia + b.invInertia;
    this.angularMass = invInertiaSum > 0 ? 1 / invInertiaSum : 0;

    this.linearError = b.worldCenter
      .sub(a.worldCenter)
      .sub(a.transform.q.apply(this.linearOffset));
    this.angularError = b.angle - a.angle - this.angularOffset;
  }

  warmStart(): void {
    const a = this.bodyA;
    const b = this.bodyB;
    a.linearVelocity = a.linearVelocity.sub(this.linearImpulse.mul(a.invMass));
    a.angularVelocity -= a.invInertia * this.angularImpulse;
    b.linearVelocity = b.linearVelocity.add(this.linearImpulse.mul(b.invMass));
    b.angularVelocity += b.invInertia * this.angularImpulse;
  }

  solveVelocity(): void {
    const a = this.bodyA;
    const b = this.bodyB;

    // Angular drive (clamped to a torque budget).
    {
      const cdot = b.angularVelocity - a.angularVelocity +
        this.invDt * this.correctionFactor * this.angularError;
      let impulse = -this.angularMass * cdot;
      const old = this.angularImpulse;
      const max = this.dt * this.maxTorque;
      this.angularImpulse = clamp(old + impulse, -max, max);
      impulse = this.angularImpulse - old;
      a.angularVelocity -= a.invInertia * impulse;
      b.angularVelocity += b.invInertia * impulse;
    }

    // Linear drive (clamped to a force budget, magnitude-limited).
    {
      const cdot = b.linearVelocity
        .sub(a.linearVelocity)
        .add(this.linearError.mul(this.invDt * this.correctionFactor));
      let impulse = cdot.mul(-this.linearMass);
      const old = this.linearImpulse;
      this.linearImpulse = this.linearImpulse.add(impulse);
      const max = this.dt * this.maxForce;
      if (this.linearImpulse.lengthSq() > max * max) {
        this.linearImpulse = this.linearImpulse.normalize().mul(max);
      }
      impulse = this.linearImpulse.sub(old);
      a.linearVelocity = a.linearVelocity.sub(impulse.mul(a.invMass));
      b.linearVelocity = b.linearVelocity.add(impulse.mul(b.invMass));
    }
  }

  reactionForce(invDt: number): number {
    return this.linearImpulse.length() * invDt;
  }

  reactionTorque(invDt: number): number {
    return Math.abs(this.angularImpulse) * invDt;
  }

  anchorA(): Vec2 {
    return this.bodyA.worldCenter;
  }

  anchorB(): Vec2 {
    return this.bodyB.worldCenter;
  }
}
