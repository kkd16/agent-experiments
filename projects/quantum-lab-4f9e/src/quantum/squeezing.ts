import { Complex, C, EXP_I } from './Complex';
import { jzDiagonal } from './metrology';

/**
 * Spin squeezing — the noise-robust route to sub-shot-noise sensing, built from scratch.
 *
 * The GHZ "cat" reaches the Heisenberg limit but is destroyed by a single decoherence event
 * (the Huelga result). Spin squeezing takes the opposite tack: start from a coherent spin state
 * (all N qubits aligned, the best *classical* probe) and use a nonlinear interaction to *redistribute*
 * the quantum noise — narrowing the spin fluctuation along the direction that matters at the cost of
 * widening it along an irrelevant one, never leaving the symmetric Dicke manifold. The result is a
 * metrologically useful state that beats the standard quantum limit *and* degrades gracefully.
 *
 * The interaction is Kitagawa–Ueda ONE-AXIS TWISTING: H = χ J_z², a shear in the J_y–J_z plane. The
 * useful squeezing is quantified by the WINELAND parameter
 *
 *     ξ²_R = N · (ΔJ_⊥,min)² / |⟨J⟩|²,
 *
 * which is exactly 1 for the coherent state (the SQL) and drops below 1 when the state is squeezed;
 * the phase sensitivity improves by 1/ξ²_R, bounded above by N (the Heisenberg limit). For one-axis
 * twisting the optimum scales as ξ²_R ∝ N^{−2/3} — between the SQL (N⁰) and Heisenberg (N⁻¹).
 *
 * The collective spin operators J_a = ½ Σ_i σ_a^i are applied directly to the 2^N state vector by
 * bit manipulation, so |⟨J⟩|, the full 3×3 covariance matrix, and ξ²_R are all exact.
 */

// ───────────────────────────── collective spin algebra ─────────────────────────────

/** Apply the collective spin operator J_a = ½ Σ_i σ_a^i to a state vector. */
function applyJ(amps: Complex[], n: number, axis: 'x' | 'y' | 'z'): Complex[] {
  const size = amps.length;
  const out = Array.from({ length: size }, () => C(0));
  for (let i = 0; i < n; i++) {
    const bit = 1 << i;
    for (let idx = 0; idx < size; idx++) {
      const a = amps[idx];
      if (a.re === 0 && a.im === 0) continue;
      const isOne = (idx & bit) !== 0;
      if (axis === 'z') {
        out[idx] = out[idx].add(isOne ? a.neg() : a); // Z|0⟩=+, Z|1⟩=−
      } else if (axis === 'x') {
        out[idx ^ bit] = out[idx ^ bit].add(a); // X flips the bit
      } else {
        // Y|0⟩ = i|1⟩, Y|1⟩ = −i|0⟩
        out[idx ^ bit] = out[idx ^ bit].add(isOne ? a.mul(C(0, -1)) : a.mul(C(0, 1)));
      }
    }
  }
  return out.map((z) => z.scale(0.5));
}

/** ⟨u|v⟩ = Σ conj(u)·v. */
function inner(u: Complex[], v: Complex[]): Complex {
  let re = 0;
  let im = 0;
  for (let k = 0; k < u.length; k++) {
    const c = u[k].conj().mul(v[k]);
    re += c.re;
    im += c.im;
  }
  return new Complex(re, im);
}

export interface SpinStats {
  mean: [number, number, number]; // ⟨J⟩
  meanLength: number; // |⟨J⟩|
  cov: number[][]; // symmetric covariance C_ab = Re⟨J_a J_b⟩ − ⟨J_a⟩⟨J_b⟩
  jSquared: number; // ⟨J²⟩ (Casimir; conserved under one-axis twisting)
}

