import { Complex, C } from './Complex';
import { hermitianEig } from './Hermitian';

/**
 * Periodic anisotropic XY chain in a transverse field, solved in **momentum space**, and the
 * non-equilibrium physics it makes exactly tractable: the **dynamical quantum phase transition
 * (DQPT)** and its integer **dynamical topological order parameter**.
 *
 *   H = −J Σⱼ [ (1+γ)/2 XⱼXⱼ₊₁ + (1−γ)/2 YⱼYⱼ₊₁ ] − h Σⱼ Zⱼ   (periodic boundaries)
 *
 * γ = 1 is the transverse-field Ising chain; γ = 0 the isotropic XX model. With periodic
 * boundaries the Jordan–Wigner fermions live in a fixed parity sector, and the Hamiltonian
 * becomes BLOCK-DIAGONAL in momentum: each pair (k, −k) is an independent two-level system — an
 * **Anderson pseudospin** in the field
 *
 *   d⃗(k) = ( d_y, d_z ) = ( J γ sin k ,  h − J cos k ),     εₖ = 2|d⃗(k)|
 *
 * (εₖ is the Bogoliubov dispersion; its gap closes at the quantum critical point h = J for γ ≠ 0,
 * and along the line γ = 0, |h| < J). The ground state is the product over k>0 of each pair's
 * pseudospin-down state, |GS⟩ = Πₖ (cos(θₖ/2) − i sin(θₖ/2) c_k†c_{−k}†)|0⟩.
 *
 * # Dynamical quantum phase transition (Heyl–Polkovnikov–Kehrein 2013)
 * Quench h_i → h_f. Because the state stays a product over momentum pairs, the **Loschmidt
 * amplitude** factorises:
 *
 *   G(t) = ⟨ψ₀| e^{−iH_f t} |ψ₀⟩ = Πₖ>0 Gₖ(t),   |Gₖ(t)|² = 1 − sin²(Δθₖ)·sin²(εₖ^f t)
 *
 * with Δθₖ the angle between the initial and final pseudospin fields d⃗ᵢ(k), d⃗_f(k). The
 * **return-rate function** l(t) = −lim_{N→∞}(1/N) ln|G(t)|² then develops **non-analytic cusps**
 * (the analogue of free-energy non-analyticities at an equilibrium transition) whenever a
 * **critical mode** k* exists with d⃗ᵢ(k*) ⊥ d⃗_f(k*) — which happens iff the quench *crosses* the
 * equilibrium critical point. The cusps sit at the **critical times** tₙ* = (2n+1)π/εₖ*^f.
 *
 * # Dynamical topological order parameter (Budich–Heyl 2016)
 * The Pancharatnam geometric phase φₖ^G(t) = arg⟨uₖ(0)|uₖ(t)⟩ + Eₖ t (total phase minus the
 * dynamical phase) winds an integer number of times across the Brillouin zone, and that winding
 * ν_D(t) = (1/2π)∮ ∂ₖ φₖ^G dk is **0 before the first DQPT and jumps by exactly +1 at every cusp** —
 * a quantised order parameter for the non-equilibrium "phases" between successive DQPTs.
 *
 * Everything here is cross-checked against an independent dense 2ⁿ oracle (`loschmidtDense`) that
 * builds the periodic XY Hamiltonian and evolves it exactly, sharing no code with this path.
 */

export interface DVec { y: number; z: number; }

/** Anderson-pseudospin field d⃗(k) = (Jγ sin k, h − J cos k). */
export function pseudospinField(k: number, J: number, h: number, gamma: number): DVec {
  return { y: J * gamma * Math.sin(k), z: h - J * Math.cos(k) };
}

/** Bogoliubov dispersion εₖ = 2|d⃗(k)| = 2√((h−J cos k)² + (Jγ sin k)²). */
export function dispersion(k: number, J: number, h: number, gamma: number): number {
  const d = pseudospinField(k, J, h, gamma);
  return 2 * Math.hypot(d.y, d.z);
}

/**
 * Ground-state energy per site of the infinite periodic chain,
 *   e₀ = −(1/π) ∫₀^π |d⃗(k)| dk = −(1/2π) ∫₀^π εₖ dk.
 * For γ = 1 this is exactly the Pfeuty integral −(1/π)∫₀^π √(J²+h²−2Jh cos k) dk.
 */
export function groundEnergyDensity(J: number, h: number, gamma: number, M = 20000): number {
  let s = 0;
  for (let i = 0; i < M; i++) {
    const k = (i + 0.5) * Math.PI / M;
    const d = pseudospinField(k, J, h, gamma);
    s += Math.hypot(d.y, d.z);
  }
  return -(s * Math.PI / M) / Math.PI;
}

