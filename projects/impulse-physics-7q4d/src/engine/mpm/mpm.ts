/**
 * The Material Point Method (MLS-MPM) — a fifth physics paradigm for the Impulse
 * engine and its second continuum solver beside FEM, but a fundamentally
 * different discretisation: the material lives on a cloud of **particles** that
 * carry all state (mass, velocity, the deformation gradient `F`), while a
 * transient **background grid** is borrowed each step only to compute forces and
 * resolve collisions, then thrown away. That hybrid Eulerian–Lagrangian split is
 * what lets one solver handle elastic jelly, cohesive snow, frictional sand and
 * weakly-compressible water with nothing changing but the constitutive law — and
 * what lets all of them topologically *flow*, split and merge, which a fixed FEM
 * mesh cannot.
 *
 * This is **MLS-MPM** (Hu et al., SIGGRAPH 2018): the moving-least-squares
 * variant that folds the stress into the same affine (APIC) momentum transfer,
 * so particle↔grid is a single quadratic-B-spline scatter/gather. The affine
 * **APIC** state (Jiang et al. 2015) makes the transfer *angular-momentum
 * conserving* — no the ringing or dissipation of classic PIC/FLIP — which the
 * verification suite checks to machine precision.
 *
 * The per-substep dance:
 *   1. **reset** the grid (mass + momentum per node);
 *   2. **P2G** — each particle evaluates its constitutive stress `P·Fᵀ`, folds
 *      it with its affine matrix into one `affine` tensor, and scatters mass and
 *      affine momentum to the 3×3 stencil of grid nodes around it;
 *   3. **grid update** — divide momentum by mass to get node velocities, apply
 *      gravity, and enforce separating/ frictional domain walls;
 *   4. **G2P** — each particle gathers a new velocity and a new affine matrix
 *      `C` from the grid, advects, and updates its deformation gradient
 *      `F ← (I + dt·C)·F`;
 *   5. **rigid coupling** — particles depenetrate from every nearby rigid body
 *      and exchange a restitution+friction impulse, two-ways, through the
 *      engine's own {@link collideParticle} bridge (the same one the SPH and soft
 *      solvers use), so sand buries a crate and a paddle stirs snow.
 *
 * Stability is the MPM kind: explicit, but the implicit MLS stress and the
 * sub-stepping keep it robust at the engine's fixed step for the stiffnesses the
 * presets use.
 */
import { AABB } from '../aabb';
import { BodyType, type Body } from '../body';
import { clamp, EPSILON, Rot, Transform, Vec2 } from '../math';
import { collideParticle } from '../soft/collide';
import { Mat2 } from './mat2';
import { evaluate, lame, type MpmMaterial } from './material';

/** One material point. Position, velocity, the affine matrix and `F` are state. */
export class MpmParticle {
  pos: Vec2;
  vel: Vec2;
  /** APIC affine velocity matrix `C` (∇v reconstruction). */
  C: Mat2 = Mat2.ZERO;
  /** Deformation gradient `F` (1 = undeformed). */
  F: Mat2 = Mat2.I;
  /** Plastic compaction `Jp` (snow/sand); 1 = no accumulated plasticity. */
  Jp = 1;
  /** Particle mass `ρ₀·V₀`. */
  mass: number;
  /** Initial volume `V₀` used to scale the stress contribution. */
  vol0: number;
  mat: MpmMaterial;

  constructor(pos: Vec2, mat: MpmMaterial, mass: number, vol0: number, vel: Vec2 = Vec2.ZERO) {
    this.pos = pos;
    this.vel = vel;
    this.mass = mass;
    this.vol0 = vol0;
    this.mat = mat;
  }
}

