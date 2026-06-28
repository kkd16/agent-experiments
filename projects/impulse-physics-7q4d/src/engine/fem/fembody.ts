import { AABB } from '../aabb';
import { Body, BodyType } from '../body';
import { clamp, EPSILON, Vec2 } from '../math';
import { collideParticle } from '../soft/collide';

/**
 * A continuum-mechanics material. `young` is Young's modulus E (stiffness), `poisson`
 * is ν (incompressibility, 0 ≤ ν < 0.5), `density` is ρ (mass per unit area, the
 * out-of-plane thickness is taken as 1). The two Rayleigh-damping coefficients bleed
 * energy: `dampingMass` (α, a drag proportional to velocity) and `dampingStiff`
 * (β, proportional to the elastic force) — together they turn a perfectly elastic
 * solid into a visco-elastic one that rings down to rest instead of bouncing forever.
 */
export interface FemMaterial {
  young: number;
  poisson: number;
  density: number;
  dampingMass: number;
  dampingStiff: number;
  /**
   * Enable **elastoplasticity**: past a yield stress the material flows
   * permanently instead of springing all the way back (the difference between an
   * elastic band and a paperclip). The model is corotational additive J2 (von
   * Mises) plasticity — see {@link FemBody} — driven by the four params below.
   * Off by default, so a plain `young`/`poisson` material is exactly the old
   * linear-elastic solid.
   */
  plastic: boolean;
  /**
   * Yield stress σ_Y: the von-Mises-equivalent stress at which plastic flow
   * begins. Below it the material is perfectly elastic; above it the excess is
   * relaxed into permanent (plastic) strain. Calibrated so a uniaxial stress
   * state yields exactly when its axial stress reaches σ_Y.
   */
  yieldStress: number;
  /**
   * Isotropic hardening modulus H (stress per unit equivalent plastic strain):
   * the yield surface expands as the material work-hardens, σ_Y → σ_Y + H·ε̄_p,
   * so a cold-worked region becomes harder to deform further. H = 0 is perfect
   * plasticity (a flat yield plateau).
   */
  hardening: number;
  /**
   * Plastic flow rate ∈ (0, 1]: the fraction of the over-stress relaxed each
   * step. 1 is rate-independent (instant radial return to the yield surface);
   * smaller values model viscoplastic creep that flows gradually under sustained
   * load.
   */
  creep: number;
  /**
   * Hard cap on the accumulated plastic strain magnitude (a ductility limit).
   * `Infinity` leaves it uncapped.
   */
  maxPlasticStrain: number;
  /**
   * Enable **ductile damage**: accumulated plastic strain progressively softens
   * an element (continuum-damage mechanics), so an over-worked region necks and
   * ultimately tears. Requires `plastic`. Off by default.
   */
  damage: boolean;
  /** Equivalent plastic strain at which an element is fully damaged (d = 1). */
  failStrain: number;
  /** Residual stiffness fraction of a fully damaged element (keeps CG stable). */
  minStiffness: number;
}

export const DEFAULT_FEM_MATERIAL: FemMaterial = {
  young: 1.2e5,
  poisson: 0.3,
  density: 1,
  dampingMass: 0.4,
  dampingStiff: 0.02,
  plastic: false,
  yieldStress: 0,
  hardening: 0,
  creep: 0.5,
  maxPlasticStrain: Infinity,
  damage: false,
  failStrain: 1,
  minStiffness: 0.02,
};

/**
 * One constant-strain triangle (CST) element. `Ke` is the 6×6 small-strain
 * linear stiffness matrix in the element's *rest* frame, precomputed once. `R`
 * (cosine/sine of the per-step polar rotation of the deformation gradient) is the
 * heart of the **co-rotational** method: each step the element's rigid rotation is
 * factored out so the *linear* `Ke` is only ever applied to the genuinely small
 * elastic strain — large rotations cost no spurious energy. `bcoef` holds the CST
 * shape-function gradients (constant over the element) used to read the strain/stress
 * back out for the heatmap.
 */
interface Element {
  a: number;
  b: number;
  c: number;
  restArea: number;
  /** 6×6 row-major rest-frame stiffness. */
  Ke: Float64Array;
  /** [b0, b1, b2, c0, c1, c2] CST gradient coefficients (already ÷ 2·area). */
  bcoef: Float64Array;
  /** Inverse rest edge matrix Dm⁻¹ = [[m00,m01],[m10,m11]] for F = Ds·Dm⁻¹. */
  dmInv: Float64Array;
  /**
   * 6×3 row-major plastic-coupling matrix area·Bᵀ·D. Maps a plastic strain
   * (Voigt) to the equivalent nodal pre-stress force, so the plastic offset
   * enters the internal force as +area·Bᵀ·D·ε_p. Built once with `Ke`.
   */
  btd: Float64Array;
  /** Accumulated plastic strain ε_p (Voigt [εx, εy, γxy]); zero ⇒ no permanent set. */
  plastic: Float64Array;
  /** Accumulated equivalent (von-Mises) plastic strain ε̄_p — hardening & damage driver. */
  plasticEq: number;
  /** Isotropic damage d ∈ [0, 1] from ductile failure (0 = pristine, 1 = torn). */
  damage: number;
  /** Current polar-rotation cosine/sine (refreshed each step). */
  rc: number;
  rs: number;
}

/** Which per-element field a FEM body's heatmap visualises. */
export type FemHeatmap = 'none' | 'stress' | 'plastic' | 'damage';

