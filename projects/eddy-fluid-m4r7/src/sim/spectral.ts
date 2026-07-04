// spectral.ts — a from-scratch **pseudo-spectral** solver for the 2-D
// incompressible Navier–Stokes equations, in the vorticity–streamfunction
// formulation, on the periodic unit torus.
//
// The rest of the studio solves the fluid on a *grid* (Stam's stable fluids, the
// lattice-Boltzmann kinetic models, the finite-volume compressible Euler code).
// This module is a completely different numerical philosophy: it never touches a
// finite-difference stencil. Instead the vorticity field lives in **Fourier
// space** as a set of complex mode amplitudes ω̂(k), every spatial derivative is
// an *exact* algebraic multiply by i·k, and the viscous term is integrated in
// closed form. That is the gold-standard method for 2-D turbulence — it has no
// numerical diffusion, so the famous dual cascade (energy up, enstrophy down)
// emerges cleanly instead of being buried under grid dissipation.
//
// The maths (unit torus [0,1)², so a mode's physical wavenumber is 2π·m):
//
//   ∂ω/∂t + (u·∇)ω = ν ∇²ω  − μ ω  − ν_h (−∇²)^p ω  + f      (2-D vorticity eqn)
//        u = ∂ψ/∂y,   v = −∂ψ/∂x,   ∇²ψ = −ω                 (streamfunction)
//
// In Fourier space, with K² = |2πk|², the streamfunction is a single divide
// (ψ̂ = ω̂/K²), the velocity is û = i·k_y·2π·ψ̂ etc., and *everything linear* —
// viscosity ν K², the large-scale drag μ, and an optional hyperviscosity
// ν_h K^{2p} — collapses to a per-mode decay rate L(k) = −(νK² + μ + ν_h K^{2p}).
// That linear part is integrated **exactly** by an integrating factor e^{L·dt};
// only the nonlinear advection is stepped by a 4th-order Runge–Kutta. This
// "IF-RK4" scheme is unconditionally stable in the viscous term and 4th-order in
// the nonlinear one.
//
// The nonlinear term is evaluated *pseudo-spectrally* in **conservation form**
// N = ∇·(uω) (equal to (u·∇)ω because ∇·u = 0): reconstruct u, v, ω in physical
// space by inverse FFT, form the products u·ω and v·ω there, transform back, and
// take the spectral divergence. Pointwise products alias high modes, so the
// result is truncated by the **2/3 dealiasing rule** (Orszag) — the top third of
// each frequency axis is zeroed, which makes the quadratic product exact for the
// retained band. Because the advection is written as a divergence and dealiased,
// the scheme conserves total circulation exactly and both energy and enstrophy to
// the time-stepping order — which the verification suite checks directly against
// the analytic Taylor–Green decay and the inviscid conservation laws.
//
// No FFT library: it reuses the studio's own `fft2d` (radix-2 Cooley–Tukey),
// with the same DFT convention as the spectra diagnostics (forward transform
// unnormalised, inverse divides by M²), so a snapshot of this solver's velocity
// feeds straight into `energySpectrum` / `energyTransfer` for an independent
// cross-check.

import { fft2d } from './fft';

export interface SpectralParams {
  /** Kinematic viscosity ν — damps small scales, sets the dissipation range. */
  nu: number;
  /** Large-scale (hypo) drag μ: a friction −μω that removes the energy the
   *  inverse cascade piles up at large scales, so forced runs reach a steady
   *  state instead of condensing into one box-sized vortex. */
  friction: number;
  /** Coefficient ν_h of an optional hyperviscous term ν_h(−∇²)^p — a sharper
   *  small-scale sink than ordinary viscosity, widening the inertial range at a
   *  given resolution. 0 disables it. */
  hyperViscosity: number;
  /** Hyperviscosity order p (2 ⇒ ∇⁴, 4 ⇒ ∇⁸ …). */
  hyperOrder: number;
  /** Amplitude of the stochastic small-scale forcing (0 ⇒ freely decaying). */
  forcing: number;
  /** Central integer wavenumber of the forcing ring (energy injected here). */
  forceK: number;
}

export const DEFAULT_SPECTRAL: SpectralParams = {
  nu: 1e-4,
  friction: 0.02,
  hyperViscosity: 0,
  hyperOrder: 2,
  forcing: 0,
  forceK: 0,
};

