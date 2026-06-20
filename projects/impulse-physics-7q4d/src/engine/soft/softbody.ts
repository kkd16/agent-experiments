import { AABB } from '../aabb';
import { Body, BodyType } from '../body';
import { clamp, crossVS, EPSILON, Vec2 } from '../math';
import { collideParticle } from './collide';

/**
 * A point mass — the atom of a soft body. Positions are primary state; the
 * velocity is *derived* from the position change each substep (the hallmark of
 * Position-Based Dynamics), which is what makes the simulation unconditionally
 * stable no matter how stiff the constraints are.
 */
export class Particle {
  pos: Vec2;
  /** Position at the start of the substep (used to derive velocity). */
  prev: Vec2;
  vel: Vec2 = Vec2.ZERO;
  /** Inverse mass; 0 ⇒ pinned (immovable, infinite mass). */
  invMass: number;
  radius: number;

  constructor(pos: Vec2, mass: number, radius: number) {
    this.pos = pos;
    this.prev = pos;
    this.invMass = mass > 0 ? 1 / mass : 0;
    this.radius = radius;
  }

  get mass(): number {
    return this.invMass > 0 ? 1 / this.invMass : 0;
  }

  get pinned(): boolean {
    return this.invMass === 0;
  }
}

/**
 * A compliant distance constraint (an XPBD spring). `compliance` is the inverse
 * stiffness in metres/Newton: 0 is perfectly rigid, larger is softer. Unlike a
 * classic PBD spring its behaviour is *step-size independent* — the same
 * compliance gives the same material whether you run 4 or 40 substeps.
 */
export interface DistanceConstraint {
  i: number;
  j: number;
  rest: number;
  compliance: number;
  /** Lagrange multiplier, accumulated across iterations within a substep. */
  lambda: number;
}

/**
 * An area-preservation constraint over a closed loop of particles — the 2-D
 * analogue of a volume/pressure constraint. Driving `rest` above the natural
 * area inflates the loop (a balloon); holding it at the natural area makes an
 * incompressible blob that bulges out wherever it is squeezed.
 */
export interface AreaConstraint {
  loop: number[];
  rest: number;
  compliance: number;
  lambda: number;
}

export type SoftKind = 'blob' | 'cloth' | 'rope' | 'mesh';

/** How the renderer should draw a soft body (pure presentation data). */
export interface SoftRender {
  kind: SoftKind;
  color: string;
  /** Ordered ring of particle indices for a filled, smoothed outline. */
  loop?: number[];
  /** Edges to stroke (cloth/rope/mesh structure). */
  links: Array<[number, number]>;
  /** Triangles to fill (cloth / soft solids). */
  tris?: Array<[number, number, number]>;
}

/**
 * A deformable body: a cloud of {@link Particle}s held together by compliant
 * constraints and stepped with XPBD. It collides with the rigid world through
 * {@link collideParticle}, exchanging momentum two-ways so a heavy blob shoves a
 * light crate and a falling crate dents the blob.
 */
export class SoftBody {
  readonly particles: Particle[] = [];
  readonly distances: DistanceConstraint[] = [];
  readonly areas: AreaConstraint[] = [];

  /** Velocity damping rate (1/s) — bleeds jitter, models internal friction. */
  damping = 0.6;
  gravityScale = 1;
  friction = 0.4;
  restitution = 0.05;

  render: SoftRender;

  constructor(render: SoftRender) {
    this.render = render;
  }

  addParticle(pos: Vec2, mass: number, radius: number): number {
    this.particles.push(new Particle(pos, mass, radius));
    return this.particles.length - 1;
  }

  addDistance(i: number, j: number, compliance: number, rest?: number): void {
    this.distances.push({
      i,
      j,
      rest: rest ?? this.particles[i].pos.distanceTo(this.particles[j].pos),
      compliance,
      lambda: 0,
    });
  }

  addArea(loop: number[], compliance: number, restScale = 1): void {
    this.areas.push({
      loop,
      rest: signedArea(this.particles, loop) * restScale,
      compliance,
      lambda: 0,
    });
  }

  // ---- The substep, in four phases -----------------------------------------

  /** Phase 1 — integrate external forces (gravity + damping) into positions. */
  integrate(h: number, gravity: Vec2): void {
    const drag = 1 / (1 + h * this.damping);
    const g = gravity.mul(this.gravityScale * h);
    for (const p of this.particles) {
      if (p.invMass === 0) {
        p.prev = p.pos;
        continue;
      }
      p.vel = p.vel.add(g).mul(drag);
      p.prev = p.pos;
      p.pos = p.pos.add(p.vel.mul(h));
    }
  }