/** Full collective-spin statistics of a state vector. */
export function spinStats(amps: Complex[], n: number): SpinStats {
  const v: Record<string, Complex[]> = {
    x: applyJ(amps, n, 'x'),
    y: applyJ(amps, n, 'y'),
    z: applyJ(amps, n, 'z'),
  };
  const psi = amps;
  const axes = ['x', 'y', 'z'] as const;
  const mean = axes.map((a) => inner(psi, v[a]).re) as [number, number, number];
  const cov: number[][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let a = 0; a < 3; a++) {
    for (let b = 0; b < 3; b++) {
      cov[a][b] = inner(v[axes[a]], v[axes[b]]).re - mean[a] * mean[b];
    }
  }
  const jSquared = inner(v.x, v.x).re + inner(v.y, v.y).re + inner(v.z, v.z).re;
  const meanLength = Math.hypot(mean[0], mean[1], mean[2]);
  return { mean, meanLength, cov, jSquared };
}

// ───────────────────────────── states & one-axis twisting ─────────────────────────────

/** Coherent spin state — all N qubits along +x (|+⟩^⊗N), the optimal classical probe. */
export function coherentSpinState(n: number): Complex[] {
  const size = 1 << n;
  const a = 1 / Math.sqrt(size);
  return Array.from({ length: size }, () => C(a));
}

/** Evolve under one-axis twisting U = e^{−iμ J_z²}; J_z² is diagonal so this is an exact phase. */
export function oneAxisTwist(amps: Complex[], n: number, mu: number): Complex[] {
  const g = jzDiagonal(n);
  return amps.map((z, k) => z.mul(EXP_I(-mu * g[k] * g[k])));
}

// ───────────────────────────── the Wineland squeezing parameter ─────────────────────────────

/** Minimum eigenvalue of a real symmetric 2×2 matrix [[a,b],[b,c]]. */
function minEig2(a: number, b: number, c: number): number {
  const tr = a + c;
  const disc = Math.sqrt(Math.max(0, (a - c) * (a - c) + 4 * b * b));
  return (tr - disc) / 2;
}

/** Two orthonormal vectors spanning the plane perpendicular to a unit vector n. */
function perpBasis(nx: number, ny: number, nz: number): [number[], number[]] {
  // pick a helper axis not parallel to n
  const helper = Math.abs(nx) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  // e1 = normalize(helper × n)
  let e1 = [
    helper[1] * nz - helper[2] * ny,
    helper[2] * nx - helper[0] * nz,
    helper[0] * ny - helper[1] * nx,
  ];
  const l1 = Math.hypot(e1[0], e1[1], e1[2]) || 1;
  e1 = e1.map((x) => x / l1);
  // e2 = n × e1
  const e2 = [
    ny * e1[2] - nz * e1[1],
    nz * e1[0] - nx * e1[2],
    nx * e1[1] - ny * e1[0],
  ];
  return [e1, e2];
}

function quad(cov: number[][], u: number[], v: number[]): number {
  let s = 0;
  for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) s += u[a] * cov[a][b] * v[b];
  return s;
}

export interface Squeezing {
  xi2: number; // Wineland ξ²_R = N·(ΔJ⊥min)²/|⟨J⟩|²
  minVar: number; // (ΔJ⊥,min)²
  meanLength: number; // |⟨J⟩| (contrast)
  gainDb: number; // metrological gain −10·log10(ξ²)
}

/** Wineland spin-squeezing parameter of a state vector (ξ²<1 ⇒ metrologically useful). */
export function squeezingParameter(amps: Complex[], n: number): Squeezing {
  const st = spinStats(amps, n);
  const len = st.meanLength;
  if (len < 1e-12) return { xi2: Infinity, minVar: 0, meanLength: 0, gainDb: -Infinity };
  const [nx, ny, nz] = st.mean.map((x) => x / len);
  const [e1, e2] = perpBasis(nx, ny, nz);
  const a = quad(st.cov, e1, e1);
  const c = quad(st.cov, e2, e2);
  const b = quad(st.cov, e1, e2);
  const minVar = Math.max(0, minEig2(a, b, c));
  const xi2 = (n * minVar) / (len * len);
  return { xi2, minVar, meanLength: len, gainDb: -10 * Math.log10(Math.max(1e-12, xi2)) };
}

// ───────────────────────────── optimisation & curves ─────────────────────────────

