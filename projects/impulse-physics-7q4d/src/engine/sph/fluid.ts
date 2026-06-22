/**
 * Position-Based Fluids (Macklin & Müller, SIGGRAPH 2013) — an incompressible
 * particle fluid, the Lagrangian cousin of the XPBD soft engine.
 *
 * Each particle carries a position (the primary state) and a velocity *derived*
 * from the position change, exactly like a soft-body particle — which is what
 * makes the method unconditionally stable at the engine's fixed step. The
 * incompressibility of water is enforced not by a stiff pressure force (which
 * would demand a tiny timestep) but as a **density constraint**
 *
 *     C_i(p) = ρ_i / ρ₀ − 1 = 0,        ρ_i = Σ_j m W(p_i − p_j, h)
 *
 * solved in position space with a handful of Jacobi iterations per step. The
 * per-particle correction is
 *
 *     Δp_i = (1/ρ₀) Σ_j (λ_i + λ_j + s_corr) ∇W(p_i − p_j),
 *     λ_i  = −C_i / (Σ_k |∇_{p_k} C_i|² + ε),
 *
 * with a CFM relaxation ε that tames the near-singular gradient sum at the free
 * surface, and an **artificial-pressure** term `s_corr = −k (W(r)/W(Δq))ⁿ` that
 * adds a little negative pressure so particles keep a clamped spacing instead of
 * clumping (it doubles as surface tension). A post-solve **XSPH viscosity** adds
 * cohesion and a **vorticity confinement** force puts back the swirl the
 * constraint solve damps.
 *
 * The fluid couples two-ways to the rigid world through the engine's own
 * {@link collideParticle}: particles are pushed out of every rigid shape in the
 * position solve, and a restitution+friction impulse is exchanged with the body
 * in a final velocity pass — so a jet spins a paddle wheel and a dense block
 * sinks while a light one floats. An optional domain AABB provides cheap walls so
 * a tank needn't be fenced in by rigid geometry.
 */
import { AABB } from '../aabb';
import { BodyType, type Body } from '../body';
import { clamp, EPSILON, Rot, Transform, Vec2 } from '../math';
import { Rng } from '../random';
import { collideParticle } from '../soft/collide';
import { SpatialHash } from './hash';
import { Kernels } from './kernels';

/** One fluid particle. Position is primary; velocity is derived each substep. */
export class FluidParticle {
  pos: Vec2;
  /** Position at the start of the substep — velocity is derived against it. */
  prev: Vec2;
  vel: Vec2;
  /** XPBD-style density-constraint multiplier (recomputed every iteration). */
  lambda = 0;
  /** Last computed SPH density (used by metrics, viscosity, vorticity). */
  density = 0;
  /** Scratch position delta accumulated within a Jacobi constraint pass. */
  dp: Vec2 = Vec2.ZERO;
  /** Cached scalar curl (the 2-D vorticity, z-component) for confinement. */
  curl = 0;

  constructor(pos: Vec2, vel: Vec2 = Vec2.ZERO) {
    this.pos = pos;
    this.prev = pos;
    this.vel = vel;
  }
}

/** A continuous source that streams particles into the fluid (fountains, hoses). */
export interface Emitter {
  /** Where particles appear (world space). */
  origin: Vec2;
  /** Jet direction (need not be normalised). */
  dir: Vec2;
  /** Launch speed (m/s). */
  speed: number;
  /** Particles per second. */
  rate: number;
  /** Half-angle spray cone in radians (0 = a tight stream). */
  spread: number;
  /** Width of the nozzle perpendicular to `dir` (m). */
  width: number;
  /** Whether the emitter is currently firing. */
  enabled: boolean;
  /** Fractional-particle accumulator so non-integer rates are honoured exactly. */
  acc: number;
}