/**
 * Transverse magnetisation per site ⟨Z⟩ = (1/π) ∫₀^π (h − J cos k)/|d⃗(k)| dk. → 1 deep in the
 * paramagnet (h ≫ J), and develops the well-known kink/feature across the critical line.
 */
export function transverseMagnetization(J: number, h: number, gamma: number, M = 20000): number {
  let s = 0;
  for (let i = 0; i < M; i++) {
    const k = (i + 0.5) * Math.PI / M;
    const d = pseudospinField(k, J, h, gamma);
    const mag = Math.hypot(d.y, d.z);
    if (mag > 1e-12) s += d.z / mag;
  }
  return s / M;
}

/**
 * Critical momenta k* ∈ (0, π) of a quench h_i → h_f (fixed J, γ): the modes where the initial
 * and final pseudospins are orthogonal, d⃗ᵢ·d⃗_f = 0. Writing c = cos k*, this is the quadratic
 *   J²(1−γ²) c² − J(h_i+h_f) c + (h_i h_f + J²γ²) = 0,
 * which degenerates to the linear c* = (h_i h_f + J²)/(J(h_i+h_f)) at γ = 1. A real root in
 * [−1, 1] exists iff the quench crosses the equilibrium critical point — the condition for a DQPT.
 */
export function criticalModes(J: number, hi: number, hf: number, gamma: number): number[] {
  const a = J * J * (1 - gamma * gamma);
  const b = -J * (hi + hf);
  const c = hi * hf + J * J * gamma * gamma;
  const roots: number[] = [];
  const pushCos = (cos: number) => {
    if (cos > -1 - 1e-12 && cos < 1 + 1e-12) {
      const k = Math.acos(Math.min(1, Math.max(-1, cos)));
      if (k > 1e-9 && k < Math.PI - 1e-9) roots.push(k);
    }
  };
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) pushCos(-c / b);
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      pushCos((-b + sq) / (2 * a));
      pushCos((-b - sq) / (2 * a));
    }
  }
  return roots.sort((x, y) => x - y);
}

/** Does the quench h_i → h_f cross the equilibrium critical point (⇒ a DQPT occurs)? */
export function quenchCrosses(J: number, hi: number, hf: number, gamma: number): boolean {
  return criticalModes(J, hi, hf, gamma).length > 0;
}

/**
 * The DQPT critical times tₙ* = (2n+1)π/εₖ*^f up to `tMax`, for every critical mode k*
 * (anisotropic quenches can have two distinct critical modes → two interleaved cusp combs).
 */
export function criticalTimes(J: number, hi: number, hf: number, gamma: number, tMax: number): number[] {
  const out: number[] = [];
  for (const kc of criticalModes(J, hi, hf, gamma)) {
    const eps = dispersion(kc, J, hf, gamma); // εₖ^f
    if (eps < 1e-9) continue;
    // |Gₖ*|² = 1 − sin²(εₖ^f t) = 0  ⇒  εₖ^f t = π/2 + nπ  ⇒  t = (2n+1)π/(2 εₖ^f).
    for (let n = 0; ; n++) {
      const t = (2 * n + 1) * Math.PI / (2 * eps);
      if (t > tMax) break;
      out.push(t);
    }
  }
  return out.sort((x, y) => x - y);
}

/** Per-mode squared Loschmidt amplitude |Gₖ(t)|² = 1 − sin²(Δθₖ) sin²(εₖ^f t). */
function gkSquared(k: number, J: number, hi: number, hf: number, gamma: number, t: number): number {
  const di = pseudospinField(k, J, hi, gamma);
  const df = pseudospinField(k, J, hf, gamma);
  const ni = Math.hypot(di.y, di.z) || 1e-12;
  const nf = Math.hypot(df.y, df.z) || 1e-12;
  const cosD = (di.y * df.y + di.z * df.z) / (ni * nf);
  const sin2D = Math.max(0, 1 - cosD * cosD);
  const epsF = 2 * nf; // εₖ^f
  return 1 - sin2D * Math.sin(epsF * t) ** 2;
}

/**
 * Thermodynamic-limit return-rate function l(t) = −(1/2π) ∫₀^π ln|Gₖ(t)|² dk, evaluated at each
 * requested time. Cusps appear at the critical times when the quench crosses the critical point.
 */
export function loschmidtRate(
  J: number, hi: number, hf: number, gamma: number, times: number[], M = 4000,
): number[] {
  return times.map((t) => {
    let s = 0;
    for (let m = 0; m < M; m++) {
      const k = (m + 0.5) * Math.PI / M;
      s += Math.log(Math.max(gkSquared(k, J, hi, hf, gamma, t), 1e-300));
    }
    return -(s / M) / 2;
  });
}