/** Tunable parameters of an {@link MpmSystem}. */
export interface MpmParams {
  /** Grid cell size `dx` (world units). */
  dx: number;
  /** Lower-left world corner of the background grid. */
  origin: Vec2;
  /** Grid node counts (the domain is `(nx−1)·dx` × `(ny−1)·dx` wide). */
  nx: number;
  ny: number;
  /** Substeps per rigid step (explicit MPM wants a few). */
  substeps: number;
  /** Multiplier on world gravity. */
  gravityScale: number;
  /** Thickness, in cells, of the enforced domain-wall band. */
  boundary: number;
  /** Coulomb friction of the domain floor/walls (tangential velocity damping). */
  boundaryFriction: number;
  /** Particle collision radius against rigid bodies. */
  rigidRadius: number;
  /** Restitution for particle–rigid contacts. */
  restitution: number;
  /** Coulomb friction for particle–rigid contacts. */
  friction: number;
  /** Equation-of-state bulk modulus for `fluid` particles. */
  fluidBulk: number;
  /** Hard cap on the particle count (fillers/emitters stop past it). */
  maxParticles: number;
}

const DX = 0.5;

/** Build a full {@link MpmParams} sized to cover a world AABB at spacing `dx`. */
export function mpmParams(region: AABB, opts: Partial<MpmParams> = {}): MpmParams {
  const dx = opts.dx ?? DX;
  const pad = (opts.boundary ?? 3) + 1;
  const origin = opts.origin ?? region.lower.sub(new Vec2(pad * dx, pad * dx));
  const span = region.upper.sub(origin).add(new Vec2(pad * dx, pad * dx));
  const nx = opts.nx ?? Math.max(8, Math.ceil(span.x / dx) + 1);
  const ny = opts.ny ?? Math.max(8, Math.ceil(span.y / dx) + 1);
  return {
    dx,
    origin,
    nx,
    ny,
    substeps: opts.substeps ?? 6,
    gravityScale: opts.gravityScale ?? 1,
    boundary: opts.boundary ?? 3,
    boundaryFriction: opts.boundaryFriction ?? 0.5,
    rigidRadius: opts.rigidRadius ?? dx * 0.25,
    restitution: opts.restitution ?? 0,
    friction: opts.friction ?? 0.4,
    fluidBulk: opts.fluidBulk ?? 5e3,
    maxParticles: opts.maxParticles ?? 12000,
  };
}

/** Aggregate metrics over the particle set (HUD + verifier). */
export interface MpmStats {
  count: number;
  kineticEnergy: number;
  /** Mean plastic compaction `⟨Jp⟩` (1 = no plastic flow yet). */
  meanJp: number;
  /** Mean speed (m/s). */
  meanSpeed: number;
}

/**
 * A Material Point Method simulation. Fill it with particles (one material at a
 * time, or several), attach it to a {@link World}, and {@link step} it each frame
 * against the rigid bodies.
 */
export class MpmSystem {
  readonly particles: MpmParticle[] = [];
  params: MpmParams;

  /** Background-grid mass per node, row-major `i + j·nx`. */
  private gm: Float64Array;
  /** Background-grid momentum/velocity per node (x, y). */
  private gx: Float64Array;
  private gy: Float64Array;

  constructor(params: MpmParams) {
    this.params = params;
    const n = params.nx * params.ny;
    this.gm = new Float64Array(n);
    this.gx = new Float64Array(n);
    this.gy = new Float64Array(n);
  }

  /** Per-cell particle volume for a `density` lattice at `spacing` (2/cell/axis). */
  private get defaultVol(): number {
    const s = this.params.dx * 0.5;
    return s * s;
  }

  /** Add a single particle of `mat` at world `pos` with optional velocity. */
  add(pos: Vec2, mat: MpmMaterial, vel: Vec2 = Vec2.ZERO): MpmParticle | null {
    if (this.particles.length >= this.params.maxParticles) return null;
    const vol0 = this.defaultVol;
    const p = new MpmParticle(pos, mat, mat.density * vol0, vol0, vel);
    this.particles.push(p);
    return p;
  }

  /**
   * Fill the axis-aligned box [`min`,`max`] with a regular lattice of `mat`
   * particles at half-cell spacing (the MLS-MPM standard of 4 particles/cell),
   * jittered slightly to break grid alignment. Returns the count added.
   */
  fillBox(min: Vec2, max: Vec2, mat: MpmMaterial, vel: Vec2 = Vec2.ZERO, jitter = 0.0): number {
    const s = this.params.dx * 0.5;
    let added = 0;
    let row = 0;
    for (let y = min.y + s * 0.5; y <= max.y - s * 0.25; y += s, row++) {
      for (let x = min.x + s * 0.5; x <= max.x - s * 0.25; x += s) {
        if (this.particles.length >= this.params.maxParticles) return added;
        const jx = jitter ? (hash2(x, y) - 0.5) * s * jitter : 0;
        const jy = jitter ? (hash2(y, x) - 0.5) * s * jitter : 0;
        this.add(new Vec2(x + jx, y + jy), mat, vel);
        added++;
      }
    }
    return added;
  }