/** Tunable parameters of a {@link FluidSystem}. All have sensible defaults. */
export interface FluidParams {
  /** Smoothing length / kernel radius `h` (m). */
  h: number;
  /** Rest particle spacing `dx` used by the fillers and emitters (m). */
  spacing: number;
  /** Target rest density ρ₀. */
  restDensity: number;
  /** Per-particle mass `m`. */
  particleMass: number;
  /** Collision radius of a particle against rigid shapes (m). */
  particleRadius: number;
  /** CFM relaxation ε in the λ denominator. */
  relaxation: number;
  /** Artificial-pressure strength `k` (0 disables it). */
  sCorrK: number;
  /** Artificial-pressure reference distance Δq, as a fraction of `h`. */
  sCorrDq: number;
  /** Artificial-pressure exponent `n`. */
  sCorrN: number;
  /** XSPH viscosity coefficient `c`. */
  viscosity: number;
  /** Vorticity-confinement strength ε_vort. */
  vorticity: number;
  /** Density-constraint Jacobi iterations per substep. */
  solverIterations: number;
  /** Substeps per rigid step. */
  substeps: number;
  /** Hard cap on the particle count (emitters stop adding past it). */
  maxParticles: number;
  /** Optional domain box: cheap reflecting walls. */
  bounds: AABB | null;
  /** Restitution of the domain walls (0 = soak up, 1 = perfect bounce). */
  boundRestitution: number;
  /** Restitution used for fluid–rigid contacts. */
  restitution: number;
  /** Coulomb friction coefficient for fluid–rigid contacts. */
  friction: number;
  /** Multiplier on world gravity for the fluid (1 = normal). */
  gravityScale: number;
}

/**
 * Build a complete {@link FluidParams} from a few headline choices, deriving the
 * rest that keep the discretisation self-consistent: the kernel radius from the
 * spacing, the rest density from `m/dx²` (so a rest-packed lattice already sits
 * at ρ₀ — see the rest-density verification check), and the collision radius from
 * half the spacing.
 */
export function fluidParams(opts: Partial<FluidParams> = {}): FluidParams {
  const spacing = opts.spacing ?? 0.26;
  const h = opts.h ?? spacing * 2.2;
  const particleMass = opts.particleMass ?? 1;
  // Rest density of a square lattice at this spacing: ρ = m / dx² (mass / area).
  const restDensity = opts.restDensity ?? particleMass / (spacing * spacing);
  return {
    spacing,
    h,
    particleMass,
    restDensity,
    particleRadius: opts.particleRadius ?? spacing * 0.5,
    relaxation: opts.relaxation ?? 1e-4 * restDensity * restDensity,
    // Artificial pressure is OFF by default: the compression-only constraint
    // already prevents clustering, and the s_corr repulsion otherwise holds the
    // fluid below rest density (it settles to ~0.74 ρ₀ with it on, ~1.00 ρ₀ off).
    // It remains available as a knob for surface-tension experiments.
    sCorrK: opts.sCorrK ?? 0,
    sCorrDq: opts.sCorrDq ?? 0.2,
    sCorrN: opts.sCorrN ?? 4,
    viscosity: opts.viscosity ?? 0.05,
    vorticity: opts.vorticity ?? 0.0,
    solverIterations: opts.solverIterations ?? 4,
    substeps: opts.substeps ?? 2,
    maxParticles: opts.maxParticles ?? 4000,
    bounds: opts.bounds ?? null,
    boundRestitution: opts.boundRestitution ?? 0.0,
    restitution: opts.restitution ?? 0.0,
    friction: opts.friction ?? 0.1,
    gravityScale: opts.gravityScale ?? 1,
  };
}

const MAX_CORRECTION = 0.25; // per-pass position-correction clamp (m)

/** Aggregate metrics over the live particle set, for the HUD and the verifier. */
export interface FluidStats {
  count: number;
  /** Mean SPH density over the particles. */
  averageDensity: number;
  /** Mean *compression* error `⟨max(0, ρ/ρ₀ − 1)⟩` — 0 for an ideal fluid. */
  densityError: number;
  kineticEnergy: number;
}

/**
 * An incompressible particle fluid. Add particles (directly, with {@link fillBox},
 * or via {@link Emitter}s) and {@link step} it each frame against the rigid bodies.
 */
export class FluidSystem {
  readonly particles: FluidParticle[] = [];
  readonly emitters: Emitter[] = [];
  params: FluidParams;

  private readonly kernels: Kernels;
  private readonly hash: SpatialHash;
  /** Per-particle neighbour index lists, rebuilt once per substep. */
  private neighbors: number[][] = [];
  private readonly rng: Rng;
  /** poly6 at the artificial-pressure reference distance Δq (precomputed). */
  private readonly wDq: number;