  /** Reset the XPBD Lagrange multipliers — call once at the start of a substep. */
  resetLambdas(): void {
    for (const c of this.distances) c.lambda = 0;
    for (const a of this.areas) a.lambda = 0;
  }

  /** Phase 2 — one Gauss–Seidel pass of the compliant constraints. */
  projectConstraints(h: number): void {
    const dtSq = h * h;
    for (const c of this.distances) this.solveDistance(c, dtSq);
    for (const a of this.areas) this.solveArea(a, dtSq);
  }

  /**
   * Phase 2b — push particles out of the rigid bodies they overlap, as a
   * *position* constraint interleaved with the internal ones. Running collisions
   * inside the position solve is what lets a soft body carry load: a heavy crate
   * pressing on a hammock is resisted collectively, the contact propagating
   * through the constraint network to the pinned anchors over the iterations.
   * The per-pass correction is clamped so a particle swallowed by a large shape
   * can't be flung out in one violent step.
   */
  collideBodiesPosition(candidates: Body[]): void {
    const maxCorr = 0.2;
    for (const p of this.particles) {
      if (p.invMass === 0) continue;
      for (const body of candidates) {
        if (body.isSensor) continue;
        const hit = collideParticle(body, p.pos, p.radius);
        if (!hit) continue;
        p.pos = p.pos.add(hit.normal.mul(Math.min(hit.depth, maxCorr)));
      }
    }
  }

  /** Phase 3 — derive velocities from the net position change this substep. */
  updateVelocities(h: number): void {
    const inv = h > 0 ? 1 / h : 0;
    for (const p of this.particles) {
      p.vel = p.invMass === 0 ? Vec2.ZERO : p.pos.sub(p.prev).mul(inv);
    }
  }

  /**
   * Phase 4 — the velocity pass: now that positions (and the depenetration) are
   * settled and velocities derived, exchange momentum at each contact. The
   * normal impulse removes any residual approach (plus restitution and a small
   * bias for leftover overlap), Coulomb friction is clamped to the cone, and the
   * equal-and-opposite impulse is fed into the rigid body — the two-way coupling.
   */
  resolveContactVelocities(candidates: Body[]): void {
    for (const p of this.particles) {
      if (p.invMass === 0) continue;
      for (const body of candidates) {
        if (body.isSensor) continue;
        const hit = collideParticle(body, p.pos, p.radius);
        if (!hit) continue;
        this.resolveContact(p, body, hit.normal, hit.point);
      }
    }
  }

  /**
   * The momentum-exchange impulse for one particle–rigid contact, in velocity
   * space. Overlap was already removed by the position solve, so this is a pure
   * restitution + Coulomb-friction impulse (no positional bias that could pump
   * energy into persistent contacts); the reaction goes into the rigid body.
   */
  private resolveContact(p: Particle, body: Body, n: Vec2, cp: Vec2): void {
    const rB = cp.sub(body.worldCenter);
    const vB = body.velocityAt(cp);
    const vRel = p.vel.sub(vB);
    const vn = vRel.dot(n);

    const rn = rB.cross(n);
    const wB = body.invMass + body.invInertia * rn * rn;
    const wN = p.invMass + wB;
    if (wN <= 0) return;

    const e = Math.max(this.restitution, body.restitution);
    const target = vn < 0 ? -e * vn : 0;

    let jn = 0;
    if (vn < target) {
      jn = (target - vn) / wN;
      p.vel = p.vel.add(n.mul(jn * p.invMass));
      if (body.type === BodyType.Dynamic) body.applyImpulse(n.mul(-jn), cp);
    }

    // Coulomb friction, bounded by the normal impulse just applied.
    if (jn > 0) {
      const t = vRel.sub(n.mul(vn));
      const tlen = t.length();
      if (tlen > EPSILON) {
        const td = t.mul(1 / tlen);
        const rt = rB.cross(td);
        const wT = p.invMass + body.invMass + body.invInertia * rt * rt;
        if (wT > 0) {
          const mu = Math.sqrt(this.friction * body.friction);
          const jt = clamp(-tlen / wT, -mu * jn, mu * jn);
          p.vel = p.vel.add(td.mul(jt * p.invMass));
          if (body.type === BodyType.Dynamic) body.applyImpulse(td.mul(-jt), cp);
        }
      }
    }
  }