  /** Fill a disc of radius `r` centred at `c` with `mat` particles. */
  fillDisc(c: Vec2, r: number, mat: MpmMaterial, vel: Vec2 = Vec2.ZERO): number {
    const s = this.params.dx * 0.5;
    let added = 0;
    for (let y = c.y - r; y <= c.y + r; y += s) {
      for (let x = c.x - r; x <= c.x + r; x += s) {
        if ((x - c.x) ** 2 + (y - c.y) ** 2 > r * r) continue;
        if (this.particles.length >= this.params.maxParticles) return added;
        this.add(new Vec2(x, y), mat, vel);
        added++;
      }
    }
    return added;
  }

  /** A tight AABB over the particles, expanded by `margin`. */
  aabb(margin = 0): AABB {
    if (this.particles.length === 0) return new AABB(Vec2.ZERO, Vec2.ZERO);
    let lo = new Vec2(Infinity, Infinity);
    let hi = new Vec2(-Infinity, -Infinity);
    const m = new Vec2(margin, margin);
    for (const p of this.particles) {
      lo = lo.min(p.pos.sub(m));
      hi = hi.max(p.pos.add(m));
    }
    return new AABB(lo, hi);
  }

  /** The world-space domain box the grid covers (inside the boundary band). */
  domain(): AABB {
    const { origin, dx, nx, ny, boundary } = this.params;
    const b = boundary * dx;
    return new AABB(
      new Vec2(origin.x + b, origin.y + b),
      new Vec2(origin.x + (nx - 1) * dx - b, origin.y + (ny - 1) * dx - b),
    );
  }

  // ---- Main step -----------------------------------------------------------

  /**
   * Advance the MPM material by one rigid step `dt`, split into `substeps`
   * explicit MLS-MPM substeps. Rigid bodies are fixed colliders within the step
   * (their poses are already integrated) and receive the reaction impulses, which
   * take effect next step — the same stable one-step co-simulation the SPH and
   * soft engines use.
   */
  step(bodies: Body[], gravity: Vec2, dt: number): void {
    if (dt <= 0 || this.particles.length === 0) return;
    const sub = Math.max(1, this.params.substeps | 0);
    const h = dt / sub;
    const g = gravity.mul(this.params.gravityScale);
    const candidates = this.rigidCandidates(bodies);
    for (let s = 0; s < sub; s++) {
      this.resetGrid();
      this.p2g(h, true);
      this.normalizeGrid(g, h, true);
      this.g2p(h);
      this.collideRigid(candidates);
    }
  }

  /** Zero the background grid. */
  resetGrid(): void {
    this.gm.fill(0);
    this.gx.fill(0);
    this.gy.fill(0);
  }

  /**
   * Particle-to-grid scatter. Each particle evaluates its constitutive model
   * (which also applies plasticity, mutating `F` and `Jp`), folds the stress into
   * the affine tensor `affine = −dt·V₀·(4/dx²)·P·Fᵀ + m·C`, and distributes mass
   * and affine momentum onto its 3×3 quadratic stencil. With `withStress=false`
   * it is the pure APIC momentum transfer (used by the conservation tests).
   */
  p2g(dt: number, withStress: boolean): void {
    const { dx, nx, ny, origin, fluidBulk } = this.params;
    const invDx = 1 / dx;
    const stressScale = -dt * 4 * invDx * invDx;
    for (const p of this.particles) {
      const gxp = (p.pos.x - origin.x) * invDx;
      const gyp = (p.pos.y - origin.y) * invDx;
      const bi = Math.floor(gxp - 0.5);
      const bj = Math.floor(gyp - 0.5);
      if (bi < 0 || bj < 0 || bi + 2 >= nx || bj + 2 >= ny) continue;
      const fx = gxp - bi;
      const fy = gyp - bj;
      const wx = quadWeights(fx);
      const wy = quadWeights(fy);

      let affine: Mat2;
      if (withStress) {
        const res = evaluate(p.F, p.Jp, p.mat, fluidBulk);
        p.F = res.F;
        p.Jp = res.Jp;
        affine = res.pf.scale(stressScale * p.vol0).add(p.C.scale(p.mass));
      } else {
        affine = p.C.scale(p.mass);
      }

      const mvx = p.mass * p.vel.x;
      const mvy = p.mass * p.vel.y;
      for (let a = 0; a <= 2; a++) {
        for (let b = 0; b <= 2; b++) {
          const w = wx[a] * wy[b];
          const dposx = (a - fx) * dx;
          const dposy = (b - fy) * dx;
          // affine · dpos
          const ax = affine.a * dposx + affine.b * dposy;
          const ay = affine.c * dposx + affine.d * dposy;
          const node = bi + a + (bj + b) * nx;
          this.gm[node] += w * p.mass;
          this.gx[node] += w * (mvx + ax);
          this.gy[node] += w * (mvy + ay);
        }
      }
    }
  }