  constructor(params: Partial<FluidParams> = {}, seed = 0x5f1d) {
    this.params = fluidParams(params);
    this.kernels = new Kernels(this.params.h);
    this.hash = new SpatialHash(this.params.h);
    this.rng = new Rng(seed);
    this.wDq = this.kernels.W(this.params.sCorrDq * this.params.h);
  }

  /** Inverse particle mass — particles are equal mass, so this is shared. */
  private get invMass(): number {
    return 1 / this.params.particleMass;
  }

  add(pos: Vec2, vel: Vec2 = Vec2.ZERO): FluidParticle {
    const p = new FluidParticle(pos, vel);
    this.particles.push(p);
    return p;
  }

  addEmitter(e: Partial<Emitter> & Pick<Emitter, 'origin' | 'dir'>): Emitter {
    const emitter: Emitter = {
      origin: e.origin,
      dir: e.dir,
      speed: e.speed ?? 6,
      rate: e.rate ?? 400,
      spread: e.spread ?? 0.05,
      width: e.width ?? this.params.spacing * 4,
      enabled: e.enabled ?? true,
      acc: 0,
    };
    this.emitters.push(emitter);
    return emitter;
  }

  /**
   * Fill the axis-aligned box [`min`,`max`] with a lattice of particles at the
   * rest spacing (optionally hex-offset for a denser, more natural pack), each
   * with the given starting velocity. Returns the number added.
   */
  fillBox(min: Vec2, max: Vec2, vel: Vec2 = Vec2.ZERO, hex = false): number {
    const dx = this.params.spacing;
    const dy = hex ? dx * 0.8660254 : dx; // row pitch for a hex pack (√3/2)
    let added = 0;
    let row = 0;
    for (let y = min.y + dx * 0.5; y <= max.y - dx * 0.25; y += dy, row++) {
      const offset = hex && row % 2 === 1 ? dx * 0.5 : 0;
      for (let x = min.x + dx * 0.5 + offset; x <= max.x - dx * 0.25; x += dx) {
        if (this.particles.length >= this.params.maxParticles) return added;
        this.add(new Vec2(x, y), vel);
        added++;
      }
    }
    return added;
  }

  /** A tight AABB over the particles, expanded by `margin` (Infinity-safe). */
  aabb(margin = 0): AABB {
    if (this.particles.length === 0) {
      return new AABB(Vec2.ZERO, Vec2.ZERO);
    }
    let lo = new Vec2(Infinity, Infinity);
    let hi = new Vec2(-Infinity, -Infinity);
    const m = new Vec2(margin, margin);
    for (const p of this.particles) {
      lo = lo.min(p.pos.sub(m));
      hi = hi.max(p.pos.add(m));
    }
    return new AABB(lo, hi);
  }

  // ---- The main step -------------------------------------------------------

  /**
   * Advance the fluid by one rigid step `dt`, split into `params.substeps` PBF
   * substeps. The rigid bodies are treated as fixed colliders within the step
   * (their poses were already integrated) and receive the reaction impulses,
   * which take effect next step — the same stable one-step co-simulation the soft
   * engine uses.
   */
  step(bodies: Body[], gravity: Vec2, dt: number): void {
    if (dt <= 0) return;
    this.runEmitters(dt);
    if (this.particles.length === 0) return;

    const substeps = Math.max(1, this.params.substeps | 0);
    const h = dt / substeps;
    const g = gravity.mul(this.params.gravityScale);

    for (let s = 0; s < substeps; s++) {
      this.substep(bodies, g, h);
    }
  }

  private substep(bodies: Body[], g: Vec2, h: number): void {
    const ps = this.particles;

    // 1. Predict: semi-implicit gravity integration into the positions.
    for (const p of ps) {
      p.vel = p.vel.add(g.mul(h));
      p.prev = p.pos;
      p.pos = p.pos.add(p.vel.mul(h));
    }

    // 2. Neighbour search, cached for the substep (positions drift a little
    //    during the solve — standard PBF reuses one neighbour list per step).
    this.buildNeighbors();
    const candidates = this.rigidCandidates(bodies);

    // 3. Density-constraint Jacobi solve, with rigid depenetration + walls
    //    interleaved as *position* constraints (never a velocity bias).
    const iters = Math.max(1, this.params.solverIterations | 0);
    for (let it = 0; it < iters; it++) {
      this.computeLambdas();
      this.applyDeltaP();
      this.collideRigidPositions(candidates);
      this.applyBoundsPositions();
    }

    // 4. Derive velocities from the net position change.
    const inv = 1 / h;
    for (const p of ps) p.vel = p.pos.sub(p.prev).mul(inv);

    // 5. Vorticity confinement + XSPH viscosity (both read the solved densities).
    this.applyVorticityAndViscosity(h);

    // 6. Velocity pass: exchange momentum with the rigid bodies, then the walls.
    this.resolveRigidVelocities(candidates);
    this.applyBoundsVelocities();
  }