/** Signed wavenumber index for FFT bin m on an M-point transform (0..M/2 stay,
 *  the upper half wraps to negative frequencies) — matches `fft.ts`. */
function signedK(m: number, M: number): number {
  return m <= M >> 1 ? m : m - M;
}

/** A tiny deterministic PRNG (mulberry32) so forced runs and seeds are
 *  reproducible — the whole studio is deterministic and testable on purpose. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class SpectralNS {
  readonly M: number;
  /** Vorticity spectrum (the state), real & imaginary parts, row-major M×M. */
  wr: Float64Array;
  wi: Float64Array;
  /** Simulated time. */
  t = 0;

  // Per-mode geometry (all length M*M, precomputed once).
  private a: Float64Array; // 2π·kx (signed) — the x wavenumber
  private b: Float64Array; // 2π·ky (signed) — the y wavenumber
  private invK2: Float64Array; // 1/|k|²   (0 at the k=0 mean mode)
  private L: Float64Array; // linear decay rate −(νK² + μ + ν_h K^{2p})
  private dealias: Float64Array; // 2/3-rule truncation mask (1 keep, 0 drop)

  // Integrating-factor exponentials for the current (dt, params); recomputed lazily.
  private E1: Float64Array; // e^{L·dt}
  private E2: Float64Array; // e^{L·dt/2}
  private lastDt = -1;
  private paramSig = '';

  // Scratch buffers reused across nonlinear evaluations (no per-step allocation).
  private s: {
    // RK stage accumulators (spectrum)
    k1r: Float64Array; k1i: Float64Array;
    k2r: Float64Array; k2i: Float64Array;
    k3r: Float64Array; k3i: Float64Array;
    k4r: Float64Array; k4i: Float64Array;
    argr: Float64Array; argi: Float64Array;
    // physical / transform scratch
    pr: Float64Array; pi: Float64Array;
    qr: Float64Array; qi: Float64Array;
    or: Float64Array; oi: Float64Array;
    // forcing spectrum for the current step
    fr: Float64Array; fi: Float64Array;
  };

  private rng: () => number;

  constructor(M: number, seed = 0x1234abcd) {
    if ((M & (M - 1)) !== 0) throw new Error('SpectralNS: M must be a power of two');
    this.M = M;
    const MM = M * M;
    this.wr = new Float64Array(MM);
    this.wi = new Float64Array(MM);
    this.a = new Float64Array(MM);
    this.b = new Float64Array(MM);
    this.invK2 = new Float64Array(MM);
    this.L = new Float64Array(MM);
    this.dealias = new Float64Array(MM);
    this.E1 = new Float64Array(MM);
    this.E2 = new Float64Array(MM);
    this.rng = mulberry32(seed);

    const TWO_PI = 2 * Math.PI;
    const kcut = Math.floor(M / 3); // 2/3 rule: keep |kx|,|ky| ≤ M/3
    for (let ky = 0; ky < M; ky++) {
      const kys = signedK(ky, M);
      for (let kx = 0; kx < M; kx++) {
        const kxs = signedK(kx, M);
        const idx = ky * M + kx;
        const av = TWO_PI * kxs;
        const bv = TWO_PI * kys;
        this.a[idx] = av;
        this.b[idx] = bv;
        const k2 = av * av + bv * bv;
        this.invK2[idx] = k2 > 0 ? 1 / k2 : 0;
        this.dealias[idx] = Math.abs(kxs) <= kcut && Math.abs(kys) <= kcut ? 1 : 0;
      }
    }

    this.s = {
      k1r: new Float64Array(MM), k1i: new Float64Array(MM),
      k2r: new Float64Array(MM), k2i: new Float64Array(MM),
      k3r: new Float64Array(MM), k3i: new Float64Array(MM),
      k4r: new Float64Array(MM), k4i: new Float64Array(MM),
      argr: new Float64Array(MM), argi: new Float64Array(MM),
      pr: new Float64Array(MM), pi: new Float64Array(MM),
      qr: new Float64Array(MM), qi: new Float64Array(MM),
      or: new Float64Array(MM), oi: new Float64Array(MM),
      fr: new Float64Array(MM), fi: new Float64Array(MM),
    };

    this.recomputeL(DEFAULT_SPECTRAL);
  }

  /** (Re)compute the linear decay rate L(k) from the physical parameters. */
  private recomputeL(p: SpectralParams): void {
    const MM = this.M * this.M;
    for (let idx = 0; idx < MM; idx++) {
      const av = this.a[idx];
      const bv = this.b[idx];
      const k2 = av * av + bv * bv;
      let hyper = 0;
      if (p.hyperViscosity > 0 && k2 > 0) hyper = p.hyperViscosity * Math.pow(k2, p.hyperOrder);
      // No drag on the k=0 mean mode (it carries the mean vorticity / circulation).
      const mu = k2 > 0 ? p.friction : 0;
      this.L[idx] = -(p.nu * k2 + mu + hyper);
    }
  }

  /** Precompute e^{L·dt} and e^{L·dt/2} for the integrating factor. */
  private recomputeExp(dt: number, p: SpectralParams): void {
    const sig = `${p.nu}|${p.friction}|${p.hyperViscosity}|${p.hyperOrder}`;
    if (sig !== this.paramSig) {
      this.recomputeL(p);
      this.paramSig = sig;
      this.lastDt = -1;
    }
    if (dt === this.lastDt) return;
    const MM = this.M * this.M;
    for (let idx = 0; idx < MM; idx++) {
      this.E1[idx] = Math.exp(this.L[idx] * dt);
      this.E2[idx] = Math.exp(this.L[idx] * dt * 0.5);
    }
    this.lastDt = dt;
  }

  /**
   * The nonlinear right-hand side N̂(ω̂) = −FFT(∇·(uω)), dealiased, with the
   * (fixed-over-the-step) forcing added. Written into (outr, outi).
   *
   * Conservation form: N = ∇·(uω) = (u·∇)ω since ∇·u = 0. Products are formed in
   * physical space (pseudo-spectral) and the 2/3-rule truncation makes the
   * quadratic exact for the retained band.
   */
  private nonlinear(inr: Float64Array, ini: Float64Array, outr: Float64Array, outi: Float64Array): void {
    const M = this.M;
    const MM = M * M;
    const { pr, pi, qr, qi, or, oi } = this.s;
    const a = this.a;
    const b = this.b;
    const invK2 = this.invK2;

    // Velocity from vorticity: ψ̂ = ω̂/K²; û = i·k_y·ψ̂; v̂ = −i·k_x·ψ̂.
    // (Using physical wavenumbers a = 2π k_x, b = 2π k_y already baked in.)
    for (let idx = 0; idx < MM; idx++) {
      const ik = invK2[idx];
      const psr = inr[idx] * ik;
      const psi = ini[idx] * ik;
      // û = i·b·ψ̂ = (−b·ψ_i) + i(b·ψ_r)
      pr[idx] = -b[idx] * psi;
      pi[idx] = b[idx] * psr;
      // v̂ = −i·a·ψ̂ = (a·ψ_i) + i(−a·ψ_r)
      qr[idx] = a[idx] * psi;
      qi[idx] = -a[idx] * psr;
      // copy ω̂ for its own inverse transform
      or[idx] = inr[idx];
      oi[idx] = ini[idx];
    }
    // Inverse-transform to physical u (pr), v (qr), ω (or). Imag parts ≈ 0.
    fft2d(pr, pi, M, true);
    fft2d(qr, qi, M, true);
    fft2d(or, oi, M, true);

    // Physical products uω (→ pr) and vω (→ qr), reusing the real parts in place.
    for (let i = 0; i < MM; i++) {
      const w = or[i];
      pr[i] = pr[i] * w; // u·ω
      qr[i] = qr[i] * w; // v·ω
      pi[i] = 0;
      qi[i] = 0;
    }
    // Forward-transform the fluxes.
    fft2d(pr, pi, M, false);
    fft2d(qr, qi, M, false);

    // Spectral divergence: N̂ = −(i·a·(uω)^ + i·b·(vω)^), dealiased, + forcing.
    const dz = this.dealias;
    const fr = this.s.fr;
    const fi = this.s.fi;
    for (let idx = 0; idx < MM; idx++) {
      // i·a·p̂ = (−a·p_i) + i(a·p_r); likewise i·b·q̂. Sum, negate.
      const divr = -a[idx] * pi[idx] - b[idx] * qi[idx];
      const divi = a[idx] * pr[idx] + b[idx] * qr[idx];
      const m = dz[idx];
      outr[idx] = -divr * m + fr[idx];
      outi[idx] = -divi * m + fi[idx];
    }
  }

  /**
   * Build the forcing spectrum for this step: band-limited white noise on the
   * ring |k| ≈ forceK, scaled so it injects ~forcing²·dt of energy. Generating it
   * from a *real* physical noise field and masking a symmetric shell keeps the
   * spectrum Hermitian, so the physical forcing is real. Written into (fr, fi).
   */
  private buildForcing(p: SpectralParams, dt: number): void {
    const M = this.M;
    const MM = M * M;
    const fr = this.s.fr;
    const fi = this.s.fi;
    if (p.forcing <= 0 || p.forceK <= 0) {
      fr.fill(0);
      fi.fill(0);
      return;
    }
    // Real white noise → FFT → keep only the forcing shell.
    for (let i = 0; i < MM; i++) {
      fr[i] = this.rng() * 2 - 1;
      fi[i] = 0;
    }
    fft2d(fr, fi, M, false);
    const lo = p.forceK - 1;
    const hi = p.forceK + 1;
    let power = 0;
    for (let ky = 0; ky < M; ky++) {
      const kys = signedK(ky, M);
      for (let kx = 0; kx < M; kx++) {
        const kxs = signedK(kx, M);
        const idx = ky * M + kx;
        const k = Math.hypot(kxs, kys);
        if (k < lo || k > hi || this.dealias[idx] === 0) {
          fr[idx] = 0;
          fi[idx] = 0;
        } else {
          power += fr[idx] * fr[idx] + fi[idx] * fi[idx];
        }
      }
    }
    if (power <= 0) {
      fr.fill(0);
      fi.fill(0);
      return;
    }
    // Normalise the forcing *rate* so the physical field it injects has rms
    // ≈ forcing/√dt — i.e. a white-in-time increment whose per-step contribution
    // Δω ≈ dt·f has rms ≈ forcing·√dt, a steady resolution-independent input.
    // (Σ_k|F̂|² = MM²·⟨f²⟩ in this DFT convention, so rms(f) = √(Σ|F̂|²)/MM.)
    const scale = (p.forcing * MM) / (Math.sqrt(dt) * Math.sqrt(power));
    for (let i = 0; i < MM; i++) {
      fr[i] *= scale;
      fi[i] *= scale;
    }
  }

  /**
   * Advance the vorticity field by dt with integrating-factor RK4. The linear
   * (viscous + drag + hyperviscous) part is integrated exactly by e^{L·dt}; the
   * nonlinear advection by 4th-order RK in the rotated (integrating-factor) frame.
   */
  step(dt: number, p: SpectralParams = DEFAULT_SPECTRAL): void {
    this.recomputeExp(dt, p);
    this.buildForcing(p, dt);
    const MM = this.M * this.M;
    const wr = this.wr;
    const wi = this.wi;
    const E1 = this.E1;
    const E2 = this.E2;
    const {
      k1r, k1i, k2r, k2i, k3r, k3i, k4r, k4i, argr, argi,
    } = this.s;

    // k1 = N(ω)
    this.nonlinear(wr, wi, k1r, k1i);
    // arg2 = E2·ω + (dt/2)·E2·k1
    for (let i = 0; i < MM; i++) {
      argr[i] = E2[i] * (wr[i] + 0.5 * dt * k1r[i]);
      argi[i] = E2[i] * (wi[i] + 0.5 * dt * k1i[i]);
    }
    this.nonlinear(argr, argi, k2r, k2i);
    // arg3 = E2·ω + (dt/2)·k2
    for (let i = 0; i < MM; i++) {
      argr[i] = E2[i] * wr[i] + 0.5 * dt * k2r[i];
      argi[i] = E2[i] * wi[i] + 0.5 * dt * k2i[i];
    }
    this.nonlinear(argr, argi, k3r, k3i);
    // arg4 = E1·ω + dt·E2·k3
    for (let i = 0; i < MM; i++) {
      argr[i] = E1[i] * wr[i] + dt * E2[i] * k3r[i];
      argi[i] = E1[i] * wi[i] + dt * E2[i] * k3i[i];
    }
    this.nonlinear(argr, argi, k4r, k4i);
    // ω⁺ = E1·ω + (dt/6)(E1·k1 + 2·E2·k2 + 2·E2·k3 + k4)
    const c = dt / 6;
    for (let i = 0; i < MM; i++) {
      wr[i] = E1[i] * wr[i] + c * (E1[i] * k1r[i] + 2 * E2[i] * k2r[i] + 2 * E2[i] * k3r[i] + k4r[i]);
      wi[i] = E1[i] * wi[i] + c * (E1[i] * k1i[i] + 2 * E2[i] * k2i[i] + 2 * E2[i] * k3i[i] + k4i[i]);
    }
    this.t += dt;
  }

  // ---- state I/O & seeding --------------------------------------------------

  /** Overwrite the vorticity from a physical field ω(x,y) (M×M, row-major). The
   *  field is transformed to Fourier space and truncated to the dealiased band. */
  setVorticity(omega: Float64Array): void {
    const M = this.M;
    const MM = M * M;
    const re = this.wr;
    const im = this.wi;
    re.set(omega);
    im.fill(0);
    fft2d(re, im, M, false);
    for (let i = 0; i < MM; i++) {
      re[i] *= this.dealias[i];
      im[i] *= this.dealias[i];
    }
    this.t = 0;
  }

  /** Fill `out` (M×M) with the physical vorticity ω(x,y). */
  vorticity(out: Float64Array): void {
    const M = this.M;
    const { or, oi } = this.s;
    or.set(this.wr);
    oi.set(this.wi);
    fft2d(or, oi, M, true);
    out.set(or.subarray(0, M * M));
  }

  /** Fill `u`, `v` (each M×M) with the physical velocity field. */
  velocity(u: Float64Array, v: Float64Array): void {
    const M = this.M;
    const MM = M * M;
    const { pr, pi, qr, qi } = this.s;
    const a = this.a;
    const b = this.b;
    const invK2 = this.invK2;
    for (let idx = 0; idx < MM; idx++) {
      const ik = invK2[idx];
      const psr = this.wr[idx] * ik;
      const psi = this.wi[idx] * ik;
      pr[idx] = -b[idx] * psi;
      pi[idx] = b[idx] * psr;
      qr[idx] = a[idx] * psi;
      qi[idx] = -a[idx] * psr;
    }
    fft2d(pr, pi, M, true);
    fft2d(qr, qi, M, true);
    u.set(pr.subarray(0, MM));
    v.set(qr.subarray(0, MM));
  }

  // ---- diagnostics ----------------------------------------------------------

  /** Mean kinetic energy ½⟨u²+v²⟩ from the spectrum (Parseval). */
  energy(): number {
    const MM = this.M * this.M;
    const norm = 1 / (MM * MM);
    let e = 0;
    for (let idx = 0; idx < MM; idx++) {
      const ik = this.invK2[idx];
      if (ik === 0) continue;
      // ½|û|² + ½|v̂|² = ½|k|²|ψ̂|² = ½|ω̂|²/K².  (|û|²+|v̂|² = |k|²|ψ̂|².)
      const w2 = this.wr[idx] * this.wr[idx] + this.wi[idx] * this.wi[idx];
      e += 0.5 * w2 * ik;
    }
    return e * norm;
  }

  /** Mean enstrophy ½⟨ω²⟩ from the spectrum. */
  enstrophy(): number {
    const MM = this.M * this.M;
    const norm = 1 / (MM * MM);
    let z = 0;
    for (let idx = 0; idx < MM; idx++) {
      const w2 = this.wr[idx] * this.wr[idx] + this.wi[idx] * this.wi[idx];
      z += 0.5 * w2;
    }
    return z * norm;
  }

  /** Max |divergence| of the reconstructed velocity, in spectral space:
   *  ∇·u ↔ i(a·û + b·v̂). Should be ~machine-zero by construction. */
  maxDivergence(): number {
    const M = this.M;
    const MM = M * M;
    const a = this.a;
    const b = this.b;
    const invK2 = this.invK2;
    let m = 0;
    for (let idx = 0; idx < MM; idx++) {
      const ik = invK2[idx];
      const psr = this.wr[idx] * ik;
      const psi = this.wi[idx] * ik;
      const ur = -b[idx] * psi, ui = b[idx] * psr;
      const vr = a[idx] * psi, vi = -a[idx] * psr;
      // i(a û + b v̂): real = −(a ui + b vi), imag = a ur + b vr
      const dr = -(a[idx] * ui + b[idx] * vi);
      const di = a[idx] * ur + b[idx] * vr;
      const mag = Math.hypot(dr, di) / MM;
      if (mag > m) m = mag;
    }
    return m;
  }

  /** Total circulation ∮u·dl = ∫ω dA — the k=0 vorticity mode. Conserved by the
   *  conservation-form advection and undamped by the drag; ~0 for our seeds. */
  circulation(): number {
    return this.wr[0] / (this.M * this.M);
  }
}