/** How the renderer should draw a FEM body. */
export interface FemRender {
  color: string;
  /** Draw the per-element von-Mises stress as a heatmap instead of a flat fill. */
  stressHeatmap: boolean;
  /**
   * Which field to shade as a heatmap. Overrides `stressHeatmap` when set to
   * anything other than `'none'`: `'stress'` (von-Mises load paths), `'plastic'`
   * (where the material has permanently yielded), or `'damage'` (ductile failure
   * / tearing). Left undefined, `stressHeatmap` decides stress-vs-flat as before.
   */
  heatmap?: FemHeatmap;
}

/** Plane-stress constitutive matrix D (3×3, symmetric) for a material. */
function planeStressD(E: number, nu: number): [number, number, number] {
  const f = E / (1 - nu * nu);
  // D = f · [[1, nu, 0], [nu, 1, 0], [0, 0, (1-nu)/2]] — return (d00, d01, d22).
  return [f, f * nu, (f * (1 - nu)) / 2];
}

/**
 * A deformable body simulated with **co-rotational linear finite elements** and an
 * **implicit (backward-Euler) integrator**. This is a genuinely different paradigm
 * from the XPBD soft bodies: instead of position constraints it discretises the
 * continuum elasticity PDE on a triangle mesh, assembles the tangent stiffness, and
 * solves one sparse linear system per step with a matrix-free conjugate-gradient
 * solver. The pay-off is *physical fidelity* — a clamped beam sags to the deflection
 * Euler–Bernoulli beam theory predicts, the material is parameterised by real
 * Young's modulus / Poisson ratio, and the stress field is recoverable for a heatmap.
 *
 * State is stored in flat `Float64Array`s (positions, velocities, masses) so the CG
 * solver operates on plain length-2N vectors with no per-node allocation. Pinned
 * nodes (invMass 0) become Dirichlet boundary conditions, enforced by a projected CG.
 */
export class FemBody {
  /** Node positions, interleaved [x0,y0,x1,y1,…]. Primary state. */
  readonly pos: Float64Array;
  /** Node velocities, interleaved. */
  readonly vel: Float64Array;
  /** Rest (material) positions, interleaved — the strain-free configuration. */
  readonly rest: Float64Array;
  /** Lumped node mass and its inverse (0 ⇒ pinned). */
  readonly mass: Float64Array;
  readonly invMass: Float64Array;
  readonly nodeCount: number;
  readonly elements: Element[] = [];

  material: FemMaterial;
  gravityScale = 1;
  friction = 0.4;
  restitution = 0.0;
  /** Disc radius used when colliding a node with the rigid world. */
  nodeRadius = 0.04;
  render: FemRender;

  // CG scratch buffers (length 2N), reused every step.
  private readonly _r: Float64Array;
  private readonly _z: Float64Array;
  private readonly _p: Float64Array;
  private readonly _Ap: Float64Array;
  private readonly _b: Float64Array;
  private readonly _dv: Float64Array;
  private readonly _tmp: Float64Array;
  // Per-element scratch (length 6), reused to keep the solver allocation-free.
  private readonly _q6 = new Float64Array(6);
  private readonly _w6 = new Float64Array(6);
  private readonly _off = new Int32Array(3);

  constructor(restPositions: Float64Array, material: FemMaterial, render: FemRender) {
    this.nodeCount = restPositions.length / 2;
    this.rest = Float64Array.from(restPositions);
    this.pos = Float64Array.from(restPositions);
    this.vel = new Float64Array(restPositions.length);
    this.mass = new Float64Array(this.nodeCount);
    this.invMass = new Float64Array(this.nodeCount);
    this.material = material;
    this.render = render;

    const n = restPositions.length;
    this._r = new Float64Array(n);
    this._z = new Float64Array(n);
    this._p = new Float64Array(n);
    this._Ap = new Float64Array(n);
    this._b = new Float64Array(n);
    this._dv = new Float64Array(n);
    this._tmp = new Float64Array(n);
  }

