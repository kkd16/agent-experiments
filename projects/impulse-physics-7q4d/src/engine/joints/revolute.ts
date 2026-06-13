import { Body } from '../body';
import { Mat22, Vec2 } from '../math';
import { applyBodyImpulse, pointVelocityDelta, type Joint, type JointContext } from './joint';

/**
 * A revolute (pin) joint: two anchor points are forced to coincide while the
 * bodies are free to rotate about the shared point. The 2-DOF point-to-point
 * constraint is solved with a 2×2 effective-mass matrix.
 */
export class RevoluteJoint implements Joint {
  readonly kind = 'revolute';
  readonly bodyA: Body;
  readonly bodyB: Body;
  private localAnchorA: Vec2;
  private localAnchorB: Vec2;

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
  private motorMass = 0;

  constructor(bodyA: Body, bodyB: Body, worldAnchor: Vec2) {
    this.bodyA = bodyA;
    this.bodyB = bodyB;
    this.localAnchorA = bodyA.localPoint(worldAnchor);
    this.localAnchorB = bodyB.localPoint(worldAnchor);
  }

  initVelocityConstraints(ctx: JointContext): void {
    const a = this.bodyA;
    const b = this.bodyB;
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

    this.motorMass = iA + iB > 0 ? 1 / (iA + iB) : 0;
    if (!this.enableMotor) this.motorImpulse = 0;

    // Baumgarte positional bias from the current separation of the anchors.
    const pA = a.worldCenter.add(this.rA);
    const pB = b.worldCenter.add(this.rB);
    this.bias = pB.sub(pA).mul(0.2 * ctx.invDt);
  }

  warmStart(): void {
    applyBodyImpulse(this.bodyA, this.impulse.neg(), this.rA);
    applyBodyImpulse(this.bodyB, this.impulse, this.rB);
    this.bodyA.angularVelocity -= this.bodyA.invInertia * this.motorImpulse;
    this.bodyB.angularVelocity += this.bodyB.invInertia * this.motorImpulse;
  }

  solveVelocity(): void {
    const a = this.bodyA;
    const b = this.bodyB;

    if (this.enableMotor && this.motorMass > 0) {
      const cdot = b.angularVelocity - a.angularVelocity - this.motorSpeed;
      let impulse = -this.motorMass * cdot;
      const old = this.motorImpulse;
      const max = this.maxMotorTorque;
      this.motorImpulse = Math.max(-max, Math.min(max, old + impulse));
      impulse = this.motorImpulse - old;
      a.angularVelocity -= a.invInertia * impulse;
      b.angularVelocity += b.invInertia * impulse;
    }

    const cdot = pointVelocityDelta(a, b, this.rA, this.rB).add(this.bias);
    const impulse = this.mass.solve(cdot.neg());
    this.impulse = this.impulse.add(impulse);
    applyBodyImpulse(a, impulse.neg(), this.rA);
    applyBodyImpulse(b, impulse, this.rB);
  }

  anchorA(): Vec2 {
    return this.bodyA.worldPoint(this.localAnchorA);
  }

  anchorB(): Vec2 {
    return this.bodyB.worldPoint(this.localAnchorB);
  }
}
