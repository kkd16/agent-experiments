import { Body } from '../body';
import { Vec2 } from '../math';
import { type Joint, type JointContext } from './joint';

/**
 * A wheel joint — the constraint behind a car suspension. Body B (the wheel) is
 * pinned to a line through the anchor on body A (the chassis): the perpendicular
 * offset is held rigidly, while motion *along* the axis is governed by a
 * mass-spring-damper (the suspension travel). An optional angular motor drives
 * the wheel about its centre for propulsion. This is Box2D's formulation,
 * implemented from first principles.
 */
export class WheelJoint implements Joint {
  readonly kind = 'wheel';
  readonly bodyA: Body;
  readonly bodyB: Body;
  private localAnchorA: Vec2;
  private localAnchorB: Vec2;
  private localXAxisA: Vec2; // suspension axis (in A's frame)
  private localYAxisA: Vec2; // perpendicular (the hard line constraint)

  /** Suspension spring frequency (Hz). 0 disables the spring (rigid axis). */
  frequencyHz = 4;
  /** Suspension damping ratio (1 = critically damped). */
  dampingRatio = 0.7;

  enableMotor = false;
  motorSpeed = 0;
  maxMotorTorque = 0;

  // Cached per-step solver data.
  private ax = Vec2.ZERO;
  private ay = Vec2.ZERO;
  private sAx = 0;
  private sBx = 0;
  private sAy = 0;
  private sBy = 0;
  private mass = 0; // perpendicular (hard) effective mass
  private springMass = 0;
  private motorMass = 0;
  private bias = 0;
  private gamma = 0;
  private impulse = 0; // perpendicular constraint impulse
  private springImpulse = 0; // suspension axis impulse
  private motorImpulse = 0;

  constructor(bodyA: Body, bodyB: Body, worldAnchor: Vec2, worldAxis: Vec2) {
    this.bodyA = bodyA;
    this.bodyB = bodyB;
    this.localAnchorA = bodyA.localPoint(worldAnchor);
    this.localAnchorB = bodyB.localPoint(worldAnchor);
    const axis = worldAxis.normalize();
    this.localXAxisA = bodyA.transform.q.applyT(axis);
    this.localYAxisA = this.localXAxisA.perp();
  }

  initVelocityConstraints(ctx: JointContext): void {
    const a = this.bodyA;
    const b = this.bodyB;
    const mA = a.invMass;
    const mB = b.invMass;
    const iA = a.invInertia;
    const iB = b.invInertia;

    const rA = a.transform.q.apply(this.localAnchorA.sub(a.localCenter));
    const rB = b.transform.q.apply(this.localAnchorB.sub(b.localCenter));
    const d = b.worldCenter.add(rB).sub(a.worldCenter.add(rA));

    // Perpendicular (hard) point-on-line constraint.
    this.ay = a.transform.q.apply(this.localYAxisA);
    this.sAy = d.add(rA).cross(this.ay);
    this.sBy = rB.cross(this.ay);
    let k = mA + mB + iA * this.sAy * this.sAy + iB * this.sBy * this.sBy;
    this.mass = k > 0 ? 1 / k : 0;

    // Suspension spring along the axis.
    this.ax = a.transform.q.apply(this.localXAxisA);
    this.sAx = d.add(rA).cross(this.ax);
    this.sBx = rB.cross(this.ax);
    const springInvMass = mA + mB + iA * this.sAx * this.sAx + iB * this.sBx * this.sBx;
    this.springMass = 0;
    this.bias = 0;
    this.gamma = 0;
    if (springInvMass > 0 && this.frequencyHz > 0) {
      const baseMass = 1 / springInvMass;
      const C = d.dot(this.ax); // suspension offset from the rest line
      const omega = 2 * Math.PI * this.frequencyHz;
      const damp = 2 * baseMass * this.dampingRatio * omega;
      const stiffness = baseMass * omega * omega;
      const h = ctx.dt;
      this.gamma = h * (damp + h * stiffness);
      this.gamma = this.gamma > 0 ? 1 / this.gamma : 0;
      this.bias = C * h * stiffness * this.gamma;
      k = springInvMass + this.gamma;
      this.springMass = k > 0 ? 1 / k : 0;
    } else {
      this.springImpulse = 0;
    }

    // Drive motor about the wheel centre.
    this.motorMass = iA + iB > 0 ? 1 / (iA + iB) : 0;
    if (!this.enableMotor) this.motorImpulse = 0;
  }

  warmStart(): void {
    const a = this.bodyA;
    const b = this.bodyB;
    const P = this.ay.mul(this.impulse).add(this.ax.mul(this.springImpulse));
    const LA = this.impulse * this.sAy + this.springImpulse * this.sAx + this.motorImpulse;
    const LB = this.impulse * this.sBy + this.springImpulse * this.sBx + this.motorImpulse;
    a.linearVelocity = a.linearVelocity.sub(P.mul(a.invMass));
    a.angularVelocity -= a.invInertia * LA;
    b.linearVelocity = b.linearVelocity.add(P.mul(b.invMass));
    b.angularVelocity += b.invInertia * LB;
  }

  solveVelocity(): void {
    const a = this.bodyA;
    const b = this.bodyB;
    const mA = a.invMass;
    const mB = b.invMass;
    const iA = a.invInertia;
    const iB = b.invInertia;

    // Suspension spring (axis).
    {
      const cdot =
        this.ax.dot(b.linearVelocity.sub(a.linearVelocity)) +
        this.sBx * b.angularVelocity -
        this.sAx * a.angularVelocity;
      const impulse = -this.springMass * (cdot + this.bias + this.gamma * this.springImpulse);
      this.springImpulse += impulse;
      const P = this.ax.mul(impulse);
      a.linearVelocity = a.linearVelocity.sub(P.mul(mA));
      a.angularVelocity -= iA * impulse * this.sAx;
      b.linearVelocity = b.linearVelocity.add(P.mul(mB));
      b.angularVelocity += iB * impulse * this.sBx;
    }

    // Motor.
    if (this.enableMotor && this.motorMass > 0) {
      const cdot = b.angularVelocity - a.angularVelocity - this.motorSpeed;
      let impulse = -this.motorMass * cdot;
      const old = this.motorImpulse;
      const max = this.maxMotorTorque; // already a torque·dt budget supplied by the scene
      this.motorImpulse = Math.max(-max, Math.min(max, old + impulse));
      impulse = this.motorImpulse - old;
      a.angularVelocity -= iA * impulse;
      b.angularVelocity += iB * impulse;
    }

    // Perpendicular (hard) line constraint.
    {
      const cdot =
        this.ay.dot(b.linearVelocity.sub(a.linearVelocity)) +
        this.sBy * b.angularVelocity -
        this.sAy * a.angularVelocity;
      const impulse = -this.mass * cdot;
      this.impulse += impulse;
      const P = this.ay.mul(impulse);
      a.linearVelocity = a.linearVelocity.sub(P.mul(mA));
      a.angularVelocity -= iA * impulse * this.sAy;
      b.linearVelocity = b.linearVelocity.add(P.mul(mB));
      b.angularVelocity += iB * impulse * this.sBy;
    }
  }

  anchorA(): Vec2 {
    return this.bodyA.worldPoint(this.localAnchorA);
  }

  anchorB(): Vec2 {
    return this.bodyB.worldPoint(this.localAnchorB);
  }
}
