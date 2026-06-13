import { Body } from '../body';
import { crossSV, Mat22, Vec2 } from '../math';
import { softConstraint, type Joint, type JointContext } from './joint';

/**
 * A mouse joint drags a single body's anchor toward a moving `target` with a
 * capped soft constraint — the spring you feel when grabbing and flinging a body
 * with the cursor. It connects the body to "the world", so only the body moves.
 */
export class MouseJoint implements Joint {
  readonly kind = 'mouse';
  readonly bodyA: Body;
  readonly bodyB: Body;
  private localAnchor: Vec2;
  target: Vec2;
  maxForce: number;
  frequencyHz = 5;
  dampingRatio = 0.7;

  private rB = Vec2.ZERO;
  private mass = new Mat22();
  private bias = Vec2.ZERO;
  private gamma = 0;
  private impulse = Vec2.ZERO;
  private maxImpulse = 0;

  constructor(body: Body, target: Vec2, maxForce: number) {
    this.bodyA = body;
    this.bodyB = body;
    this.localAnchor = body.localPoint(target);
    this.target = target;
    this.maxForce = maxForce;
  }

  initVelocityConstraints(ctx: JointContext): void {
    const b = this.bodyB;
    this.rB = b.transform.q.apply(this.localAnchor.sub(b.localCenter));

    const soft = softConstraint(this.frequencyHz, this.dampingRatio, b.mass, ctx.dt);
    this.gamma = soft.gamma;
    this.maxImpulse = ctx.dt * this.maxForce;
    const c = b.worldCenter.add(this.rB).sub(this.target);
    this.bias = c.mul(soft.biasFactor);

    const mB = b.invMass;
    const iB = b.invInertia;
    const k11 = mB + iB * this.rB.y * this.rB.y + this.gamma;
    const k12 = -iB * this.rB.x * this.rB.y;
    const k22 = mB + iB * this.rB.x * this.rB.x + this.gamma;
    this.mass = new Mat22(k11, k12, k12, k22);
  }

  warmStart(): void {
    const b = this.bodyB;
    b.linearVelocity = b.linearVelocity.add(this.impulse.mul(b.invMass));
    b.angularVelocity += b.invInertia * this.rB.cross(this.impulse);
  }

  solveVelocity(): void {
    const b = this.bodyB;
    const cdot = b.linearVelocity.add(crossSV(b.angularVelocity, this.rB));
    const rhs = cdot.add(this.bias).add(this.impulse.mul(this.gamma)).neg();
    let impulse = this.mass.solve(rhs);

    const old = this.impulse;
    this.impulse = this.impulse.add(impulse);
    const max = this.maxImpulse;
    if (this.impulse.lengthSq() > max * max) {
      this.impulse = this.impulse.normalize().mul(max);
    }
    impulse = this.impulse.sub(old);

    b.linearVelocity = b.linearVelocity.add(impulse.mul(b.invMass));
    b.angularVelocity += b.invInertia * this.rB.cross(impulse);
  }

  anchorA(): Vec2 {
    return this.target;
  }

  anchorB(): Vec2 {
    return this.bodyB.worldPoint(this.localAnchor);
  }
}