  /** Build the per-particle neighbour index lists (within the kernel radius). */
  private buildNeighbors(): void {
    const ps = this.particles;
    const positions = ps.map((p) => p.pos);
    this.hash.build(positions);
    const h2 = this.kernels.h2;
    const neighbors: number[][] = new Array(ps.length);
    for (let i = 0; i < ps.length; i++) {
      const list: number[] = [];
      const pix = ps[i].pos.x;
      const piy = ps[i].pos.y;
      this.hash.forEachNeighbor(i, (j) => {
        const dx = pix - ps[j].pos.x;
        const dy = piy - ps[j].pos.y;
        if (dx * dx + dy * dy < h2) list.push(j);
      });
      neighbors[i] = list;
    }
    this.neighbors = neighbors;
  }

  /** Recompute each particle's density and density-constraint multiplier λ_i. */
  private computeLambdas(): void {
    const ps = this.particles;
    const m = this.params.particleMass;
    const rho0 = this.params.restDensity;
    const invRho0 = 1 / rho0;
    const eps = this.params.relaxation;
    const w0 = this.kernels.Wsq(0); // self contribution

    for (let i = 0; i < ps.length; i++) {
      const pi = ps[i];
      const pix = pi.pos.x;
      const piy = pi.pos.y;
      const nb = this.neighbors[i];
      let rho = m * w0;
      for (const j of nb) {
        const dx = pix - ps[j].pos.x;
        const dy = piy - ps[j].pos.y;
        rho += m * this.kernels.Wsq(dx * dx + dy * dy);
      }
      pi.density = rho;

      // Only resolve *compression* (C ≥ 0). A free-surface particle has a density
      // deficit (C < 0) and a near-singular gradient sum; left unclamped that gives
      // a huge λ that explodes the surface. Cohesion is provided instead by the
      // artificial-pressure term and XSPH viscosity, which is the standard robust
      // choice. λ is therefore ≤ 0 — it always pushes overlapping particles apart.
      const C = Math.max(0, rho * invRho0 - 1);
      if (C === 0) {
        pi.lambda = 0;
        continue;
      }
      // Σ_k |∇_{p_k} C_i|²: the k=i term is |Σ_j ∇W|²·(1/ρ₀)²; each k=j term is
      // |∇W|²·(1/ρ₀)². Accumulate both.
      let gradIx = 0;
      let gradIy = 0;
      let sumGrad2 = 0;
      for (const j of nb) {
        const dx = pix - ps[j].pos.x;
        const dy = piy - ps[j].pos.y;
        const c = this.kernels.gradCoeff(Math.sqrt(dx * dx + dy * dy));
        const gx = c * dx;
        const gy = c * dy;
        gradIx += gx;
        gradIy += gy;
        sumGrad2 += gx * gx + gy * gy;
      }
      sumGrad2 += gradIx * gradIx + gradIy * gradIy;
      sumGrad2 *= invRho0 * invRho0;
      pi.lambda = -C / (sumGrad2 + eps);
    }
  }

  /** Compute and apply the symmetric position deltas Δp_i (Jacobi update). */
  private applyDeltaP(): void {
    const ps = this.particles;
    const invRho0 = 1 / this.params.restDensity;
    const k = this.params.sCorrK;
    const n = this.params.sCorrN;
    const useScorr = k > 0 && this.wDq > 0;
    // Bound a single Jacobi correction to a fraction of the rest spacing so a
    // sparse outlier can't be launched (the derived velocity is Δp/h).
    const maxCorr = this.params.spacing * 0.5;

    for (let i = 0; i < ps.length; i++) {
      const pi = ps[i];
      const pix = pi.pos.x;
      const piy = pi.pos.y;
      const nb = this.neighbors[i];
      let dx = 0;
      let dy = 0;
      for (const j of nb) {
        const rx = pix - ps[j].pos.x;
        const ry = piy - ps[j].pos.y;
        const r = Math.sqrt(rx * rx + ry * ry);
        const gc = this.kernels.gradCoeff(r);
        let coeff = pi.lambda + ps[j].lambda;
        if (useScorr) {
          const ratio = this.kernels.W(r) / this.wDq;
          coeff -= k * Math.pow(ratio, n);
        }
        coeff *= invRho0;
        dx += gc * rx * coeff;
        dy += gc * ry * coeff;
      }
      // Clamp the per-pass correction so a sparse outlier can't be flung.
      pi.dp = clampLen(new Vec2(dx, dy), maxCorr);
    }
    for (const p of ps) p.pos = p.pos.add(p.dp);
  }