export interface OptimalSqueezing {
  bestMu: number;
  xi2: number;
  gainDb: number;
}

/** Scan the twisting strength μ (two-stage refine) for the minimum ξ²_R at fixed N. */
export function optimalSqueezing(n: number, coarse = 240): OptimalSqueezing {
  const css = coherentSpinState(n);
  let best = { mu: 0, xi2: 1 };
  const scan = (lo: number, hi: number, steps: number) => {
    for (let s = 1; s <= steps; s++) {
      const mu = lo + ((hi - lo) * s) / steps;
      const xi2 = squeezingParameter(oneAxisTwist(css, n, mu), n).xi2;
      if (xi2 < best.xi2) best = { mu, xi2 };
    }
  };
  scan(0, 2.0, coarse); // OAT optima live well within μ ∈ (0, 2) for N ≤ ~14
  const w = 2.0 / coarse;
  scan(Math.max(0, best.mu - w), best.mu + w, 120); // refine
  return { bestMu: best.mu, xi2: best.xi2, gainDb: -10 * Math.log10(Math.max(1e-12, best.xi2)) };
}

export interface SqueezeScalePoint {
  n: number;
  xi2: number; // optimal one-axis-twisting squeezing
  sql: number; // = 1
  heisenberg: number; // = 1/N
}

/** Optimal ξ²_R vs N, against the SQL (1) and Heisenberg (1/N) references. */
export function squeezingScaling(nMax: number): SqueezeScalePoint[] {
  const out: SqueezeScalePoint[] = [];
  for (let n = 2; n <= nMax; n++) {
    out.push({ n, xi2: optimalSqueezing(n).xi2, sql: 1, heisenberg: 1 / n });
  }
  return out;
}

export interface MuPoint {
  mu: number;
  xi2: number;
}

/** ξ²_R vs twisting strength μ for a fixed N (the live "squeeze it" curve). */
export function squeezingSweep(n: number, muMax = 1.6, samples = 161): MuPoint[] {
  const css = coherentSpinState(n);
  const out: MuPoint[] = [];
  for (let s = 0; s <= samples; s++) {
    const mu = (muMax * s) / samples;
    out.push({ mu, xi2: squeezingParameter(oneAxisTwist(css, n, mu), n).xi2 });
  }
  return out;
}

/**
 * Husimi-style quasiprobability of the collective spin on the Bloch sphere, sampled on a
 * (θ,φ) grid as |⟨n|ψ⟩|² where |n⟩ = (cos(θ/2)|0⟩ + e^{iφ}sin(θ/2)|1⟩)^⊗N is a spin
 * coherent state — the standard way to *see* the squeezed noise ellipse.
 */
export function husimi(amps: Complex[], n: number, thetaSteps = 40, phiSteps = 80): number[][] {
  const grid: number[][] = [];
  for (let ti = 0; ti <= thetaSteps; ti++) {
    const theta = (Math.PI * ti) / thetaSteps;
    const ct = Math.cos(theta / 2);
    const stt = Math.sin(theta / 2);
    const row: number[] = [];
    for (let pi = 0; pi < phiSteps; pi++) {
      const phi = (2 * Math.PI * pi) / phiSteps;
      // single-qubit coherent amplitudes a0=cos, a1=e^{iφ}sin
      const a0 = C(ct);
      const a1 = EXP_I(phi).scale(stt);
      // ⟨coh|ψ⟩ = Σ_k conj(prod over bits) ψ_k
      let re = 0;
      let im = 0;
      for (let k = 0; k < amps.length; k++) {
        let cr = 1;
        let ci = 0;
        for (let q = 0; q < n; q++) {
          const comp = (k & (1 << q)) ? a1 : a0;
          // multiply (cr+ici) by conj(comp)
          const nr = cr * comp.re + ci * comp.im;
          const ni = ci * comp.re - cr * comp.im;
          cr = nr;
          ci = ni;
        }
        re += cr * amps[k].re - ci * amps[k].im;
        im += cr * amps[k].im + ci * amps[k].re;
      }
      row.push(re * re + im * im);
    }
    grid.push(row);
  }
  return grid;
}