  private solveDistance(c: DistanceConstraint, dtSq: number): void {
    const pi = this.particles[c.i];
    const pj = this.particles[c.j];
    const w = pi.invMass + pj.invMass;
    if (w === 0) return;
    const d = pi.pos.sub(pj.pos);
    const len = d.length();
    if (len < EPSILON) return;
    const n = d.mul(1 / len);
    const C = len - c.rest;
    const alpha = c.compliance / dtSq;
    const dl = (-C - alpha * c.lambda) / (w + alpha);
    c.lambda += dl;
    const corr = n.mul(dl);
    pi.pos = pi.pos.add(corr.mul(pi.invMass));
    pj.pos = pj.pos.sub(corr.mul(pj.invMass));
  }

  private solveArea(a: AreaConstraint, dtSq: number): void {
    const loop = a.loop;
    const n = loop.length;
    const A = signedArea(this.particles, loop);
    const C = A - a.rest;

    // Gradient of the shoelace area w.r.t. each vertex: ½·rot₋₉₀(xₙₑₓₜ − xₚᵣₑᵥ).
    const grads: Vec2[] = new Array(n);
    let sumW = 0;
    for (let i = 0; i < n; i++) {
      const next = this.particles[loop[(i + 1) % n]].pos;
      const prev = this.particles[loop[(i - 1 + n) % n]].pos;
      const g = crossVS(next.sub(prev), 0.5);
      grads[i] = g;
      sumW += this.particles[loop[i]].invMass * g.lengthSq();
    }
    if (sumW < EPSILON) return;
    const alpha = a.compliance / dtSq;
    const dl = (-C - alpha * a.lambda) / (sumW + alpha);
    a.lambda += dl;
    for (let i = 0; i < n; i++) {
      const p = this.particles[loop[i]];
      if (p.invMass === 0) continue;
      p.pos = p.pos.add(grads[i].mul(p.invMass * dl));
    }
  }

  // ---- Queries & metrics (also used by the verification suite) -------------

  /** A tight AABB over the particles, expanded by `margin`. */
  aabb(margin = 0): AABB {
    let lo = new Vec2(Infinity, Infinity);
    let hi = new Vec2(-Infinity, -Infinity);
    for (const p of this.particles) {
      const r = p.radius + margin;
      lo = lo.min(p.pos.sub(new Vec2(r, r)));
      hi = hi.max(p.pos.add(new Vec2(r, r)));
    }
    return new AABB(lo, hi);
  }

  /** Signed area of the render loop (0 when the body has no closed outline). */
  area(): number {
    return this.render.loop ? signedArea(this.particles, this.render.loop) : 0;
  }

  centroid(): Vec2 {
    let c = Vec2.ZERO;
    for (const p of this.particles) c = c.add(p.pos);
    return c.mul(1 / this.particles.length);
  }

  totalMass(): number {
    let m = 0;
    for (const p of this.particles) m += p.mass;
    return m;
  }

  /** Net linear momentum of the (free) particles — for conservation checks. */
  linearMomentum(): Vec2 {
    let s = Vec2.ZERO;
    for (const p of this.particles) if (p.invMass > 0) s = s.add(p.vel.mul(p.mass));
    return s;
  }

  kineticEnergy(): number {
    let e = 0;
    for (const p of this.particles) e += 0.5 * p.mass * p.vel.lengthSq();
    return e;
  }

  /** Apply an instantaneous velocity change to every free particle. */
  applyImpulseToCenter(impulse: Vec2): void {
    for (const p of this.particles) {
      if (p.invMass > 0) p.vel = p.vel.add(impulse.mul(p.invMass));
    }
  }

  /** Velocity of the material at a world point (nearest particle) — for picking. */
  velocityNear(world: Vec2): Vec2 {
    let best = this.particles[0];
    let bestD = Infinity;
    for (const p of this.particles) {
      const d = p.pos.distanceTo(world);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best.vel;
  }
}

/** Shoelace signed area of `loop` (CCW positive). */
export function signedArea(particles: Particle[], loop: number[]): number {
  let a = 0;
  const n = loop.length;
  for (let i = 0; i < n; i++) {
    const p = particles[loop[i]].pos;
    const q = particles[loop[(i + 1) % n]].pos;
    a += p.cross(q);
  }
  return a * 0.5;
}
