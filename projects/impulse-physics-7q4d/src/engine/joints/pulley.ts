import { Body } from '../body';
import { crossSV, Vec2 } from '../math';
import { applyBodyImpulse, type Joint, type JointContext } from './joint';

/**
 * A pulley joint: two bodies hang from a rope routed over two fixed ground
 * anchors, so `lengthA + ratio·lengthB` is conserved — pull one side down and
 * the other rises (with a mechanical advantage of `ratio`). `lengthA` is the
 * distance from `groundAnchorA` to the rope's attachment on body A, likewise for
 * B. This is a faithful port of Box2D's `b2PulleyJoint` velocity solve, with a
 * Baumgarte position bias folded into the velocity target the way the rest of
 * this engine's joints handle drift.
 */
export class PulleyJoint implements Joint {
  readonly kind = 'pulley';
  readonly bodyA: Body;
  readonly bodyB: Body;
  readonly groundAnchorA: Vec2;
  readonly groundAnchorB: Vec2;
  readonly ratio: number;
  /** The conserved quantity `lengthA + ratio·lengthB`. */
  readonly totalLength: number;

  private localAnchorA: Vec2;
  private localAnchorB: Vec2;

  private rA = Vec2.ZERO;
  private rB = Vec2.ZERO;
  private uA = Vec2.ZERO;
  private uB = Vec2.ZERO;
  private mass = 0;
  private bias = 0;
  private impulse = 0;

  /** Optional breaking budget: the rope snaps when its tension exceeds this. */
  breakForce = Infinity;

  constructor(
    bodyA: Body,
    bodyB: Body,
    groundAnchorA: Vec2,
    groundAnchorB: Vec2,
    anchorA: Vec2,
    anchorB: Vec2,
    ratio = 1,
  ) {
    this.bodyA = bodyA;
    this.bodyB = bodyB;
    this.groundAnchorA = groundAnchorA;
    this.groundAnchorB = groundAnchorB;
    this.ratio = ratio;
    this.localAnchorA = bodyA.localPoint(anchorA);
    this.localAnchorB = bodyB.localPoint(anchorB);
    const lengthA = anchorA.distanceTo(groundAnchorA);
    const lengthB = anchorB.distanceTo(groundAnchorB);
    this.totalLength = lengthA + ratio * lengthB;
  }

  initVelocityConstraints(ctx: JointContext): void {
    const a = this.bodyA;
    const b = this.bodyB;
    this.rA = a.transform.q.apply(this.localAnchorA.sub(a.localCenter));
    this.rB = b.transform.q.apply(this.localAnchorB.sub(b.localCenter));

    const pA = a.worldCenter.add(this.rA);
    const pB = b.worldCenter.add(this.rB);
    const dA = pA.sub(this.groundAnchorA);
    const dB = pB.sub(this.groundAnchorB);
    const lengthA = dA.length();
    const lengthB = dB.length();
    this.uA = lengthA > 1e-5 ? dA.mul(1 / lengthA) : Vec2.ZERO;
    this.uB = lengthB > 1e-5 ? dB.mul(1 / lengthB) : Vec2.ZERO;

    const ruA = this.rA.cross(this.uA);
    const ruB = this.rB.cross(this.uB);
    const mA = a.invMass + a.invInertia * ruA * ruA;
    const mB = b.invMass + b.invInertia * ruB * ruB;
    const k = mA + this.ratio * this.ratio * mB;
    this.mass = k > 0 ? 1 / k : 0;

    // Baumgarte drift correction toward `lengthA + ratio·lengthB = totalLength`.
    const c = lengthA + this.ratio * lengthB - this.totalLength;
    this.bias = 0.2 * ctx.invDt * c;
  }

  warmStart(): void {
    const a = this.bodyA;
    const b = this.bodyB;
    const pA = this.uA.mul(-this.impulse);
    const pB = this.uB.mul(-this.ratio * this.impulse);
    applyBodyImpulse(a, pA, this.rA);
    applyBodyImpulse(b, pB, this.rB);
  }

  solveVelocity(): void {
    const a = this.bodyA;
    const b = this.bodyB;
    const vpA = a.linearVelocity.add(crossSV(a.angularVelocity, this.rA));
    const vpB = b.linearVelocity.add(crossSV(b.angularVelocity, this.rB));

    const cdot = -this.uA.dot(vpA) - this.ratio * this.uB.dot(vpB) - this.bias;
    const impulse = -this.mass * cdot;
    this.impulse += impulse;

    const pA = this.uA.mul(-impulse);
    const pB = this.uB.mul(-this.ratio * impulse);
    applyBodyImpulse(a, pA, this.rA);
    applyBodyImpulse(b, pB, this.rB);
  }

  /** Current rope length on side A (ground anchor → body A attachment). */
  lengthA(): number {
    return this.bodyA.worldPoint(this.localAnchorA).distanceTo(this.groundAnchorA);
  }

  /** Current rope length on side B (ground anchor → body B attachment). */
  lengthB(): number {
    return this.bodyB.worldPoint(this.localAnchorB).distanceTo(this.groundAnchorB);
  }

  reactionForce(invDt: number): number {
    return Math.abs(this.impulse) * invDt;
  }

  anchorA(): Vec2 {
    return this.bodyA.worldPoint(this.localAnchorA);
  }

  anchorB(): Vec2 {
    return this.bodyB.worldPoint(this.localAnchorB);
  }
}