  /**
   * Depenetrate particles from every nearby rigid shape, as a **two-way** position
   * constraint. The separation is split between the particle and the body by their
   * inverse masses (the body's effective inverse mass at the contact includes its
   * rotational inertia), and the body is actually moved — translated and rotated —
   * by its share. This is what produces genuine *hydrostatic buoyancy*: a
   * submerged body is pushed up by every fluid particle it overlaps, so it floats
   * at the depth where the corrections balance gravity, rather than drifting to the
   * floor as it would with a velocity-only (drag) coupling. Static bodies have
   * infinite mass, so they take none of the correction and the particle moves the
   * full depth — a perfect wall.
   */
  private collideRigidPositions(candidates: Body[]): void {
    if (candidates.length === 0) return;
    const r = this.params.particleRadius;
    const mpInv = this.invMass;
    for (const p of this.particles) {
      for (const body of candidates) {
        if (body.isSensor) continue;
        const hit = collideParticle(body, p.pos, r);
        if (!hit) continue;
        const n = hit.normal;
        const d = Math.min(hit.depth, MAX_CORRECTION);
        const dynamic = body.type === BodyType.Dynamic && body.awake;

        if (!dynamic) {
          p.pos = p.pos.add(n.mul(d));
          continue;
        }

        const rB = hit.point.sub(body.worldCenter);
        const rn = rB.cross(n);
        const kN = body.invMass + body.invInertia * rn * rn;
        const total = mpInv + kN;
        if (total <= 0) continue;
        const P = d / total; // scalar position-impulse along n
        p.pos = p.pos.add(n.mul(P * mpInv));
        // Move the body by its (inverse-mass-weighted) share: translate + rotate.
        const newCenter = body.worldCenter.sub(n.mul(P * body.invMass));
        const newAngle = body.angle - body.invInertia * rn * P;
        const q = Rot.fromAngle(newAngle);
        body.worldCenter = newCenter;
        body.transform = new Transform(newCenter.sub(q.apply(body.localCenter)), q);
      }
    }
  }

  /** Clamp particle positions into the domain box (if any). */
  private applyBoundsPositions(): void {
    const b = this.params.bounds;
    if (!b) return;
    const r = this.params.particleRadius;
    const loX = b.lower.x + r;
    const hiX = b.upper.x - r;
    const loY = b.lower.y + r;
    const hiY = b.upper.y - r;
    for (const p of this.particles) {
      const x = clamp(p.pos.x, loX, hiX);
      const y = clamp(p.pos.y, loY, hiY);
      if (x !== p.pos.x || y !== p.pos.y) p.pos = new Vec2(x, y);
    }
  }