/**
 * EXACT finite-N return-rate function in the anti-periodic (even-parity) momentum sector
 *   k = (2m+1)π/n,  m = 0 … n−1,    l_N(t) = −(1/n) Σₖ>0 ln|Gₖ(t)|²,
 * the product over the N/2 positive momenta. This is the closed form the dense periodic ground
 * state realises — `loschmidtDense` reproduces it to machine precision.
 */
export function loschmidtFiniteN(
  n: number, J: number, hi: number, hf: number, gamma: number, times: number[],
): number[] {
  const ks: number[] = [];
  for (let m = 0; m < n; m++) {
    const k = (2 * m + 1) * Math.PI / n;
    if (k > 0 && k < Math.PI) ks.push(k);
  }
  return times.map((t) => {
    let s = 0;
    for (const k of ks) s += Math.log(Math.max(gkSquared(k, J, hi, hf, gamma, t), 1e-300));
    return -s / n;
  });
}

// --- dynamical topological order parameter ----------------------------------------------------
interface Spinor2 { a: Complex; b: Complex; } // (component on |0⟩, component on |1⟩)

/** Geometric phase φₖ^G(t) and the dynamical-phase-subtracted total phase for one mode k. */
function geometricPhase(k: number, J: number, hi: number, hf: number, gamma: number, t: number): number {
  // Use the FULL pseudospin field D⃗ = 2 d⃗ so that its magnitude is the physical dispersion
  // (|D_f| = εₖ^f), matching the Loschmidt frequency. The direction D̂ = d̂ is unchanged.
  const di0 = pseudospinField(k, J, hi, gamma), df0 = pseudospinField(k, J, hf, gamma);
  const di = { y: 2 * di0.y, z: 2 * di0.z };
  const df = { y: 2 * df0.y, z: 2 * df0.z };
  const ni = Math.hypot(di.y, di.z) || 1e-12;
  const nf = Math.hypot(df.y, df.z) || 1e-12;
  // Initial pseudospin: ground state of d⃗ᵢ·τ⃗ → Bloch vector −d̂ᵢ = (0, −diy/ni, −diz/ni).
  const bz = -di.z / ni, by = -di.y / ni;
  const theta = Math.acos(Math.min(1, Math.max(-1, bz)));
  const phi = Math.atan2(by, 0);
  const u: Spinor2 = {
    a: C(Math.cos(theta / 2)),
    b: new Complex(Math.sin(theta / 2) * Math.cos(phi), Math.sin(theta / 2) * Math.sin(phi)),
  };
  // Evolve under H_f,k = D⃗_f·τ⃗ (eigenvalues ±|D_f| = ±εₖ^f), so U = e^{−i(D⃗_f·τ⃗)t} oscillates
  // at the physical dispersion εₖ^f — exactly the frequency in |Gₖ(t)|² above.
  const c = Math.cos(nf * t), s = Math.sin(nf * t);
  const fy = df.y / nf, fz = df.z / nf;
  // U = cI − i s (d̂_f·τ⃗),  d̂_f·τ⃗ = [[fz, −i fy],[i fy, −fz]]
  const U00 = new Complex(c, -s * fz), U01 = new Complex(-s * fy, 0);
  const U10 = new Complex(s * fy, 0), U11 = new Complex(c, s * fz);
  const v: Spinor2 = {
    a: U00.mul(u.a).add(U01.mul(u.b)),
    b: U10.mul(u.a).add(U11.mul(u.b)),
  };
  // ⟨u|v⟩
  const ov = u.a.conj().mul(v.a).add(u.b.conj().mul(v.b));
  // Energy Eₖ = ⟨u|H_f|u⟩ = d⃗_f·(Bloch of u) = d⃗_f·(−d̂ᵢ).
  const E = df.z * (-di.z / ni) + df.y * (-di.y / ni);
  return Math.atan2(ov.im, ov.re) + E * t; // φ^G = arg⟨u|v⟩ + Eₖ t
}

/**
 * Dynamical topological order parameter ν_D(t): the integer winding of the geometric phase
 * φₖ^G(t) across the half Brillouin zone k ∈ [0, π]. It is 0 before the first DQPT and jumps by
 * +1 at every critical time. Returns the winding (rounded to the nearest integer) and the raw value.
 */