/**
 * Seed a **single-shell** vorticity field ω = A(cos 2πx + cos 2πy). Every mode
 * sits on the same wavenumber shell |k| = 2π, so ω = K²ψ and the Jacobian
 * J(ψ,ω) vanishes identically: this is an exact steady solution of the 2-D Euler
 * equations, and under viscosity it decays *analytically* as e^{−ν K² t} with no
 * nonlinear transfer. The verification suite uses it as a closed-form oracle.
 */
export function seedTaylorGreen(sim: SpectralNS, amp = 1): Float64Array {
  const M = sim.M;
  const w = new Float64Array(M * M);
  const TWO_PI = 2 * Math.PI;
  for (let j = 0; j < M; j++) {
    const y = j / M;
    for (let i = 0; i < M; i++) {
      const x = i / M;
      w[j * M + i] = amp * (Math.cos(TWO_PI * x) + Math.cos(TWO_PI * y));
    }
  }
  sim.setVorticity(w);
  return w;
}

/** The exact decay factor of the Taylor–Green seed at time t for viscosity ν
 *  (and drag μ): the single shell K² = (2π)² decays as e^{−(νK²+μ)t}. */
export function taylorGreenDecay(t: number, nu: number, friction = 0): number {
  const K2 = (2 * Math.PI) * (2 * Math.PI);
  return Math.exp(-(nu * K2 + friction) * t);
}

