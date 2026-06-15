import { AABB } from './aabb';
import { crossSV, Rot, Transform, Vec2 } from './math';
import { computeAABB, computeMass, type Shape } from './shapes';

/** Static = infinite mass & fixed; Dynamic = simulated; Kinematic = scripted velocity. */
export const BodyType = {
  Static: 0,
  Dynamic: 1,
  Kinematic: 2,
} as const;
export type BodyType = (typeof BodyType)[keyof typeof BodyType];

export interface BodyDef {
  type?: BodyType;
  position?: Vec2;
  angle?: number;
  linearVelocity?: Vec2;
  angularVelocity?: number;
  density?: number;
  friction?: number;
  restitution?: number;
  linearDamping?: number;
  angularDamping?: number;
  gravityScale?: number;
  /** Bodies that never sleep (e.g. the player-controlled paddle). */
  allowSleep?: boolean;
  /**
   * Enable continuous collision detection for this body. Fast/thin "bullet"
   * bodies are swept to their time of impact each step so they cannot tunnel
   * through thin geometry.
   */
  bullet?: boolean;
  /**
   * A sensor detects overlaps and fires begin/end contact events but is never
   * resolved by the solver — bodies pass straight through it. Use it for trigger
   * zones, goals and detectors.
   */
  isSensor?: boolean;
  /** Free-form tag used by scenes and the renderer for coloring. */
  color?: string;
}

let nextBodyId = 1;

/**
 * A rigid body: a shape with a transform, velocity and material properties.
 *
 * Positions are tracked at the center of mass (`worldCenter`) while the public
 * `transform` keeps the body origin so local shape coordinates stay stable.
 * This split — straight out of the Box2D playbook — is what lets the constraint
 * solver reason purely about the center of mass.
 */
export class Body {
  readonly id: number;
  readonly shape: Shape;
  type: BodyType;

  /** World transform of the body origin (not the center of mass). */
  transform: Transform;
  /** Center of mass in local coordinates. */
  localCenter: Vec2;
  /** Center of mass in world coordinates (kept in sync with `transform`). */
  worldCenter: Vec2;

  linearVelocity: Vec2;
  angularVelocity: number;

  /**
   * Pseudo-velocities used by split-impulse position correction. These move the
   * body to remove penetration without ever entering the real velocity, so they
   * add no kinetic energy and leave resting bodies truly still (and able to
   * sleep). They are reset to zero every step.
   */
  pseudoLinear: Vec2 = Vec2.ZERO;
  pseudoAngular = 0;

  force: Vec2 = Vec2.ZERO;
  torque = 0;

  mass = 0;
  invMass = 0;
  inertia = 0;
  invInertia = 0;

  density: number;
  friction: number;
  restitution: number;
  linearDamping: number;
  angularDamping: number;
  gravityScale: number;

  allowSleep: boolean;
  awake = true;
  sleepTime = 0;

  /** Continuous-collision flag (swept to time of impact each step). */
  bullet: boolean;
  /** Sensor flag: contacts are detected & reported but never solved. */
  isSensor: boolean;
  /** Center of mass / angle captured at the start of the step, for CCD sweeps. */
  center0: Vec2;
  angle0 = 0;

  color: string;

  /** Broadphase proxy id, assigned when the body is added to the world. */
  proxyId = -1;

  constructor(shape: Shape, def: BodyDef = {}) {
    this.id = nextBodyId++;
    this.shape = shape;
    this.type = def.type ?? BodyType.Dynamic;
    this.transform = new Transform(def.position ?? Vec2.ZERO, Rot.fromAngle(def.angle ?? 0));
    this.linearVelocity = def.linearVelocity ?? Vec2.ZERO;
    this.angularVelocity = def.angularVelocity ?? 0;
    this.density = def.density ?? 1;
    this.friction = def.friction ?? 0.3;
    this.restitution = def.restitution ?? 0.1;
    this.linearDamping = def.linearDamping ?? 0;
    this.angularDamping = def.angularDamping ?? 0;
    this.gravityScale = def.gravityScale ?? 1;
    this.allowSleep = def.allowSleep ?? true;
    this.bullet = def.bullet ?? false;
    this.isSensor = def.isSensor ?? false;
    this.color = def.color ?? '#6ea8ff';
    this.localCenter = Vec2.ZERO;
    this.worldCenter = this.transform.apply(this.localCenter);
    this.center0 = this.worldCenter;
    this.angle0 = this.angle;
    this.resetMassData();
  }

  /** Recompute mass, inertia and center of mass from the shape and density. */
  resetMassData(): void {
    if (this.type !== BodyType.Dynamic) {
      this.mass = 0;
      this.invMass = 0;
      this.inertia = 0;
      this.invInertia = 0;
      this.localCenter =
        this.shape.kind === 'circle'
          ? this.shape.center
          : this.shape.kind === 'capsule'
            ? this.shape.center()
            : Vec2.ZERO;
      this.worldCenter = this.transform.apply(this.localCenter);
      return;
    }
    const md = computeMass(this.shape, this.density);
    this.mass = md.mass;
    this.invMass = md.mass > 0 ? 1 / md.mass : 0;
    if (md.inertia > 0) {
      // Inertia about the center of mass only.
      this.inertia = md.inertia;
      this.invInertia = 1 / md.inertia;
    } else {
      this.inertia = 0;
      this.invInertia = 0;
    }
    this.localCenter = md.center;
    this.worldCenter = this.transform.apply(this.localCenter);
  }

  /** Recompute `transform.position` from the world center of mass and rotation. */
  synchronizeTransform(): void {
    const pos = this.worldCenter.sub(this.transform.q.apply(this.localCenter));
    this.transform = new Transform(pos, this.transform.q);
  }

