import { Body } from '../body';
import { clamp, Mat22, Vec2 } from '../math';
import { applyBodyImpulse, pointVelocityDelta, type Joint, type JointContext } from './joint';

/**
 * A revolute (pin) joint: two anchor points are forced to coincide while the
 * bodies are free to rotate about the shared point. The 2-DOF point-to-point
 * constraint is solved with a 2×2 effective-mass matrix. An optional motor
 * drives the relative angular velocity, and optional angle limits clamp the
 * relative rotation (a door, a crane, a knee) using speculative one-sided
 * constraints that coexist with the motor.
 */
export class RevoluteJoint implements Joint {
  readonly kind = 'revolute';
  readonly bodyA: Body;
  readonly bodyB: Body;
  private localAnchorA: Vec2;
  private localAnchorB: Vec2;
  private referenceAngle: number;

  private rA = Vec2.ZERO;
  private rB = Vec2.ZERO;
  private mass = new Mat22();
  private bias = Vec2.ZERO;
  private impulse = Vec2.ZERO;

  /** Optional motor that drives relative angular velocity toward `motorSpeed`. */
  enableMotor = false;
  motorSpeed = 0;
  maxMotorTorque = 0;
  private motorImpulse = 0;

  /** Optional angle limits on the relative rotation (radians). */
  enableLimit = false;
  lowerAngle = 0;
  upperAngle = 0;
  private lowerImpulse = 0;
  private upperImpulse = 0;

  private axialMass = 0;
  private angle = 0;
  private invDt = 0;

  constructor(bodyA: Body, bodyB: Body, worldAnchor: Vec2) {
    this.bodyA = bodyA;
    this.bodyB = bodyB;
    this.localAnchorA = bodyA.localPoint(worldAnchor);
    this.localAnchorB = bodyB.localPoint(worldAnchor);
    this.referenceAngle = bodyB.angle - bodyA.angle;
  }

  /** Configure the angle limits in one call (relative to the reference angle). */
  setLimits(lower: number, upper: number): this {
    this.enableLimit = true;
    this.lowerAngle = lower;
    this.upperAngle = upper;
    return this;
  }

  initVelocityConstraints(ctx: JointContext): void {
    const a = this.bodyA;
    const b = this.bodyB;
    this.invDt = ctx.invDt;
    this.rA = a.transform.q.apply(this.localAnchorA.sub(a.localCenter));
    this.rB = b.transform.q.apply(this.localAnchorB.sub(b.localCenter));

    // K = invMass·I + skew(r) terms. Symmetric 2×2.
    const mA = a.invMass;
    const mB = b.invMass;
    const iA = a.invInertia;
    const iB = b.invInertia;
    const k11 = mA + mB + iA * this.rA.y * this.rA.y + iB * this.rB.y * this.rB.y;
    const k12 = -iA * this.rA.x * this.rA.y - iB * this.rB.x * this.rB.y;
    const k22 = mA + mB + iA * this.rA.x * this.rA.x + iB * this.rB.x * this.rB.x;
    this.mass = new Mat22(k11, k12, k12, k22);

    this.axialMass = iA + iB > 0 ? 1 / (iA + iB) : 0;
    this.angle = b.angle - a.angle - this.referenceAngle;
    if (!this.enableMotor) this.motorImpulse = 0;
    if (!this.enableLimit) {
      this.lowerImpulse = 0;
      this.upperImpulse = 0;
    }

    // Baumgarte positional bias from the current separation of the anchors.
    const pA = a.worldCenter.add(this.rA);
    const pB = b.worldCenter.add(this.rB);
    this.bias = pB.sub(pA).mul(0.2 * ctx.invDt);
  }

  warmStart(): void {
    const a = this.bodyA;
    const b = this.bodyB;
    applyBodyImpulse(a, this.impulse.neg(), this.rA);
    applyBodyImpulse(b, this.impulse, this.rB);
    const axial = this.motorImpulse + this.lowerImpulse - this.upperImpulse;
    a.angularVelocity -= a.invInertia * axial;
    b.angularVelocity += b.invInertia * axial;
  }

  solveVelocity(): void {
    const a = this.bodyA;
    const b = this.bodyB;
    const iA = a.invInertia;
    const iB = b.invInertia;

    // Motor.
    if (this.enableMotor && this.axialMass > 0) {
      const cdot = b.angularVelocity - a.angularVelocity - this.motorSpeed;
      let impulse = -this.axialMass * cdot;
      const old = this.motorImpulse;
      const max = this.maxMotorTorque;
      this.motorImpulse = clamp(old + impulse, -max, max);
      impulse = this.motorImpulse - old;
      a.angularVelocity -= iA * impulse;
      b.angularVelocity += iB * impulse;
    }

    // Angle limits (speculative one-sided constraints).
    if (this.enableLimit && this.axialMass > 0) {
      // Lower limit: C = angle - lower ≥ 0.
      {
        const c = this.angle - this.lowerAngle;
        const cdot = b.angularVelocity - a.angularVelocity;
        let impulse = -this.axialMass * (cdot + Math.max(c, 0) * this.invDt);
        const old = this.lowerImpulse;
        this.lowerImpulse = Math.max(old + impulse, 0);
        impulse = this.lowerImpulse - old;
        a.angularVelocity -= iA * impulse;
        b.angularVelocity += iB * impulse;
      }
      // Upper limit: C = upper - angle ≥ 0.
      {
        const c = this.upperAngle - this.angle;
        const cdot = a.angularVelocity - b.angularVelocity;
        let impulse = -this.axialMass * (cdot + Math.max(c, 0) * this.invDt);
        const old = this.upperImpulse;
        this.upperImpulse = Math.max(old + impulse, 0);
        impulse = this.upperImpulse - old;
        a.angularVelocity += iA * impulse;
        b.angularVelocity -= iB * impulse;
      }
    }

    const cdot = pointVelocityDelta(a, b, this.rA, this.rB).add(this.bias);
    const impulse = this.mass.solve(cdot.neg());
    this.impulse = this.impulse.add(impulse);
    applyBodyImpulse(a, impulse.neg(), this.rA);
    applyBodyImpulse(b, impulse, this.rB);
  }

  /** Current relative angle (radians) about the pivot, for the UI. */
  jointAngle(): number {
    return this.bodyB.angle - this.bodyA.angle - this.referenceAngle;
  }

  anchorA(): Vec2 {
    return this.bodyA.worldPoint(this.localAnchorA);
  }

  anchorB(): Vec2 {
    return this.bodyB.worldPoint(this.localAnchorB);
  }
}