  /**
   * Convert grid momentum to velocity, apply gravity, and enforce the domain
   * walls. Walls are **separating** (they stop inflow but let the material lift
   * off) with Coulomb tangential friction — the floor a poured sand pile rests
   * on. With `withBoundary=false` it is the bare momentum→velocity normalisation
   * (used by the conservation tests, where no external impulse may enter).
   */
  normalizeGrid(gravity: Vec2, dt: number, withBoundary: boolean): void {
    const { nx, ny, boundary, boundaryFriction } = this.params;
    const gxg = gravity.x * dt;
    const gyg = gravity.y * dt;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const node = i + j * nx;
        const m = this.gm[node];
        if (m <= 0) continue;
        let vx = this.gx[node] / m + gxg;
        let vy = this.gy[node] / m + gyg;

        if (withBoundary) {
          const loX = i < boundary;
          const hiX = i >= nx - boundary;
          const loY = j < boundary;
          const hiY = j >= ny - boundary;
          // Separating walls: cancel inflow normal velocity; friction on tangent.
          if (loY && vy < 0) {
            vx = applyFriction(vx, boundaryFriction, vy);
            vy = 0;
          } else if (hiY && vy > 0) {
            vy = 0;
          }
          if (loX && vx < 0) {
            vx = 0;
          } else if (hiX && vx > 0) {
            vx = 0;
          }
        }
        this.gx[node] = vx;
        this.gy[node] = vy;
      }
    }
  }

  /**
   * Grid-to-particle gather. Each particle reconstructs a PIC velocity and the
   * APIC affine matrix `C = (4/dx²)·Σ w·gᵥ⊗dpos` from its stencil, advects, and
   * updates `F ← (I + dt·C)·F`. Positions are clamped a safe margin inside the
   * grid so the stencil never falls off the array.
   */
  g2p(dt: number): void {
    const { dx, nx, ny, origin } = this.params;
    const invDx = 1 / dx;
    const cScale = 4 * invDx * invDx;
    const minX = origin.x + 2 * dx;
    const minY = origin.y + 2 * dx;
    const maxX = origin.x + (nx - 3) * dx;
    const maxY = origin.y + (ny - 3) * dx;
    for (const p of this.particles) {
      const gxp = (p.pos.x - origin.x) * invDx;
      const gyp = (p.pos.y - origin.y) * invDx;
      const bi = Math.floor(gxp - 0.5);
      const bj = Math.floor(gyp - 0.5);
      if (bi < 0 || bj < 0 || bi + 2 >= nx || bj + 2 >= ny) {
        // Out of bounds: freeze in place rather than read garbage.
        p.vel = Vec2.ZERO;
        continue;
      }
      const fx = gxp - bi;
      const fy = gyp - bj;
      const wx = quadWeights(fx);
      const wy = quadWeights(fy);

      let vx = 0;
      let vy = 0;
      let ca = 0;
      let cb = 0;
      let cc = 0;
      let cd = 0;
      for (let a = 0; a <= 2; a++) {
        for (let b = 0; b <= 2; b++) {
          const w = wx[a] * wy[b];
          const node = bi + a + (bj + b) * nx;
          const gvx = this.gx[node];
          const gvy = this.gy[node];
          vx += w * gvx;
          vy += w * gvy;
          const dposx = (a - fx) * dx;
          const dposy = (b - fy) * dx;
          // C += w · gᵥ ⊗ dpos
          ca += w * gvx * dposx;
          cb += w * gvx * dposy;
          cc += w * gvy * dposx;
          cd += w * gvy * dposy;
        }
      }
      p.vel = new Vec2(vx, vy);
      p.C = new Mat2(ca * cScale, cb * cScale, cc * cScale, cd * cScale);

      // F ← (I + dt·C)·F
      const A = new Mat2(1 + dt * p.C.a, dt * p.C.b, dt * p.C.c, 1 + dt * p.C.d);
      p.F = A.mul(p.F);

      // Advect, clamped a safe margin inside the grid.
      const nxp = clamp(p.pos.x + dt * vx, minX, maxX);
      const nyp = clamp(p.pos.y + dt * vy, minY, maxY);
      p.pos = new Vec2(nxp, nyp);
    }
  }

  /**
   * Two-way particle–rigid coupling: depenetrate each particle from every nearby
   * rigid body (inverse-mass-weighted, so a dynamic body is actually pushed) and
   * exchange a restitution+friction impulse, feeding the equal-and-opposite
   * reaction into the body. Reuses the engine's {@link collideParticle} — the
   * exact narrowphase the rigid solver uses — so MPM material feels every shape.
   */
  collideRigid(candidates: Body[]): void {
    if (candidates.length === 0) return;
    const r = this.params.rigidRadius;
    const maxCorr = this.params.dx * 0.5;
    for (const p of this.particles) {
      const invM = 1 / p.mass;
      for (const body of candidates) {
        if (body.isSensor) continue;
        const hit = collideParticle(body, p.pos, r);
        if (!hit) continue;
        const n = hit.normal;
        const cp = hit.point;
        const dynamic = body.type === BodyType.Dynamic && body.awake;

        // --- Position depenetration (two-way) ---
        const d = Math.min(hit.depth, maxCorr);
        if (!dynamic) {
          p.pos = p.pos.add(n.mul(d));
        } else {
          const rB = cp.sub(body.worldCenter);
          const rn = rB.cross(n);
          const kN = body.invMass + body.invInertia * rn * rn;
          const total = invM + kN;
          if (total > 0) {
            const P = d / total;
            p.pos = p.pos.add(n.mul(P * invM));
            const newCenter = body.worldCenter.sub(n.mul(P * body.invMass));
            const newAngle = body.angle - body.invInertia * rn * P;
            const q = Rot.fromAngle(newAngle);
            body.worldCenter = newCenter;
            body.transform = new Transform(newCenter.sub(q.apply(body.localCenter)), q);
          }
        }

        // --- Velocity impulse (two-way) ---
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
        if (vn < target) {
          const jn = (target - vn) / wN;
          p.vel = p.vel.add(n.mul(jn * invM));
          if (dynamic) body.applyImpulse(n.mul(-jn), cp);

          // Coulomb friction bounded by the normal impulse.
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
              if (dynamic) body.applyImpulse(td.mul(-jt), cp);
            }
          }
        }
      }
    }
  }

  /** Bodies whose AABB overlaps the (margin-expanded) particle extent. */
  private rigidCandidates(bodies: Body[]): Body[] {
    if (bodies.length === 0) return bodies;
    const region = this.aabb(this.params.dx + this.params.rigidRadius);
    return bodies.filter((b) => b.worldAABB().overlaps(region));
  }

  // ---- Metrics (also used by the verification suite) -----------------------

  stats(): MpmStats {
    const n = this.particles.length;
    if (n === 0) return { count: 0, kineticEnergy: 0, meanJp: 1, meanSpeed: 0 };
    let ke = 0;
    let jp = 0;
    let speed = 0;
    for (const p of this.particles) {
      ke += 0.5 * p.mass * p.vel.lengthSq();
      jp += p.Jp;
      speed += p.vel.length();
    }
    return { count: n, kineticEnergy: ke, meanJp: jp / n, meanSpeed: speed / n };
  }

  /** Net particle linear momentum `Σ mᵥ`. */
  linearMomentum(): Vec2 {
    let s = Vec2.ZERO;
    for (const p of this.particles) s = s.add(p.vel.mul(p.mass));
    return s;
  }

  /** Net particle angular momentum about `c`, `Σ m·(x−c)×v` (PIC part only). */
  angularMomentum(c: Vec2 = Vec2.ZERO): number {
    let l = 0;
    for (const p of this.particles) l += p.mass * p.pos.sub(c).cross(p.vel);
    return l;
  }

  /**
   * The **APIC** angular momentum about `c` — the quantity the affine transfer
   * conserves exactly. Besides the orbital `Σ m·(x−c)×v` it counts the spin
   * stored in each particle's affine matrix, `Σ m·(dx²/4)·(C₂₁−C₁₂)`. (The
   * factor `dx²/4` is the second moment `D` of the quadratic B-spline stencil.)
   * For a force-free transfer this equals {@link gridAngularMomentum} to machine
   * precision — the property the verifier asserts.
   */
  apicAngularMomentum(c: Vec2 = Vec2.ZERO): number {
    const k = (this.params.dx * this.params.dx) / 4;
    let l = 0;
    for (const p of this.particles) {
      l += p.mass * (p.pos.sub(c).cross(p.vel) + k * (p.C.c - p.C.b));
    }
    return l;
  }

  /** Total particle mass. */
  totalMass(): number {
    let m = 0;
    for (const p of this.particles) m += p.mass;
    return m;
  }

  /** Total mass currently on the background grid (call after {@link p2g}). */
  gridMass(): number {
    let m = 0;
    for (let i = 0; i < this.gm.length; i++) m += this.gm[i];
    return m;
  }

  /** Grid linear momentum `Σᵢ mᵢ·vᵢ` (call after {@link p2g}+{@link normalizeGrid}). */
  gridLinearMomentum(): Vec2 {
    const n = this.params.nx * this.params.ny;
    let x = 0;
    let y = 0;
    for (let i = 0; i < n; i++) {
      x += this.gm[i] * this.gx[i];
      y += this.gm[i] * this.gy[i];
    }
    return new Vec2(x, y);
  }

  /** Grid angular momentum `Σᵢ (xᵢ−c)×(mᵢ·vᵢ)` about `c`. */
  gridAngularMomentum(c: Vec2 = Vec2.ZERO): number {
    const { nx, ny, dx, origin } = this.params;
    let l = 0;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const node = i + j * nx;
        const m = this.gm[node];
        if (m <= 0) continue;
        const x = origin.x + i * dx - c.x;
        const y = origin.y + j * dx - c.y;
        l += x * (m * this.gy[node]) - y * (m * this.gx[node]);
      }
    }
    return l;
  }

  /** Highest particle (max y). */
  maxHeight(): number {
    let y = -Infinity;
    for (const p of this.particles) if (p.pos.y > y) y = p.pos.y;
    return y;
  }
}

/**
 * Quadratic B-spline weights for a fractional position `fx ∈ [0.5, 1.5)`. The
 * three weights sum to 1 (partition of unity) and reproduce the linear field
 * (first moment zero) — the consistency the verifier asserts.
 */
function quadWeights(fx: number): [number, number, number] {
  const a = 1.5 - fx;
  const b = fx - 1.0;
  const c = fx - 0.5;
  return [0.5 * a * a, 0.75 - b * b, 0.5 * c * c];
}

/**
 * Tangential Coulomb friction at a wall node: the cancelled normal inflow `vnIn`
 * sets the friction budget `μ·|vnIn|`; a tangential velocity smaller than the
 * budget is fully arrested (static friction), otherwise it is reduced by it
 * (kinetic friction). This is what lets a sand pile grip the floor and settle.
 */
function applyFriction(vt: number, mu: number, vnIn: number): number {
  const budget = mu * Math.abs(vnIn);
  if (Math.abs(vt) <= budget) return 0;
  return vt - Math.sign(vt) * budget;
}

/** Cheap deterministic hash → [0,1) for lattice jitter (no global RNG state). */
function hash2(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Re-export so the system's lame helper is reachable for scenes/tuning. */
export { lame };