  /**
   * Vorticity confinement followed by XSPH viscosity. Confinement reads the curl
   * of the velocity field and pushes particles back toward high-vorticity regions
   * (restoring the swirl the constraint solve numerically damps); XSPH nudges each
   * velocity toward its neighbours' average, giving the fluid cohesion.
   */
  private applyVorticityAndViscosity(h: number): void {
    const ps = this.particles;
    const m = this.params.particleMass;
    const vortEps = this.params.vorticity;
    const visc = this.params.viscosity;

    if (vortEps > 0) {
      // Pass A: each particle's scalar curl ω_i = Σ_j (m/ρ_j)(v_j − v_i) × ∇W.
      for (let i = 0; i < ps.length; i++) {
        const pi = ps[i];
        let curl = 0;
        for (const j of this.neighbors[i]) {
          const pj = ps[j];
          const wj = pj.density > EPSILON ? m / pj.density : 0;
          const rx = pi.pos.x - pj.pos.x;
          const ry = pi.pos.y - pj.pos.y;
          const gc = this.kernels.gradCoeff(Math.sqrt(rx * rx + ry * ry));
          const gx = gc * rx;
          const gy = gc * ry;
          // (v_j − v_i) × ∇W, the z-component.
          curl += wj * ((pj.vel.x - pi.vel.x) * gy - (pj.vel.y - pi.vel.y) * gx);
        }
        pi.curl = curl;
      }
      // Pass B: η = ∇|ω|; the confinement force is ε (N × ω ẑ), N = η/|η|.
      for (let i = 0; i < ps.length; i++) {
        const pi = ps[i];
        let ex = 0;
        let ey = 0;
        for (const j of this.neighbors[i]) {
          const pj = ps[j];
          const wj = pj.density > EPSILON ? m / pj.density : 0;
          const rx = pi.pos.x - pj.pos.x;
          const ry = pi.pos.y - pj.pos.y;
          const gc = this.kernels.gradCoeff(Math.sqrt(rx * rx + ry * ry));
          const a = wj * Math.abs(pj.curl);
          ex += a * gc * rx;
          ey += a * gc * ry;
        }
        const elen = Math.hypot(ex, ey);
        if (elen > EPSILON) {
          const nx = ex / elen;
          const ny = ey / elen;
          // N × (ω ẑ) = (N_y ω, −N_x ω).
          pi.vel = pi.vel.add(new Vec2(ny * pi.curl, -nx * pi.curl).mul(vortEps * h));
        }
      }
    }

    if (visc > 0) {
      const dxs = new Float64Array(ps.length);
      const dys = new Float64Array(ps.length);
      for (let i = 0; i < ps.length; i++) {
        const pi = ps[i];
        let dx = 0;
        let dy = 0;
        for (const j of this.neighbors[i]) {
          const pj = ps[j];
          const wj = pj.density > EPSILON ? m / pj.density : 0;
          const rx = pi.pos.x - pj.pos.x;
          const ry = pi.pos.y - pj.pos.y;
          const f = wj * this.kernels.Wsq(rx * rx + ry * ry);
          dx += (pj.vel.x - pi.vel.x) * f;
          dy += (pj.vel.y - pi.vel.y) * f;
        }
        dxs[i] = dx * visc;
        dys[i] = dy * visc;
      }
      for (let i = 0; i < ps.length; i++) ps[i].vel = ps[i].vel.add(new Vec2(dxs[i], dys[i]));
    }
  }

  /**
   * Velocity pass: a restitution + Coulomb-friction impulse at each particle–
   * rigid contact, with the equal-and-opposite reaction fed into the rigid body.
   * Overlap was already removed in the position solve, so this is purely a
   * momentum exchange (no positional bias that could pump energy).
   */
  private resolveRigidVelocities(candidates: Body[]): void {
    if (candidates.length === 0) return;
    const r = this.params.particleRadius;
    const invM = this.invMass;
    for (const p of this.particles) {
      for (const body of candidates) {
        if (body.isSensor) continue;
        const hit = collideParticle(body, p.pos, r);
        if (!hit) continue;
        const n = hit.normal;
        const cp = hit.point;
        const rB = cp.sub(body.worldCenter);
        const vB = body.velocityAt(cp);
        const vRel = p.vel.sub(vB);
        const vn = vRel.dot(n);

        const rn = rB.cross(n);
        const wB = body.invMass + body.invInertia * rn * rn;
        const wN = invM + wB;
        if (wN <= 0) continue;

        const e = Math.max(this.params.restitution, body.restitution);
        const target = vn < 0 ? -e * vn : 0;
        if (vn >= target) continue;

        const jn = (target - vn) / wN;
        p.vel = p.vel.add(n.mul(jn * invM));
        if (body.type === BodyType.Dynamic) body.applyImpulse(n.mul(-jn), cp);

        // Coulomb friction bounded by the normal impulse just applied.
        const t = vRel.sub(n.mul(vn));
        const tlen = t.length();
        if (tlen > EPSILON) {
          const td = t.mul(1 / tlen);
          const rt = rB.cross(td);
          const wT = invM + body.invMass + body.invInertia * rt * rt;
          if (wT > 0) {
            const mu = Math.sqrt(this.params.friction * body.friction);
            const jt = clamp(-tlen / wT, -mu * jn, mu * jn);
            p.vel = p.vel.add(td.mul(jt * invM));
            if (body.type === BodyType.Dynamic) body.applyImpulse(td.mul(-jt), cp);
          }
        }
      }
    }
  }

