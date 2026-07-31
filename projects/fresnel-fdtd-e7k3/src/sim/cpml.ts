/**
 * Convolutional Perfectly Matched Layer (CPML / CFS-PML) absorbing boundary.
 *
 * The domain edges must read as *open space* — an outgoing wave has to leave and
 * never come back. The cheap "sponge" (a graded lossy layer) reflects a few
 * percent, which contaminates any quantitative measurement. A PML instead warps
 * space with a complex coordinate stretch so that plane waves decay inside the
 * layer with **no impedance mismatch at any angle or frequency**, giving
 * reflections 40–70 dB below the sponge.
 *
 * This is the Roden–Gedney *convolutional* PML with the Complex-Frequency-Shifted
 * (CFS) tensor. Each stretched derivative ∂/∂x → (1/κx)∂/∂x + ψ, where ψ is a
 * discrete convolution updated recursively:
 *
 *     ψ^{n+1} = b·ψ^n + a·(field difference)
 *
 * with per-depth coefficients (a, b, κ) graded polynomially into the layer.
 *
 * ── Normalized units ────────────────────────────────────────────────────────
 * The host solver uses dx = 1, c = 1, dt = Sc, ε0 = 1/η0. Folding dt/ε0 = Sc·η0
 * into the conductivity gives a *normalized* profile S = σ·dt/ε0 that is free of
 * η0: the optimal peak works out to S_max = 0.8·(m+1)·Sc (Taflove §7.8 with
 * dx = 1, εr = 1). The α (CFS) and κ terms are dimensionless. The result: a PML
 * whose only inputs are grid-relative, so it just works at any resolution.
 */

export interface CpmlParams {
  /** layer thickness in cells */
  thickness: number;
  /** polynomial grading order for σ and κ (typically 3–4) */
  m: number;
  /** peak normalized conductivity; auto ≈ 0.8·(m+1)·Sc if <= 0 */
  sigmaMax: number;
  /** peak real coordinate stretch κ (1 = none; 5–15 helps grazing incidence) */
  kappaMax: number;
  /** peak CFS frequency shift α (normalized; damps late-time/evanescent energy) */
  alphaMax: number;
}

export const DEFAULT_CPML: Omit<CpmlParams, 'thickness' | 'sigmaMax'> & {
  thickness: number;
  sigmaMax: number;
} = {
  thickness: 12,
  m: 3,
  sigmaMax: -1, // auto ≈ 0.8·(m+1)·Sc
  // κ = 1 is optimal for near-normal incidence (the common case) and reaches
  // ~−70 dB here; raising κ only helps very grazing/evanescent waves and adds
  // reflection for propagating ones. A small CFS α damps late-time energy.
  kappaMax: 1,
  alphaMax: 0.05,
};

/** Per-axis CPML coefficient arrays (length N), one set for E nodes and one for
 *  H nodes (offset by half a cell). Interior indices have a = 0, b = 1, invK = 1
 *  so the stretched update reduces bit-for-bit to the plain Yee update. */
export interface CpmlAxis {
  bE: Float32Array;
  aE: Float32Array;
  invKE: Float32Array;
  bH: Float32Array;
  aH: Float32Array;
  invKH: Float32Array;
}

/** Fractional depth into the PML at continuous position `pos` (0 outside). */
function depthFrac(pos: number, N: number, T: number): number {
  if (T <= 0) return 0;
  if (pos < T) return (T - pos) / T; // left edge: →1 at pos=0
  if (pos > N - 1 - T) return (pos - (N - 1 - T)) / T; // right edge
  return 0;
}

function coeffAt(rho: number, sMax: number, kMax: number, aMax: number, m: number) {
  if (rho <= 0) return { b: 1, a: 0, invK: 1 };
  const g = Math.pow(rho, m);
  const sigma = sMax * g;
  const kappa = 1 + (kMax - 1) * g;
  // CFS α grades the *other* way: max at the inner interface, 0 at the outer edge.
  const alpha = aMax * (1 - rho);
  const b = Math.exp(-(sigma / kappa + alpha));
  const denom = kappa * (sigma + kappa * alpha);
  const a = denom > 0 ? (sigma * (b - 1)) / denom : 0;
  return { b, a, invK: 1 / kappa };
}

/** Build the CPML coefficient arrays for one axis of length `N`. */
export function buildCpmlAxis(N: number, Sc: number, p: CpmlParams): CpmlAxis {
  const T = Math.min(p.thickness, Math.floor((N - 2) / 2));
  const sMax = p.sigmaMax > 0 ? p.sigmaMax : 0.8 * (p.m + 1) * Sc;
  const bE = new Float32Array(N);
  const aE = new Float32Array(N);
  const invKE = new Float32Array(N);
  const bH = new Float32Array(N);
  const aH = new Float32Array(N);
  const invKH = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const e = coeffAt(depthFrac(i, N, T), sMax, p.kappaMax, p.alphaMax, p.m);
    bE[i] = e.b;
    aE[i] = e.a;
    invKE[i] = e.invK;
    const h = coeffAt(depthFrac(i + 0.5, N, T), sMax, p.kappaMax, p.alphaMax, p.m);
    bH[i] = h.b;
    aH[i] = h.a;
    invKH[i] = h.invK;
  }
  return { bE, aE, invKE, bH, aH, invKH };
}
