import { Body } from '../body';
import { crossSV, Vec2 } from '../math';

/** Step context passed to every joint when it initializes its constraints. */
export interface JointContext {
  dt: number;
  invDt: number;
}

/**
 * A bilateral constraint between two bodies, solved with the same
 * sequential-impulse machinery as contacts. Each joint precomputes its
 * effective mass and bias once per step, optionally warm-starts from the last
 * frame's impulse, then is relaxed across the velocity iterations.
 */
export interface Joint {
  readonly kind: string;
  readonly bodyA: Body;
  readonly bodyB: Body;
  initVelocityConstraints(ctx: JointContext): void;
  warmStart(): void;
  solveVelocity(): void;
  /** World-space anchor on body A, for rendering. */
  anchorA(): Vec2;
  /** World-space anchor on body B, for rendering. */
  anchorB(): Vec2;
}

/** Apply an impulse pair to a body about offset `r` from its center of mass. */
export function applyBodyImpulse(body: Body, impulse: Vec2, r: Vec2): void {
  body.linearVelocity = body.linearVelocity.add(impulse.mul(body.invMass));
  body.angularVelocity += body.invInertia * r.cross(impulse);
}

/** Relative velocity of point `rB` on B minus point `rA` on A. */
export function pointVelocityDelta(a: Body, b: Body, rA: Vec2, rB: Vec2): Vec2 {
  const vA = a.linearVelocity.add(crossSV(a.angularVelocity, rA));
  const vB = b.linearVelocity.add(crossSV(b.angularVelocity, rB));
  return vB.sub(vA);
}

/**
 * Soft-constraint coefficients (Box2D's mass-spring-damper formulation). Turns a
 * frequency/damping pair into the `gamma` (regularization) and `biasFactor`
 * used to make a constraint behave like a spring instead of a rigid rod.
 */
export function softConstraint(
  frequencyHz: number,
  dampingRatio: number,
  mass: number,
  dt: number,
): { gamma: number; biasFactor: number } {
  if (frequencyHz <= 0 || mass <= 0) return { gamma: 0, biasFactor: 0 };
  const omega = 2 * Math.PI * frequencyHz;
  const d = 2 * mass * dampingRatio * omega; // damping
  const k = mass * omega * omega; // stiffness
  const gamma = dt * (d + dt * k);
  const invGamma = gamma > 0 ? 1 / gamma : 0;
  return { gamma: invGamma, biasFactor: dt * k * invGamma };
}