  /**
   * Append a triangle element on rest nodes (a, b, c). The CST stiffness `Ke` is
   * built from the rest geometry once; the lumped element mass is split equally to
   * its three nodes. Nodes are reordered to counter-clockwise so the signed rest
   * area (and the derived stiffness) is positive.
   */
  addElement(a: number, b: number, c: number): void {
    const ax = this.rest[2 * a], ay = this.rest[2 * a + 1];
    let bx = this.rest[2 * b], by = this.rest[2 * b + 1];
    let cx = this.rest[2 * c], cy = this.rest[2 * c + 1];
    // Signed area ×2; flip winding to CCW if needed.
    let area2 = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (area2 < 0) {
      const t = b; b = c; c = t;
      const tx = bx, ty = by;
      bx = cx; by = cy; cx = tx; cy = ty;
      area2 = -area2;
    }
    if (area2 < EPSILON) return; // degenerate sliver — skip
    const area = area2 * 0.5;

    // CST shape-function gradients (∂N/∂x, ∂N/∂y), constant over the element.
    const b0 = (by - cy) / area2, b1 = (cy - ay) / area2, b2 = (ay - by) / area2;
    const c0 = (cx - bx) / area2, c1 = (ax - cx) / area2, c2 = (bx - ax) / area2;
    const bcoef = new Float64Array([b0, b1, b2, c0, c1, c2]);

    // Ke = area · Bᵀ·D·B with B (3×6) the strain–displacement matrix.
    const [d00, d01, d22] = planeStressD(this.material.young, this.material.poisson);
    const Ke = new Float64Array(36);
    // Build B columns per node: [[bi,0],[0,ci],[ci,bi]].
    const bs = [b0, b1, b2];
    const cs = [c0, c1, c2];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const bi = bs[i], ci = cs[i], bj = bs[j], cj = cs[j];
        // Bᵢᵀ · D · Bⱼ is a 2×2 block. D = [[d00,d01,0],[d01,d00,0],[0,0,d22]].
        const k00 = bi * d00 * bj + ci * d22 * cj;
        const k01 = bi * d01 * cj + ci * d22 * bj;
        const k10 = ci * d01 * bj + bi * d22 * cj;
        const k11 = ci * d00 * cj + bi * d22 * bj;
        const ri = 2 * i, rj = 2 * j;
        Ke[(ri) * 6 + rj] += area * k00;
        Ke[(ri) * 6 + rj + 1] += area * k01;
        Ke[(ri + 1) * 6 + rj] += area * k10;
        Ke[(ri + 1) * 6 + rj + 1] += area * k11;
      }
    }

    // Plastic-coupling matrix btd = area·Bᵀ·D (6×3, row-major). Row 2i is node i's
    // x-dof, row 2i+1 its y-dof. Bᵀ row 2i = [bᵢ, 0, cᵢ], row 2i+1 = [0, cᵢ, bᵢ];
    // D = [[d00,d01,0],[d01,d00,0],[0,0,d22]]. Consistent with Ke = btd·B.
    const btd = new Float64Array(18);
    for (let i = 0; i < 3; i++) {
      const bi = bs[i], ci = cs[i];
      // x-dof row: [bi,0,ci]·D
      btd[(2 * i) * 3 + 0] = area * bi * d00;
      btd[(2 * i) * 3 + 1] = area * bi * d01;
      btd[(2 * i) * 3 + 2] = area * ci * d22;
      // y-dof row: [0,ci,bi]·D
      btd[(2 * i + 1) * 3 + 0] = area * ci * d01;
      btd[(2 * i + 1) * 3 + 1] = area * ci * d00;
      btd[(2 * i + 1) * 3 + 2] = area * bi * d22;
    }

    // Rest edge matrix Dm = [b−a | c−a]; store its inverse for F = Ds·Dm⁻¹.
    const m00 = bx - ax, m01 = cx - ax, m10 = by - ay, m11 = cy - ay;
    const det = m00 * m11 - m01 * m10;
    const di = 1 / det;
    const dmInv = new Float64Array([m11 * di, -m01 * di, -m10 * di, m00 * di]);

    this.elements.push({
      a, b, c, restArea: area, Ke, bcoef, dmInv, btd,
      plastic: new Float64Array(3), plasticEq: 0, damage: 0, rc: 1, rs: 0,
    });

    // Lump a third of the element mass onto each node.
    const m = (this.material.density * area) / 3;
    this.mass[a] += m;
    this.mass[b] += m;
    this.mass[c] += m;
  }

  /** Finalise masses → inverse masses. Call once after every element is added. */
  finalize(): void {
    for (let i = 0; i < this.nodeCount; i++) {
      this.invMass[i] = this.mass[i] > 0 ? 1 / this.mass[i] : 0;
    }
  }

  /** Pin a node in place (invMass 0): a Dirichlet boundary condition. */
  pin(i: number): void {
    this.invMass[i] = 0;
  }

  /** Pin every node whose rest x-coordinate is ≤ `x` (clamp one wall of a beam). */
  pinWhereX(maxX: number): number {
    let count = 0;
    for (let i = 0; i < this.nodeCount; i++) {
      if (this.rest[2 * i] <= maxX) {
        this.invMass[i] = 0;
        count++;
      }
    }
    return count;
  }

  // ---- The implicit step ----------------------------------------------------

  /**
   * Refresh each element's co-rotational frame: the polar-decomposition rotation
   * R of the deformation gradient F = Ds·Dm⁻¹. In 2-D the best-fit rotation has a
   * closed form — angle = atan2(F₁₀−F₀₁, F₀₀+F₁₁) — so this is allocation-free.
   */
  private updateRotations(): void {
    const pos = this.pos;
    for (const e of this.elements) {
      const ax = pos[2 * e.a], ay = pos[2 * e.a + 1];
      const bx = pos[2 * e.b], by = pos[2 * e.b + 1];
      const cx = pos[2 * e.c], cy = pos[2 * e.c + 1];
      // Ds = [b−a | c−a].
      const s00 = bx - ax, s01 = cx - ax, s10 = by - ay, s11 = cy - ay;
      const [i00, i01, i10, i11] = e.dmInv;
      // F = Ds · Dm⁻¹.
      const f00 = s00 * i00 + s01 * i10;
      const f01 = s00 * i01 + s01 * i11;
      const f10 = s10 * i00 + s11 * i10;
      const f11 = s10 * i01 + s11 * i11;
      const tr = f00 + f11;
      const sk = f10 - f01;
      const d = Math.hypot(tr, sk);
      if (d < EPSILON) {
        e.rc = 1; e.rs = 0;
      } else {
        e.rc = tr / d;
        e.rs = sk / d;
      }
    }
  }

  /**
   * Apply the assembled warped stiffness K′ = Σ Rₑ·Kₑ·Rₑᵀ to a length-2N vector
   * `v`, accumulating into `out` (which is cleared first). Per element this is the
   * matrix-free triple product: rotate the element's 3 node vectors by Rᵀ, apply
   * the small 6×6 `Ke`, rotate back by R, scatter-add. This is the only place the
   * global stiffness is ever touched — never assembled densely.
   */
  private applyStiffness(v: Float64Array, out: Float64Array): void {
    out.fill(0);
    const q = this._q6, w = this._w6, off = this._off;
    for (const e of this.elements) {
      const c = e.rc, s = e.rs;
      const soft = this.softness(e);
      off[0] = 2 * e.a; off[1] = 2 * e.b; off[2] = 2 * e.c;
      // q = Rᵀ · v_e  (Rᵀ = [[c, s], [-s, c]]).
      for (let i = 0; i < 3; i++) {
        const vx = v[off[i]], vy = v[off[i] + 1];
        q[2 * i] = c * vx + s * vy;
        q[2 * i + 1] = -s * vx + c * vy;
      }
      // w = Ke · q  (softened by damage so a torn element loses stiffness).
      const Ke = e.Ke;
      for (let i = 0; i < 6; i++) {
        let sum = 0;
        const row = i * 6;
        for (let j = 0; j < 6; j++) sum += Ke[row + j] * q[j];
        w[i] = soft * sum;
      }
      // out_e += R · w  (R = [[c, -s], [s, c]]).
      for (let i = 0; i < 3; i++) {
        const wx = w[2 * i], wy = w[2 * i + 1];
        out[off[i]] += c * wx - s * wy;
        out[off[i] + 1] += s * wx + c * wy;
      }
    }
  }

  /**
   * Per-element stiffness multiplier from ductile damage: a pristine element
   * returns 1, a fully-torn one its material's `minStiffness` floor. The same
   * factor scales the internal force, the tangent stiffness and the read-out
   * stress, so a damaged region consistently bears less load.
   */
  private softness(e: Element): number {
    if (e.damage <= 0) return 1;
    const floor = this.material.minStiffness;
    return 1 - (1 - floor) * e.damage;
  }

  /**
   * Assemble the current internal elastic force fₑ = Rₑ·Kₑ·(Xₑ − Rₑᵀ·xₑ) into
   * `out` (cleared first). When the element is a pure rigid rotation of its rest
   * shape, Rᵀ·x = X and the force vanishes — the defining property of the
   * co-rotational formulation, and the thing pure linear FEM gets catastrophically
   * wrong under large rotations.
   */
  private internalForce(out: Float64Array): void {
    out.fill(0);
    const pos = this.pos, rest = this.rest;
    const w = this._q6, k = this._w6, off = this._off;
    for (const e of this.elements) {
      const c = e.rc, s = e.rs;
      const soft = this.softness(e);
      off[0] = 2 * e.a; off[1] = 2 * e.b; off[2] = 2 * e.c;
      // w = X_e − Rᵀ·x_e.
      for (let i = 0; i < 3; i++) {
        const xx = pos[off[i]], xy = pos[off[i] + 1];
        w[2 * i] = rest[off[i]] - (c * xx + s * xy);
        w[2 * i + 1] = rest[off[i] + 1] - (-s * xx + c * xy);
      }
      // k = Ke·w + btd·ε_p. The plastic pre-stress shifts the element's
      // stress-free configuration: at zero plastic strain this is the pure
      // elastic restoring force; with ε_p ≠ 0 the body relaxes toward a
      // permanently-deformed rest shape (the defining property of plasticity).
      const Ke = e.Ke, btd = e.btd, p = e.plastic;
      const p0 = p[0], p1 = p[1], p2 = p[2];
      for (let i = 0; i < 6; i++) {
        let sum = 0;
        const row = i * 6;
        for (let j = 0; j < 6; j++) sum += Ke[row + j] * w[j];
        const r3 = i * 3;
        sum += btd[r3] * p0 + btd[r3 + 1] * p1 + btd[r3 + 2] * p2;
        k[i] = soft * sum;
      }
      // out_e += R · k.
      for (let i = 0; i < 3; i++) {
        const kx = k[2 * i], ky = k[2 * i + 1];
        out[off[i]] += c * kx - s * ky;
        out[off[i] + 1] += s * kx + c * ky;
      }
    }
  }

  /**
   * The plastic corrector. Once per step (after the corotational frames refresh,
   * before the force assembly) every element's elastic trial strain is tested
   * against the von-Mises yield surface; any excess is relaxed into permanent
   * plastic strain by a **radial return**, the equivalent plastic strain
   * accumulates (driving isotropic hardening and ductile damage), and the total
   * plastic strain is capped at the ductility limit. With `plastic` off this is a
   * no-op, so a plain elastic material is bit-for-bit unchanged.
   *
   * The yield/flow live in deviatoric strain space (additive corotational J2, the
   * standard real-time continuum-plasticity model): the equivalent stress is
   * σ̄ = 2√2·μ·‖dev ε_e‖ with μ = E/(2(1+ν)), calibrated so a uniaxial stress
   * state yields exactly at σ̄ = σ_Y. Plastic flow is deviatoric (traceless), so
   * — like real metal plasticity — it preserves area to first order.
   */
  private updatePlasticity(): void {
    const m = this.material;
    if (!m.plastic) return;
    const mu = m.young / (2 * (1 + m.poisson));
    if (mu <= EPSILON) return;
    const kStress = 2 * Math.SQRT2 * mu; // σ̄ = kStress · ‖dev ε_e‖
    const creep = clamp(m.creep, 0, 1);
    const capped = Number.isFinite(m.maxPlasticStrain);
    const eqFactor = Math.sqrt(2 / 3);
    const pos = this.pos, rest = this.rest;
    const u = this._q6;
    for (const e of this.elements) {
      const c = e.rc, s = e.rs;
      const ia = 2 * e.a, ib = 2 * e.b, ic = 2 * e.c;
      const off = [ia, ib, ic];
      // Corotational displacement u = Rᵀx − X, then total strain ε = B·u (Voigt).
      for (let i = 0; i < 3; i++) {
        const xx = pos[off[i]], xy = pos[off[i] + 1];
        u[2 * i] = (c * xx + s * xy) - rest[off[i]];
        u[2 * i + 1] = (-s * xx + c * xy) - rest[off[i] + 1];
      }
      const [b0, b1, b2, c0, c1, c2] = e.bcoef;
      const ex = b0 * u[0] + b1 * u[2] + b2 * u[4];
      const ey = c0 * u[1] + c1 * u[3] + c2 * u[5];
      const gxy = c0 * u[0] + b0 * u[1] + c1 * u[2] + b1 * u[3] + c2 * u[4] + b2 * u[5];
      const p = e.plastic;
      // Elastic trial strain ε_e = ε − ε_p and its deviator (tensor convention,
      // engineering shear γ = 2·ε_xy).
      const eex = ex - p[0], eey = ey - p[1], egxy = gxy - p[2];
      const mean = 0.5 * (eex + eey);
      const dxx = eex - mean, dyy = eey - mean, dxy = 0.5 * egxy;
      const n = Math.sqrt(dxx * dxx + dyy * dyy + 2 * dxy * dxy);
      if (n > EPSILON) {
        const yieldStress = m.yieldStress + m.hardening * e.plasticEq;
        const nYield = yieldStress / kStress;
        if (n > nYield) {
          const dn = creep * (n - nYield);
          const scale = dn / n;
          p[0] += scale * dxx;
          p[1] += scale * dyy;
          p[2] += scale * 2 * dxy;
          e.plasticEq += eqFactor * dn;
          if (capped) {
            const pm = 0.5 * (p[0] + p[1]);
            const pdx = p[0] - pm, pdy = p[1] - pm, pds = 0.5 * p[2];
            const pn = Math.sqrt(pdx * pdx + pdy * pdy + 2 * pds * pds);
            if (pn > m.maxPlasticStrain && pn > EPSILON) {
              const f = m.maxPlasticStrain / pn;
              p[0] *= f; p[1] *= f; p[2] *= f;
            }
          }
        }
      }
      if (m.damage && m.failStrain > EPSILON) {
        e.damage = clamp(e.plasticEq / m.failStrain, 0, 1);
      }
    }
  }

  /**
   * Advance the body one rigid timestep with **linearised backward Euler**. Treating
   * the per-element rotation R as fixed within the step (stiffness warping), the
   * implicit update is the single SPD linear system
   *
   *     (M + h·C + h²·K′)·Δv = h·(f_int + f_ext − h·K′·v)
   *
   * with Rayleigh damping C = α·M + β·K′. The system matrix never materialises:
   * `applyA` evaluates its action and a projected conjugate gradient solves it,
   * zeroing the pinned degrees of freedom so they stay fixed. Implicit integration
   * is what lets a stiff material run stably at the engine's fixed 1/60 step.
   */
  step(bodies: Body[], gravity: Vec2, dt: number, cgIters = 60, cgTol = 1e-7): void {
    if (dt <= 0) return;
    const h = dt;
    const n = this.pos.length;
    const { dampingMass: alpha, dampingStiff: beta } = this.material;

    this.updateRotations();
    // Plastic corrector: relax any over-stress into permanent strain before the
    // forces are assembled, so this step already pulls toward the yielded shape.
    this.updatePlasticity();

    // f_int (elastic) + f_ext (gravity) → _b temporarily holds f0.
    this.internalForce(this._b);
    const gx = gravity.x * this.gravityScale, gy = gravity.y * this.gravityScale;
    for (let i = 0; i < this.nodeCount; i++) {
      if (this.invMass[i] === 0) continue;
      this._b[2 * i] += this.mass[i] * gx;
      this._b[2 * i + 1] += this.mass[i] * gy;
    }

    // rhs b = h·(f0 − h·K′·v).
    this.applyStiffness(this.vel, this._tmp); // _tmp = K′·v
    for (let i = 0; i < n; i++) this._b[i] = h * (this._b[i] - h * this._tmp[i]);
    this.zeroPinned(this._b);

    // Solve A·Δv = b, A = (1+hα)·M + (hβ+h²)·K′.
    const massCoef = 1 + h * alpha;
    const stiffCoef = h * beta + h * h;
    this.solveCG(massCoef, stiffCoef, cgIters, cgTol);

    // v += Δv; x += h·v  (free nodes only).
    for (let i = 0; i < this.nodeCount; i++) {
      if (this.invMass[i] === 0) {
        this.vel[2 * i] = 0;
        this.vel[2 * i + 1] = 0;
        continue;
      }
      this.vel[2 * i] += this._dv[2 * i];
      this.vel[2 * i + 1] += this._dv[2 * i + 1];
      this.pos[2 * i] += h * this.vel[2 * i];
      this.pos[2 * i + 1] += h * this.vel[2 * i + 1];
    }

    // Collide nodes with the rigid world (position depenetration + velocity pass).
    if (bodies.length > 0) this.collideRigid(bodies);
  }

  /** Matrix-free A·p = massCoef·M·p + stiffCoef·K′·p, written to `out`. */
  private applyA(p: Float64Array, massCoef: number, stiffCoef: number, out: Float64Array): void {
    this.applyStiffness(p, out); // out = K′·p
    for (let i = 0; i < this.nodeCount; i++) {
      const m = this.mass[i];
      out[2 * i] = massCoef * m * p[2 * i] + stiffCoef * out[2 * i];
      out[2 * i + 1] = massCoef * m * p[2 * i + 1] + stiffCoef * out[2 * i + 1];
    }
    this.zeroPinned(out);
  }

  /**
   * Projected, Jacobi-preconditioned conjugate gradient solving A·Δv = b for the
   * step's velocity change. The preconditioner is the (dominant) mass diagonal of A.
   * Pinned DOFs are projected to zero each iteration so they act as a fixed wall.
   * Δv is written into `_dv`.
   */
  private solveCG(massCoef: number, stiffCoef: number, maxIters: number, tol: number): void {
    const n = this.pos.length;
    const dv = this._dv, r = this._r, z = this._z, p = this._p, Ap = this._Ap, b = this._b;
    dv.fill(0);
    r.set(b); // r = b − A·0 = b (already pinned-zeroed)

    const bnorm = dot(b, b);
    if (bnorm < tol * tol) {
      dv.fill(0);
      return;
    }

    // Jacobi preconditioner: invert the mass-diagonal of A (cheap, robust).
    const applyPre = (src: Float64Array, dst: Float64Array): void => {
      for (let i = 0; i < this.nodeCount; i++) {
        if (this.invMass[i] === 0) {
          dst[2 * i] = 0;
          dst[2 * i + 1] = 0;
          continue;
        }
        const d = massCoef * this.mass[i];
        const inv = d > EPSILON ? 1 / d : 0;
        dst[2 * i] = src[2 * i] * inv;
        dst[2 * i + 1] = src[2 * i + 1] * inv;
      }
    };

    applyPre(r, z);
    p.set(z);
    let rz = dot(r, z);

    for (let it = 0; it < maxIters; it++) {
      this.applyA(p, massCoef, stiffCoef, Ap);
      const pAp = dot(p, Ap);
      if (Math.abs(pAp) < EPSILON) break;
      const alpha = rz / pAp;
      for (let i = 0; i < n; i++) {
        dv[i] += alpha * p[i];
        r[i] -= alpha * Ap[i];
      }
      if (dot(r, r) < tol * tol * bnorm) break;
      applyPre(r, z);
      const rzNew = dot(r, z);
      const beta = rzNew / rz;
      rz = rzNew;
      for (let i = 0; i < n; i++) p[i] = z[i] + beta * p[i];
    }
  }

  private zeroPinned(v: Float64Array): void {
    for (let i = 0; i < this.nodeCount; i++) {
      if (this.invMass[i] === 0) {
        v[2 * i] = 0;
        v[2 * i + 1] = 0;
      }
    }
  }

  /**
   * Resolve every node against the rigid world: a position push-out followed by a
   * restitution + Coulomb-friction velocity impulse, the equal-and-opposite share
   * fed back into the rigid body (two-way coupling, exactly the soft engine's
   * bridge). Run after the implicit position update so contacts see the final pose.
   */
  private collideRigid(bodies: Body[]): void {
    const region = this.aabb(0.1);
    const candidates = bodies.filter((b) => !b.isSensor && b.worldAABB().overlaps(region));
    if (candidates.length === 0) return;
    const maxCorr = 0.2;
    for (let i = 0; i < this.nodeCount; i++) {
      if (this.invMass[i] === 0) continue;
      let px = this.pos[2 * i], py = this.pos[2 * i + 1];
      for (const body of candidates) {
        const hit = collideParticle(body, new Vec2(px, py), this.nodeRadius);
        if (!hit) continue;
        const corr = Math.min(hit.depth, maxCorr);
        px += hit.normal.x * corr;
        py += hit.normal.y * corr;
        this.pos[2 * i] = px;
        this.pos[2 * i + 1] = py;
        this.resolveContactVelocity(i, body, hit.normal, hit.point);
      }
    }
  }

  private resolveContactVelocity(i: number, body: Body, n: Vec2, cp: Vec2): void {
    const im = this.invMass[i];
    const v = new Vec2(this.vel[2 * i], this.vel[2 * i + 1]);
    const rB = cp.sub(body.worldCenter);
    const vB = body.velocityAt(cp);
    const vRel = v.sub(vB);
    const vn = vRel.dot(n);

    const rn = rB.cross(n);
    const wB = body.invMass + body.invInertia * rn * rn;
    const wN = im + wB;
    if (wN <= 0) return;

    const e = Math.max(this.restitution, body.restitution);
    const target = vn < 0 ? -e * vn : 0;
    let vx = v.x, vy = v.y;
    let jn = 0;
    if (vn < target) {
      jn = (target - vn) / wN;
      vx += n.x * jn * im;
      vy += n.y * jn * im;
      if (body.type === BodyType.Dynamic) body.applyImpulse(n.mul(-jn), cp);
    }

    if (jn > 0) {
      const t = vRel.sub(n.mul(vn));
      const tlen = t.length();
      if (tlen > EPSILON) {
        const td = t.mul(1 / tlen);
        const rt = rB.cross(td);
        const wT = im + body.invMass + body.invInertia * rt * rt;
        if (wT > 0) {
          const mu = Math.sqrt(this.friction * body.friction);
          const jt = clamp(-tlen / wT, -mu * jn, mu * jn);
          vx += td.x * jt * im;
          vy += td.y * jt * im;
          if (body.type === BodyType.Dynamic) body.applyImpulse(td.mul(-jt), cp);
        }
      }
    }
    this.vel[2 * i] = vx;
    this.vel[2 * i + 1] = vy;
  }

  // ---- Metrics, queries & rendering data ------------------------------------

  /** Node world position as a {@link Vec2}. */
  node(i: number): Vec2 {
    return new Vec2(this.pos[2 * i], this.pos[2 * i + 1]);
  }

  nodeVel(i: number): Vec2 {
    return new Vec2(this.vel[2 * i], this.vel[2 * i + 1]);
  }

  /** A tight AABB over the nodes, expanded by `margin`. */
  aabb(margin = 0): AABB {
    let lo = new Vec2(Infinity, Infinity);
    let hi = new Vec2(-Infinity, -Infinity);
    const r = this.nodeRadius + margin;
    for (let i = 0; i < this.nodeCount; i++) {
      const px = this.pos[2 * i], py = this.pos[2 * i + 1];
      lo = lo.min(new Vec2(px - r, py - r));
      hi = hi.max(new Vec2(px + r, py + r));
    }
    return new AABB(lo, hi);
  }

  centroid(): Vec2 {
    let x = 0, y = 0;
    for (let i = 0; i < this.nodeCount; i++) {
      x += this.pos[2 * i];
      y += this.pos[2 * i + 1];
    }
    return new Vec2(x / this.nodeCount, y / this.nodeCount);
  }

  totalMass(): number {
    let m = 0;
    for (let i = 0; i < this.nodeCount; i++) m += this.mass[i];
    return m;
  }

  /** Net linear momentum of the free nodes — for conservation checks. */
  linearMomentum(): Vec2 {
    let x = 0, y = 0;
    for (let i = 0; i < this.nodeCount; i++) {
      if (this.invMass[i] === 0) continue;
      x += this.mass[i] * this.vel[2 * i];
      y += this.mass[i] * this.vel[2 * i + 1];
    }
    return new Vec2(x, y);
  }

  kineticEnergy(): number {
    let e = 0;
    for (let i = 0; i < this.nodeCount; i++) {
      e += 0.5 * this.mass[i] * (this.vel[2 * i] ** 2 + this.vel[2 * i + 1] ** 2);
    }
    return e;
  }

  /**
   * Total elastic strain energy U = ½·Σₑ uₑᵀ·Kₑ·uₑ, with uₑ the co-rotational
   * displacement Rᵀx − X. Zero at rest, invariant under rigid motion — the
   * potential whose gradient is the internal force.
   */
  elasticEnergy(): number {
    this.updateRotations();
    const pos = this.pos, rest = this.rest;
    let U = 0;
    for (const e of this.elements) {
      const c = e.rc, s = e.rs;
      const idx = [e.a, e.b, e.c];
      const u = new Float64Array(6);
      for (let i = 0; i < 3; i++) {
        const xx = pos[2 * idx[i]], xy = pos[2 * idx[i] + 1];
        u[2 * i] = (c * xx + s * xy) - rest[2 * idx[i]];
        u[2 * i + 1] = (-s * xx + c * xy) - rest[2 * idx[i] + 1];
      }
      const Ke = e.Ke;
      for (let i = 0; i < 6; i++) {
        let row = 0;
        const off = i * 6;
        for (let j = 0; j < 6; j++) row += Ke[off + j] * u[j];
        U += 0.5 * u[i] * row;
      }
    }
    return U;
  }

  /** Apply an instantaneous velocity change to every free node. */
  applyVelocity(delta: Vec2): void {
    for (let i = 0; i < this.nodeCount; i++) {
      if (this.invMass[i] === 0) continue;
      this.vel[2 * i] += delta.x;
      this.vel[2 * i + 1] += delta.y;
    }
  }

  /**
   * Von-Mises stress of element `k` in its co-rotational frame. The strain is read
   * straight from the constant CST gradients, ε = B·u (u = Rᵀx − X), the stress is
   * σ = D·ε, and the scalar invariant √(σx² − σxσy + σy² + 3τ²) drives the heatmap.
   */
  elementStress(k: number): number {
    this.updateRotations();
    return this._stress(k);
  }

  /** Von-Mises stress of element `k` using the *current* (already-refreshed) frames. */
  private _stress(k: number): number {
    const e = this.elements[k];
    const c = e.rc, s = e.rs;
    const pos = this.pos, rest = this.rest;
    const u = this._q6;
    const ia = 2 * e.a, ib = 2 * e.b, ic = 2 * e.c;
    const off = [ia, ib, ic];
    for (let i = 0; i < 3; i++) {
      const xx = pos[off[i]], xy = pos[off[i] + 1];
      u[2 * i] = (c * xx + s * xy) - rest[off[i]];
      u[2 * i + 1] = (-s * xx + c * xy) - rest[off[i] + 1];
    }
    const [b0, b1, b2, c0, c1, c2] = e.bcoef;
    // Elastic strain ε_e = ε − ε_p (stress comes only from the elastic part, so a
    // fully-yielded region correctly relaxes onto the von-Mises plateau), then
    // softened by ductile damage.
    const p = e.plastic;
    const ex = b0 * u[0] + b1 * u[2] + b2 * u[4] - p[0];
    const ey = c0 * u[1] + c1 * u[3] + c2 * u[5] - p[1];
    const gxy = c0 * u[0] + b0 * u[1] + c1 * u[2] + b1 * u[3] + c2 * u[4] + b2 * u[5] - p[2];
    const [d00, d01, d22] = planeStressD(this.material.young, this.material.poisson);
    const soft = this.softness(e);
    const sx = soft * (d00 * ex + d01 * ey);
    const sy = soft * (d01 * ex + d00 * ey);
    const txy = soft * (d22 * gxy);
    return Math.sqrt(Math.max(0, sx * sx - sx * sy + sy * sy + 3 * txy * txy));
  }

  /**
   * Per-element von-Mises stress for the whole body in one O(elements) pass
   * (refreshes the co-rotational frames once). The renderer's heatmap consumes this.
   */
  computeStresses(): Float64Array {
    this.updateRotations();
    const out = new Float64Array(this.elements.length);
    for (let k = 0; k < this.elements.length; k++) out[k] = this._stress(k);
    return out;
  }

  /**
   * Per-element equivalent (von-Mises) plastic strain ε̄_p — how far each element
   * has permanently flowed. Zero everywhere on a purely elastic body; the
   * renderer's plastic heatmap consumes it. (Geometry only; no frame refresh.)
   */
  computePlasticStrain(): Float64Array {
    const out = new Float64Array(this.elements.length);
    for (let k = 0; k < this.elements.length; k++) out[k] = this.elements[k].plasticEq;
    return out;
  }

  /** Per-element ductile damage d ∈ [0, 1] (0 = pristine, 1 = torn). */
  computeDamage(): Float64Array {
    const out = new Float64Array(this.elements.length);
    for (let k = 0; k < this.elements.length; k++) out[k] = this.elements[k].damage;
    return out;
  }

  /** Largest equivalent plastic strain over all elements (heatmap normalisation). */
  peakPlasticStrain(): number {
    let m = 0;
    for (const e of this.elements) if (e.plasticEq > m) m = e.plasticEq;
    return m;
  }

  /** Whether any element has accumulated plastic strain (a permanent set exists). */
  hasYielded(): boolean {
    for (const e of this.elements) if (e.plasticEq > EPSILON) return true;
    return false;
  }

  /** The plastic strain ε_p (Voigt [εx, εy, γxy]) of element `k` — diagnostics/tests. */
  plasticStrainOf(k: number): Vec2 {
    const p = this.elements[k].plastic;
    return new Vec2(p[0], p[1]);
  }

  /** Equivalent plastic strain ε̄_p of element `k`. */
  equivalentPlasticStrain(k: number): number {
    return this.elements[k].plasticEq;
  }

  /** Ductile damage of element `k`. */
  damageOf(k: number): number {
    return this.elements[k].damage;
  }

  /**
   * The model's von-Mises-equivalent stress σ̄ = 2√2·μ·‖dev ε_e‖ for element `k`,
   * the quantity compared against the yield stress. After yielding it sits on the
   * (hardened) yield plateau — the property the plasticity tests assert.
   */
  equivalentStress(k: number): number {
    this.updateRotations();
    const e = this.elements[k];
    const c = e.rc, s = e.rs;
    const pos = this.pos, rest = this.rest;
    const u = this._q6;
    const off = [2 * e.a, 2 * e.b, 2 * e.c];
    for (let i = 0; i < 3; i++) {
      const xx = pos[off[i]], xy = pos[off[i] + 1];
      u[2 * i] = (c * xx + s * xy) - rest[off[i]];
      u[2 * i + 1] = (-s * xx + c * xy) - rest[off[i] + 1];
    }
    const [b0, b1, b2, c0, c1, c2] = e.bcoef;
    const p = e.plastic;
    const eex = b0 * u[0] + b1 * u[2] + b2 * u[4] - p[0];
    const eey = c0 * u[1] + c1 * u[3] + c2 * u[5] - p[1];
    const egxy = c0 * u[0] + b0 * u[1] + c1 * u[2] + b1 * u[3] + c2 * u[4] + b2 * u[5] - p[2];
    const mean = 0.5 * (eex + eey);
    const dxx = eex - mean, dyy = eey - mean, dxy = 0.5 * egxy;
    const mu = this.material.young / (2 * (1 + this.material.poisson));
    return 2 * Math.SQRT2 * mu * Math.sqrt(dxx * dxx + dyy * dyy + 2 * dxy * dxy);
  }

  /**
   * Run a single plastic corrector pass at the current configuration (no
   * dynamics) — refresh the corotational frames, then return-map every element.
   * Lets a test impose a known strain and read the resulting permanent set, and
   * lets a scene "anneal" a freshly-posed body. Returns this body for chaining.
   */
  relaxPlasticity(): this {
    this.updateRotations();
    this.updatePlasticity();
    return this;
  }

  /** Clear all permanent state (plastic strain, hardening, damage) — re-anneal. */
  resetPlastic(): void {
    for (const e of this.elements) {
      e.plastic[0] = 0; e.plastic[1] = 0; e.plastic[2] = 0;
      e.plasticEq = 0;
      e.damage = 0;
    }
  }

  /**
   * The assembled internal elastic force vector at the current configuration
   * (length 2N, interleaved). Refreshes the co-rotational frames first, so it is a
   * faithful snapshot — used by the verification suite and any external diagnostics.
   */
  forces(): Float64Array {
    this.updateRotations();
    const f = new Float64Array(this.pos.length);
    this.internalForce(f);
    return f;
  }

  /** Largest per-element von-Mises stress — drives heatmap colour normalisation. */
  peakStress(): number {
    this.updateRotations();
    let m = 0;
    for (let k = 0; k < this.elements.length; k++) {
      const s = this._stress(k);
      if (s > m) m = s;
    }
    return m;
  }

  /** Current (deformed) total area — Σ signed triangle areas. For volume checks. */
  area(): number {
    const pos = this.pos;
    let a = 0;
    for (const e of this.elements) {
      const ax = pos[2 * e.a], ay = pos[2 * e.a + 1];
      const bx = pos[2 * e.b], by = pos[2 * e.b + 1];
      const cx = pos[2 * e.c], cy = pos[2 * e.c + 1];
      a += Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) * 0.5;
    }
    return a;
  }

  /** Rest total area (Σ element rest areas). */
  restArea(): number {
    let a = 0;
    for (const e of this.elements) a += e.restArea;
    return a;
  }
}

function dot(a: Float64Array, b: Float64Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
