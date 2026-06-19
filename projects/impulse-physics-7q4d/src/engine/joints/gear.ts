import { Body } from '../body';
import { Vec2 } from '../math';
import { type Joint } from './joint';
import { PrismaticJoint } from './prismatic';
import { RevoluteJoint } from './revolute';

/** A joint a {@link GearJoint} can couple: a revolute or a prismatic. */
export type GearableJoint = RevoluteJoint | PrismaticJoint;

/** Per-side Jacobian + generalized coordinate of one coupled sub-joint. */
interface SideData {
  Jv: Vec2;
  JwGround: number;
  JwGear: number;
  coordinate: number;
  massTerm: number;
}

/**
 * A gear joint couples two other joints (each a revolute or a prismatic) that
 * share a common ground body, enforcing
 *
 *   coordinate₁ + ratio · coordinate₂ = constant
 *
 * where a revolute's coordinate is its relative angle and a prismatic's is its
 * slider translation. With two revolutes this is a gear train (a +ratio meshes
 * gears spinning *opposite* ways, like real teeth); mixing a revolute and a
 * prismatic gives a rack-and-pinion. This is a port of Box2D's `b2GearJoint`
 * velocity solve, with a Baumgarte drift term folded into the velocity target
 * (this engine has no separate joint position pass).
 *
 * The two coupled sub-joints must already be added to the world. Add the gear
 * joint *after* them.
 */
export class GearJoint implements Joint {
  readonly kind = 'gear';
  /** The gear driven by joint 1 (its dynamic body). */
  readonly bodyA: Body;
  /** The gear driven by joint 2 (its dynamic body). */
  readonly bodyB: Body;
  /** The ground body of joint 1. */
  readonly bodyC: Body;
  /** The ground body of joint 2. */
  readonly bodyD: Body;
  readonly ratio: number;
  readonly joint1: GearableJoint;
  readonly joint2: GearableJoint;

  // Effective Jacobians for the current step (ratio baked into side 2).
  private JvAC = Vec2.ZERO;
  private JwA = 0;
  private JwC = 0;
  private JvBD = Vec2.ZERO;
  private JwB = 0;
  private JwD = 0;
  private mass = 0;
  private impulse = 0;

  constructor(joint1: GearableJoint, joint2: GearableJoint, ratio = 1) {
    this.joint1 = joint1;
    this.joint2 = joint2;
    this.ratio = ratio;
    // joint.bodyA is the ground side, joint.bodyB the moving gear (the same
    // convention the scenes use when building the sub-joints).
    this.bodyC = joint1.bodyA;
    this.bodyA = joint1.bodyB;
    this.bodyD = joint2.bodyA;
    this.bodyB = joint2.bodyB;
  }

  initVelocityConstraints(): void {
    const s1 = sideData(this.joint1, this.bodyC, this.bodyA);
    const s2 = sideData(this.joint2, this.bodyD, this.bodyB);

    this.JvAC = s1.Jv;
    this.JwA = s1.JwGear;
    this.JwC = s1.JwGround;
    this.JvBD = s2.Jv.mul(this.ratio);
    this.JwB = this.ratio * s2.JwGear;
    this.JwD = this.ratio * s2.JwGround;

    const mass = s1.massTerm + this.ratio * this.ratio * s2.massTerm;
    this.mass = mass > 0 ? 1 / mass : 0;
    // No Baumgarte position bias: a revolute coordinate is the body's wrapping
    // angle, so a freely-spinning gear would make `C` jump by 2π every half turn
    // and inject a huge bias spike. The velocity-level coupling already holds the
    // ratio exactly; phase drift is irrelevant for meshed gears.
  }

  warmStart(): void {
    this.applyImpulse(this.impulse);
  }

  solveVelocity(): void {
    const A = this.bodyA;
    const B = this.bodyB;
    const C = this.bodyC;
    const D = this.bodyD;
    const cdot =
      this.JvAC.dot(A.linearVelocity.sub(C.linearVelocity)) +
      this.JvBD.dot(B.linearVelocity.sub(D.linearVelocity)) +
      (this.JwA * A.angularVelocity - this.JwC * C.angularVelocity) +
      (this.JwB * B.angularVelocity - this.JwD * D.angularVelocity);
    const impulse = -this.mass * cdot;
    this.impulse += impulse;
    this.applyImpulse(impulse);
  }

  private applyImpulse(impulse: number): void {
    const A = this.bodyA;
    const B = this.bodyB;
    const C = this.bodyC;
    const D = this.bodyD;
    A.linearVelocity = A.linearVelocity.add(this.JvAC.mul(A.invMass * impulse));
    A.angularVelocity += A.invInertia * impulse * this.JwA;
    C.linearVelocity = C.linearVelocity.sub(this.JvAC.mul(C.invMass * impulse));
    C.angularVelocity -= C.invInertia * impulse * this.JwC;
    B.linearVelocity = B.linearVelocity.add(this.JvBD.mul(B.invMass * impulse));
    B.angularVelocity += B.invInertia * impulse * this.JwB;
    D.linearVelocity = D.linearVelocity.sub(this.JvBD.mul(D.invMass * impulse));
    D.angularVelocity -= D.invInertia * impulse * this.JwD;
  }

  anchorA(): Vec2 {
    return this.bodyA.worldCenter;
  }

  anchorB(): Vec2 {
    return this.bodyB.worldCenter;
  }
}

/**
 * The Jacobian, generalized coordinate and effective-mass contribution of one
 * coupled sub-joint, expressed against its ground body and its driven gear.
 */
function sideData(joint: GearableJoint, ground: Body, gear: Body): SideData {
  if (joint instanceof RevoluteJoint) {
    return {
      Jv: Vec2.ZERO,
      JwGround: 1,
      JwGear: 1,
      coordinate: gear.angle - ground.angle - joint.gearReferenceAngle(),
      massTerm: ground.invInertia + gear.invInertia,
    };
  }
  // Prismatic: the slider axis lives in the ground body's frame.
  const u = ground.transform.q.apply(joint.gearLocalAxisA());
  const rGround = ground.transform.q.apply(joint.gearLocalAnchorA().sub(ground.localCenter));
  const rGear = gear.transform.q.apply(joint.gearLocalAnchorB().sub(gear.localCenter));
  const d = gear.worldCenter.add(rGear).sub(ground.worldCenter.add(rGround));
  const JwGround = d.add(rGround).cross(u);
  const JwGear = rGear.cross(u);
  return {
    Jv: u,
    JwGround,
    JwGear,
    coordinate: u.dot(d),
    massTerm:
      ground.invMass +
      gear.invMass +
      ground.invInertia * JwGround * JwGround +
      gear.invInertia * JwGear * JwGear,
  };
}