export function dtop(
  J: number, hi: number, hf: number, gamma: number, t: number, M = 3000,
): { nu: number; raw: number } {
  let prev = NaN, wind = 0;
  for (let i = 0; i <= M; i++) {
    const k = Math.PI * i / M;
    let g = geometricPhase(k, J, hi, hf, gamma, t);
    g = ((g % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    if (!Number.isNaN(prev)) {
      let d = g - prev;
      if (d > Math.PI) d -= 2 * Math.PI;
      if (d < -Math.PI) d += 2 * Math.PI;
      wind += d;
    }
    prev = g;
  }
  // Orient the winding so it counts UP (+1 per DQPT) as k traverses 0 → π.
  const raw = -wind / (2 * Math.PI);
  return { nu: Math.round(raw), raw };
}

/** ν_D(t) at each requested time (for the integer step-function plot). */
export function dtopSeries(
  J: number, hi: number, hf: number, gamma: number, times: number[], M = 3000,
): number[] {
  return times.map((t) => dtop(J, hi, hf, gamma, t, M).nu);
}

/** The geometric-phase profile φₖ^G(t) across the Brillouin zone at a fixed time (winding plot). */
export function geometricPhaseProfile(
  J: number, hi: number, hf: number, gamma: number, t: number, M = 200,
): { k: number; phi: number }[] {
  const out: { k: number; phi: number }[] = [];
  for (let i = 0; i <= M; i++) {
    const k = Math.PI * i / M;
    let g = geometricPhase(k, J, hi, hf, gamma, t);
    g = ((g % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    out.push({ k, phi: g });
  }
  return out;
}

// --- independent dense oracle ------------------------------------------------------------------

/** Dense 2ⁿ Hamiltonian of the periodic anisotropic XY chain (real symmetric). */
function buildPeriodicXY(n: number, J: number, h: number, gamma: number): Complex[][] {
  const N = 1 << n;
  const H: Complex[][] = Array.from({ length: N }, () => Array.from({ length: N }, () => C(0)));
  const cxx = -J * (1 + gamma) / 2; // coefficient of XⱼXⱼ₊₁
  const cyy = -J * (1 - gamma) / 2; // coefficient of YⱼYⱼ₊₁
  for (let s = 0; s < N; s++) {
    let diag = 0;
    for (let j = 0; j < n; j++) diag += -h * (((s >> j) & 1) ? -1 : 1); // −h Σ Zⱼ
    H[s][s] = H[s][s].add(C(diag));
    for (let j = 0; j < n; j++) {
      const jp = (j + 1) % n;
      const flipped = s ^ (1 << j) ^ (1 << jp);
      H[flipped][s] = H[flipped][s].add(C(cxx)); // XⱼXⱼ₊₁ flips both bits, real +1
      // YⱼYⱼ₊₁: Y|0⟩ = i|1⟩, Y|1⟩ = −i|0⟩, so the two single-bit factors are ±i; their product is
      // real (= −(±1)(±1)). bit=0 → +i, bit=1 → −i.
      const fj = ((s >> j) & 1) ? -1 : 1;
      const fjp = ((s >> jp) & 1) ? -1 : 1;
      H[flipped][s] = H[flipped][s].add(C(cyy * -(fj * fjp))); // (i·fj)(i·fjp) = −fj·fjp
    }
  }
  return H;
}

/**
 * Independent dense reference (n ≲ 10) for the Loschmidt rate: build the 2ⁿ periodic XY
 * Hamiltonian, take the exact ground state of H(h_i), evolve it exactly under H(h_f), and read off
 * l_N(t) = −(1/n) ln|⟨ψ₀|e^{−iH_f t}|ψ₀⟩|². Shares no code with the momentum-space path.
 */
export function loschmidtDense(
  n: number, J: number, hi: number, hf: number, gamma: number, times: number[],
): number[] {
  const N = 1 << n;
  const ei = hermitianEig(buildPeriodicXY(n, J, hi, gamma));
  const gi = ei.values.length - 1; // smallest eigenvalue (values sorted descending)
  const psi0 = ei.vectors.map((row) => row[gi]);
  const ef = hermitianEig(buildPeriodicXY(n, J, hf, gamma));
  // overlaps cₘ = ⟨m|ψ₀⟩
  const cm = ef.values.map((_, m) => {
    let re = 0, im = 0;
    for (let a = 0; a < N; a++) {
      const v = ef.vectors[a][m];
      re += v.re * psi0[a].re + v.im * psi0[a].im;
      im += v.re * psi0[a].im - v.im * psi0[a].re;
    }
    return new Complex(re, im);
  });
  return times.map((t) => {
    let re = 0, im = 0;
    for (let m = 0; m < N; m++) {
      const w = cm[m].abs2();
      const ph = -ef.values[m] * t;
      re += w * Math.cos(ph);
      im += w * Math.sin(ph);
    }
    const g2 = re * re + im * im;
    return -Math.log(Math.max(g2, 1e-300)) / n;
  });
}
