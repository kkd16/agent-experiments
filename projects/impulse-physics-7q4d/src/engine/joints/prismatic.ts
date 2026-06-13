import { Body } from '../body';
import { Mat22, Vec2 } from '../math';
import { type Joint, type JointContext } from './joint';

/**
 * A prismatic (slider) joint constrains two bodies to translate along a single
 * shared axis with no relative rotation. The perpendicular-translation and
 * angular constraints are coupled in a 2×2 block; an optional motor drives
 * motion along the axis (elevators, pistons, suspension travel).
 */
export class PrismaticJoint implements Joint {
  readonly kind = 'prismatic';
  readonly bodyA: Body;
  readonly bodyB: Body;
  private localAnchorA: Vec2;
  private localAnchorB: Vec2;
  private localAxisA: Vec2;
  private localPerpA: Vec2;
  private referenceAngle: number;

  enableMotor = false;
  motorSpeed = 0;
  maxMotorForce = 0;

  private rA = Vec2.ZERO;
  private rB = Vec2.ZERO;
  private axis = Vec2.ZERO;
  private perp = Vec2.ZERO;
  private s1 = 0;
  private s2 = 0;
  private a1 = 0;
  private a2 = 0;
  private k = new Mat22();
  private motorMass = 0;
  private bias = Vec2.ZERO;
  private impulse = Vec2.ZERO; // (perpendicular, angular)
  private motorImpulse = 0;

  constructor(bodyA: Body, bodyB: Body, worldAnchor: Vec2, worldAxis: Vec2) {
    this.bodyA = bodyA;
    this.bodyB = bodyB;
    this.localAnchorA = bodyA.localPoint(worldAnchor);
    this.localAnchorB = bodyB.localPoint(worldAnchor);
    const axis = worldAxis.normalize();
    this.localAxisA = bodyA.transform.q.applyT(axis);
    this.localPerpA = this.localAxisA.perp();
    this.referenceAngle = bodyB.angle - bodyA.angle;
  }

  initVelocityConstraints(ctx: JointContext): void {
    const a = this.bodyA;
    const b = this.bodyB;
    this.rA = a.transform.q.apply(this.localAnchorA.sub(a.localCenter));
    this.rB = b.transform.q.apply(this.localAnchorB.sub(b.localCenter));
    const d = b.worldCenter.add(this.rB).sub(a.worldCenter.add(this.rA));

    this.axis = a.transform.q.apply(this.localAxisA);
    this.perp = a.transform.q.apply(this.localPerpA);

    this.a1 = d.add(this.rA).cross(this.axis);
    this.a2 = this.rB.cross(this.axis);
    this.s1 = d.add(this.rA).cross(this.perp);
    this.s2 = this.rB.cross(this.perp);

    const mA = a.invMass;
    const mB = b.invMass;
    const iA = a.invInertia;
    const iB = b.invInertia;

    const k11 = mA + mB + iA * this.s1 * this.s1 + iB * this.s2 * this.s2;
    const k12 = iA * this.s1 + iB * this.s2;
    let k22 = iA + iB;
    if (k22 === 0) k22 = 1; // both bodies rotationally locked
    this.k = new Mat22(k11, k12, k12, k22);

    const motorK = mA + mB + iA * this.a1 * this.a1 + iB * this.a2 * this.a2;
    this.motorMass = motorK > 0 ? 1 / motorK : 0;
    if (!this.enableMotor) this.motorImpulse = 0;

    // Positional bias: perpendicular drift and angular drift.
    const c1 = d.dot(this.perp);
    const c2 = b.angle - a.angle - this.referenceAngle;
    this.bias = new Vec2(c1, c2).mul(0.2 * ctx.invDt);
  }

  warmStart(): void {
    const a = this.bodyA;
    const b = this.bodyB;
    const P = this.perp.mul(this.impulse.x).add(this.axis.mul(this.motorImpulse));
    const lA = this.impulse.x * this.s1 + this.impulse.y + this.motorImpulse * this.a1;
    const lB = this.impulse.x * this.s2 + this.impulse.y + this.motorImpulse * this.a2;
    a.linearVelocity = a.linearVelocity.sub(P.mul(a.invMass));
    a.angularVelocity -= a.invInertia * lA;
    b.linearVelocity = b.linearVelocity.add(P.mul(b.invMass));
    b.angularVelocity += b.invInertia * lB;
  }

  solveVelocity(): void {
    const a = this.bodyA;
    const b = this.bodyB;

    // Motor along the axis.
    if (this.enableMotor && this.motorMass > 0) {
      const cdot =
        this.axis.dot(b.linearVelocity.sub(a.linearVelocity)) +
        this.a2 * b.angularVelocity -
        this.a1 * a.angularVelocity;
      let impulse = this.motorMass * (this.motorSpeed - cdot);
      const old = this.motorImpulse;
      const max = this.maxMotorForce; // already a force·dt-scaled budget
      this.motorImpulse = Math.max(-max, Math.min(max, old + impulse));
      impulse = this.motorImpulse - old;
      const P = this.axis.mul(impulse);
      a.linearVelocity = a.linearVelocity.sub(P.mul(a.invMass));
      a.angularVelocity -= a.invInertia * impulse * this.a1;
      b.linearVelocity = b.linearVelocity.add(P.mul(b.invMass));
      b.angularVelocity += b.invInertia * impulse * this.a2;
    }

    // Coupled perpendicular + angular constraint.
    const cdot1 =
      this.perp.dot(b.linearVelocity.sub(a.linearVelocity)) +
      this.s2 * b.angularVelocity -
      this.s1 * a.angularVelocity;
    const cdot2 = b.angularVelocity - a.angularVelocity;
    const cdot = new Vec2(cdot1, cdot2).add(this.bias);
    const df = this.k.solve(cdot.neg());
    this.impulse = this.impulse.add(df);

    const P = this.perp.mul(df.x);
    const lA = df.x * this.s1 + df.y;
    const lB = df.x * this.s2 + df.y;
    a.linearVelocity = a.linearVelocity.sub(P.mul(a.invMass));
    a.angularVelocity -= a.invInertia * lA;
    b.linearVelocity = b.linearVelocity.add(P.mul(b.invMass));
    b.angularVelocity += b.invInertia * lB;
  }

  anchorA(): Vec2 {
    return this.bodyA.worldPoint(this.localAnchorA);
  }

  anchorB(): Vec2 {
    return this.bodyB.worldPoint(this.localAnchorB);
  }
}