  /** Reflect (and damp) velocities at the domain walls. */
  private applyBoundsVelocities(): void {
    const b = this.params.bounds;
    if (!b) return;
    const r = this.params.particleRadius;
    const e = this.params.boundRestitution;
    const eps = r * 1e-3;
    for (const p of this.particles) {
      let vx = p.vel.x;
      let vy = p.vel.y;
      if (p.pos.x <= b.lower.x + r + eps && vx < 0) vx = -e * vx;
      else if (p.pos.x >= b.upper.x - r - eps && vx > 0) vx = -e * vx;
      if (p.pos.y <= b.lower.y + r + eps && vy < 0) vy = -e * vy;
      else if (p.pos.y >= b.upper.y - r - eps && vy > 0) vy = -e * vy;
      if (vx !== p.vel.x || vy !== p.vel.y) p.vel = new Vec2(vx, vy);
    }
  }

  /** Bodies whose AABB overlaps the (margin-expanded) fluid extent. */
  private rigidCandidates(bodies: Body[]): Body[] {
    if (bodies.length === 0) return bodies;
    const region = this.aabb(this.params.h + this.params.particleRadius);
    return bodies.filter((b) => b.worldAABB().overlaps(region));
  }

  /** Stream new particles from every enabled emitter. */
  private runEmitters(dt: number): void {
    for (const e of this.emitters) {
      if (!e.enabled) continue;
      e.acc += e.rate * dt;
      let count = Math.floor(e.acc);
      if (count <= 0) continue;
      e.acc -= count;
      const dir = e.dir.normalize();
      const perp = dir.perp();
      while (count-- > 0) {
        if (this.particles.length >= this.params.maxParticles) {
          e.acc = 0;
          break;
        }
        const lateral = this.rng.range(-0.5, 0.5) * e.width;
        const angle = this.rng.range(-e.spread, e.spread);
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        // Rotate the jet direction by the spray angle.
        const vdir = new Vec2(dir.x * cos - dir.y * sin, dir.x * sin + dir.y * cos);
        const pos = e.origin.add(perp.mul(lateral));
        this.add(pos, vdir.mul(e.speed));
      }
    }
  }

  // ---- Metrics (also used by the verification suite) -----------------------

  /** Rebuild the neighbour structure and recompute every particle's density. */
  recomputeDensities(): void {
    if (this.particles.length === 0) return;
    this.buildNeighbors();
    const m = this.params.particleMass;
    const w0 = this.kernels.Wsq(0);
    for (let i = 0; i < this.particles.length; i++) {
      const pi = this.particles[i];
      let rho = m * w0;
      for (const j of this.neighbors[i]) {
        rho += m * this.kernels.Wsq(pi.pos.sub(this.particles[j].pos).lengthSq());
      }
      pi.density = rho;
    }
  }

  /** Aggregate statistics over the particle set (uses the last solved densities). */
  stats(): FluidStats {
    const n = this.particles.length;
    if (n === 0) return { count: 0, averageDensity: 0, densityError: 0, kineticEnergy: 0 };
    const rho0 = this.params.restDensity;
    let dsum = 0;
    let err = 0;
    let ke = 0;
    const m = this.params.particleMass;
    for (const p of this.particles) {
      dsum += p.density;
      err += Math.max(0, p.density / rho0 - 1);
      ke += 0.5 * m * p.vel.lengthSq();
    }
    return { count: n, averageDensity: dsum / n, densityError: err / n, kineticEnergy: ke };
  }

  /** Net linear momentum of the fluid — for conservation checks. */
  momentum(): Vec2 {
    let s = Vec2.ZERO;
    const m = this.params.particleMass;
    for (const p of this.particles) s = s.add(p.vel.mul(m));
    return s;
  }

  /** Highest particle (max y) — used by the communicating-vessels check. */
  maxHeight(): number {
    let y = -Infinity;
    for (const p of this.particles) if (p.pos.y > y) y = p.pos.y;
    return y;
  }
}

/** Clamp a vector's magnitude to at most `max`. */
function clampLen(v: Vec2, max: number): Vec2 {
  const len = v.length();
  return len > max ? v.mul(max / len) : v;
}