/**
 * Seed a smooth **random multi-scale** vorticity field concentrated near
 * wavenumber `peakK`, with a deterministic RNG so runs are reproducible. Used to
 * start decaying-turbulence runs and the inviscid conservation checks.
 */
export function seedRandomField(sim: SpectralNS, peakK = 6, amp = 1, seed = 12345): Float64Array {
  const M = sim.M;
  const MM = M * M;
  const rng = mulberry32(seed);
  const re = new Float64Array(MM);
  const im = new Float64Array(MM);
  // Build a spectrum peaked at peakK with random phases, Hermitian via a real IFFT.
  for (let ky = 0; ky < M; ky++) {
    const kys = ky <= M >> 1 ? ky : ky - M;
    for (let kx = 0; kx < M; kx++) {
      const kxs = kx <= M >> 1 ? kx : kx - M;
      const idx = ky * M + kx;
      const k = Math.hypot(kxs, kys);
      if (k === 0) continue;
      // A band-pass envelope ∝ k^3 exp(−(k/peakK)²) — smooth, peaked at ~peakK.
      const env = Math.pow(k, 3) * Math.exp(-(k * k) / (peakK * peakK));
      const phase = 2 * Math.PI * rng();
      re[idx] = env * Math.cos(phase);
      im[idx] = env * Math.sin(phase);
    }
  }
  // Inverse transform to a physical (approximately real) field, then re-seed
  // through setVorticity so the state is a clean forward transform.
  fft2d(re, im, M, true);
  const w = new Float64Array(MM);
  let rms = 0;
  for (let i = 0; i < MM; i++) {
    w[i] = re[i];
    rms += re[i] * re[i];
  }
  rms = Math.sqrt(rms / MM) || 1;
  const scale = amp / rms;
  for (let i = 0; i < MM; i++) w[i] *= scale;
  sim.setVorticity(w);
  return w;
}