  setAngle(angle: number): void {
    this.transform = new Transform(this.transform.position, Rot.fromAngle(angle));
    this.worldCenter = this.transform.apply(this.localCenter);
  }

  /** Hard-set the body's pose (used to script kinematic bodies each frame). */
  setTransform(position: Vec2, angle: number): void {
    this.transform = new Transform(position, Rot.fromAngle(angle));
    this.worldCenter = this.transform.apply(this.localCenter);
  }

  get angle(): number {
    return this.transform.q.angle();
  }

  worldAABB(): AABB {
    return computeAABB(this.shape, this.transform);
  }

  /** Local point → world point. */
  worldPoint(local: Vec2): Vec2 {
    return this.transform.apply(local);
  }

  /** World point → local point. */
  localPoint(world: Vec2): Vec2 {
    return this.transform.applyInv(world);
  }

  /** Velocity of the material point currently at `worldPoint`. */
  velocityAt(worldPoint: Vec2): Vec2 {
    const r = worldPoint.sub(this.worldCenter);
    return this.linearVelocity.add(crossSV(this.angularVelocity, r));
  }

  applyForce(force: Vec2, worldPoint: Vec2): void {
    if (this.type !== BodyType.Dynamic) return;
    this.wake();
    this.force = this.force.add(force);
    this.torque += worldPoint.sub(this.worldCenter).cross(force);
  }

  applyForceToCenter(force: Vec2): void {
    if (this.type !== BodyType.Dynamic) return;
    this.wake();
    this.force = this.force.add(force);
  }

  applyTorque(torque: number): void {
    if (this.type !== BodyType.Dynamic) return;
    this.wake();
    this.torque += torque;
  }

  applyImpulse(impulse: Vec2, worldPoint: Vec2): void {
    if (this.type !== BodyType.Dynamic) return;
    this.wake();
    this.linearVelocity = this.linearVelocity.add(impulse.mul(this.invMass));
    this.angularVelocity += this.invInertia * worldPoint.sub(this.worldCenter).cross(impulse);
  }

  applyAngularImpulse(impulse: number): void {
    if (this.type !== BodyType.Dynamic) return;
    this.wake();
    this.angularVelocity += this.invInertia * impulse;
  }

  wake(): void {
    if (this.type === BodyType.Static) return;
    this.awake = true;
    this.sleepTime = 0;
  }

  sleep(): void {
    this.awake = false;
    this.sleepTime = 0;
    this.linearVelocity = Vec2.ZERO;
    this.angularVelocity = 0;
  }

  /** Semi-implicit Euler integration of velocity from gravity and forces. */
  integrateVelocity(gravity: Vec2, dt: number): void {
    if (this.type !== BodyType.Dynamic) return;
    const accel = gravity.mul(this.gravityScale).add(this.force.mul(this.invMass));
    this.linearVelocity = this.linearVelocity.add(accel.mul(dt));
    this.angularVelocity += dt * this.invInertia * this.torque;
    // Exponential damping (unconditionally stable form).
    this.linearVelocity = this.linearVelocity.mul(1 / (1 + dt * this.linearDamping));
    this.angularVelocity *= 1 / (1 + dt * this.angularDamping);
  }

  /**
   * Integrate the center of mass and orientation using the real velocity plus
   * the split-impulse pseudo-velocity, then refit the transform.
   */
  integratePosition(dt: number): void {
    if (this.type === BodyType.Static) return;
    // Capture the start-of-integration pose so CCD can sweep across this step.
    this.center0 = this.worldCenter;
    this.angle0 = this.angle;
    this.worldCenter = this.worldCenter.add(this.linearVelocity.add(this.pseudoLinear).mul(dt));
    const angle = this.angle + (this.angularVelocity + this.pseudoAngular) * dt;
    const q = Rot.fromAngle(angle);
    this.transform = new Transform(this.worldCenter.sub(q.apply(this.localCenter)), q);
  }

  /**
   * The transform of this body interpolated to sweep fraction `t ∈ [0,1]`
   * between its start-of-step pose (`center0/angle0`) and current pose. Used by
   * the continuous-collision time-of-impact solver.
   */
  sweepTransform(t: number): Transform {
    const c = this.center0.lerp(this.worldCenter, t);
    const angle = this.angle0 + (this.angle - this.angle0) * t;
    const q = Rot.fromAngle(angle);
    return new Transform(c.sub(q.apply(this.localCenter)), q);
  }

  /** Hard-set the center of mass (used by the CCD solver to stop at impact). */
  setWorldCenter(c: Vec2): void {
    this.worldCenter = c;
    this.synchronizeTransform();
  }

  /** Roll this body's pose back to sweep fraction `t` (the CCD impact pose). */
  advanceTo(t: number): void {
    const c = this.center0.lerp(this.worldCenter, t);
    const angle = this.angle0 + (this.angle - this.angle0) * t;
    const q = Rot.fromAngle(angle);
    this.worldCenter = c;
    this.transform = new Transform(c.sub(q.apply(this.localCenter)), q);
  }

  /** Clear the per-step pseudo-velocity accumulators. */
  resetPseudoVelocity(): void {
    this.pseudoLinear = Vec2.ZERO;
    this.pseudoAngular = 0;
  }

  /** Kinetic energy — handy for the sleep heuristic and verification. */
  kineticEnergy(): number {
    return 0.5 * this.mass * this.linearVelocity.lengthSq() +
      0.5 * this.inertia * this.angularVelocity * this.angularVelocity;
  }
}
