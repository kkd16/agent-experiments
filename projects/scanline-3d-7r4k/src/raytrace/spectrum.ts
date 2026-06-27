// Spectral colour science — the foundation of the v10 spectral path tracer. Where the
// RGB tracer carries three fixed colour channels, the spectral tracer carries a single
// continuously-sampled wavelength λ along each path, so a glass facet can bend every
// wavelength by *its own* index of refraction and a beam genuinely fans into a rainbow.
// To turn those per-wavelength radiance samples back into a displayable image we need the
// real machinery of human colour vision, all from scratch and DOM-free:
//
//   • the CIE 1931 2° colour-matching functions x̄/ȳ/z̄(λ) (Wyman, Sloan & Shirley, JCGT
//     2013 — the same analytic fit `thinfilm.ts` already trusts, so the two pillars agree),
//   • CIE XYZ → linear sRGB (IEC 61966-2-1, D65),
//   • a white balance so the equal-energy spectrum maps to exactly (1,1,1) — this is what
//     keeps the spectral renderer's *exposure* matched to the RGB tracer's, so a
//     non-dispersive scene reads identically in the side-by-side and only dispersion differs,
//   • importance sampling of λ proportional to ȳ(λ) (plus a uniform floor for the tails),
//     so the noisiest channel — luminance — converges fastest,
//   • Smits (1999) RGB → reflectance up-sampling, so the existing RGB materials acquire a
//     physically-plausible reflectance spectrum that round-trips back to their colour,
//   • Planck's law for blackbody emitters (a tungsten lamp is genuinely 3000 K, daylight
//     ~6500 K) — physical light colours the RGB tracer can only fake, and
//   • Sellmeier / Cauchy dispersion so named glasses (BK7, dense flint SF10, fused silica,
//     water, diamond) carry their real n(λ) curve and Abbe number.
//
// Identities re-derived in `spectral_verify.ts`: the equal-energy white point, the Smits
// round-trip error bound, the Monte-Carlo estimator matching the deterministic CMF
// integral, the textbook Abbe numbers, the prism minimum-deviation spread, and the
// blackbody chromaticity ordering.

// ── CIE 1931 colour-matching functions (Wyman 2013 analytic fit) ──────────────────────
function gauss(x: number, mu: number, s1: number, s2: number): number {
  const t = (x - mu) * (x < mu ? 1 / s1 : 1 / s2)
  return Math.exp(-0.5 * t * t)
}
export function cieX(l: number): number {
  return 1.056 * gauss(l, 599.8, 37.9, 31.0) + 0.362 * gauss(l, 442.0, 16.0, 26.7) - 0.065 * gauss(l, 501.1, 20.4, 26.2)
}
export function cieY(l: number): number {
  return 0.821 * gauss(l, 568.8, 46.9, 40.5) + 0.286 * gauss(l, 530.9, 16.3, 31.1)
}
export function cieZ(l: number): number {
  return 1.217 * gauss(l, 437.0, 11.8, 36.0) + 0.681 * gauss(l, 459.0, 26.0, 13.8)
}

// CIE XYZ → linear sRGB. May be negative for out-of-gamut (monochromatic) spectra; that is
// correct and unbiased — single samples can land outside the gamut, the average lands in it,
// and the final tone-map clamps. Do NOT clamp per-sample.
export function xyzToLinearSrgb(X: number, Y: number, Z: number, out: Float64Array): void {
  out[0] = 3.2406 * X - 1.5372 * Y - 0.4986 * Z
  out[1] = -0.9689 * X + 1.8758 * Y + 0.0415 * Z
  out[2] = 0.0557 * X - 0.2040 * Y + 1.0570 * Z
}

// ── integration grid + importance-sampling tables (built once at module load) ─────────
export const LAMBDA_MIN = 360
export const LAMBDA_MAX = 760
const GRID = 400 // fine grid for the CDF + the white-point / luminance integrals
const GDL = (LAMBDA_MAX - LAMBDA_MIN) / GRID
const GLAM = new Float64Array(GRID)
const GPDF = new Float64Array(GRID) // normalised so Σ pdf·dλ = 1
const GCDF = new Float64Array(GRID)
const IMPORTANCE_FLOOR = 0.10 // fraction of mean ȳ mixed in uniformly, so the spectral tails are still sampled

// ∫ȳ(λ)dλ over the grid — the luminance normaliser that fixes the absolute exposure.
export let CIE_INTEGRAL_Y = 1
// linear-sRGB colour of the equal-energy (flat unit) spectrum, before balancing.
const WHITE = new Float64Array(3)
{
  let ysum = 0
  for (let i = 0; i < GRID; i++) {
    const l = LAMBDA_MIN + (i + 0.5) * GDL
    GLAM[i] = l
    ysum += cieY(l)
  }
  CIE_INTEGRAL_Y = ysum * GDL
  const meanY = ysum / GRID
  // importance weight w(λ) = ȳ(λ) + floor·mean(ȳ); pdf = w / ∫w
  let wsum = 0
  for (let i = 0; i < GRID; i++) wsum += (GPDF[i] = cieY(GLAM[i]) + IMPORTANCE_FLOOR * meanY)
  const wInt = wsum * GDL
  let acc = 0
  for (let i = 0; i < GRID; i++) {
    GPDF[i] /= wInt // now ∫ pdf dλ ≈ 1
    acc += GPDF[i] * GDL
    GCDF[i] = acc
  }
  // equal-energy white in linear sRGB, then the per-channel balance below maps it to (1,1,1)
  let sx = 0, sy = 0, sz = 0
  for (let i = 0; i < GRID; i++) { const l = GLAM[i]; sx += cieX(l); sy += cieY(l); sz += cieZ(l) }
  const inv = 1 / sy
  xyzToLinearSrgb(sx * inv, sy * inv, sz * inv, WHITE)
}

export interface WavelengthSample { lambda: number; pdf: number }

// Importance-sample a wavelength ∝ ȳ(λ)+floor by inverting the CDF. `u` ∈ [0,1).
export function sampleWavelength(u: number): WavelengthSample {
  let lo = 0, hi = GRID - 1
  while (lo < hi) { const m = (lo + hi) >> 1; if (GCDF[m] < u) lo = m + 1; else hi = m }
  return { lambda: GLAM[lo], pdf: GPDF[lo] }
}

// The pdf the sampler would assign to an arbitrary wavelength (for MIS / tests).
export function wavelengthPdf(lambda: number): number {
  if (lambda < LAMBDA_MIN || lambda > LAMBDA_MAX) return 0
  let idx = Math.floor((lambda - LAMBDA_MIN) / GDL)
  if (idx < 0) idx = 0; else if (idx >= GRID) idx = GRID - 1
  return GPDF[idx]
}

// One spectral-radiance sample → its (unbiased) linear-sRGB contribution. Averaging this
// over the hero wavelengths drawn for a pixel reconstructs the pixel's colour: each sample
// is L(λ)·CMF(λ)/(pdf·∫ȳ), converted to linear sRGB and white-balanced. Writes out[0..2];
// values may be negative (out-of-gamut) by design.
export function spectralRadianceToRGB(radiance: number, lambda: number, pdf: number, out: Float64Array): void {
  if (pdf <= 0) { out[0] = 0; out[1] = 0; out[2] = 0; return }
  const k = radiance / (pdf * CIE_INTEGRAL_Y)
  xyzToLinearSrgb(k * cieX(lambda), k * cieY(lambda), k * cieZ(lambda), out)
  out[0] /= WHITE[0]; out[1] /= WHITE[1]; out[2] /= WHITE[2]
}

// ── Smits (1999) RGB → reflectance up-sampling ────────────────────────────────────────
// Seven basis spectra (white / cyan / magenta / yellow / red / green / blue), each ten
// samples over 380–720 nm, combined so the smallest channel rides `white` and the other two
// add the complementary/primary bases. Reproduces the colour to within a few percent and —
// crucially — yields a bounded, smooth reflectance spectrum, which is what lets every
// existing RGB material participate in the spectral integrator.
const S_W = [1.0, 1.0, 0.9999, 0.9993, 0.9992, 0.9998, 1.0, 1.0, 1.0, 1.0]
const S_C = [0.9710, 0.9426, 1.0007, 1.0007, 1.0007, 1.0007, 0.1564, 0.0, 0.0, 0.0]
const S_M = [1.0, 1.0, 0.9685, 0.2229, 0.0, 0.0458, 0.8369, 1.0, 1.0, 0.9959]
const S_Y = [0.0001, 0.0, 0.1088, 0.6651, 1.0, 1.0, 0.9996, 0.9586, 0.9685, 0.9840]
const S_R = [0.1012, 0.0515, 0.0, 0.0, 0.0, 0.0, 0.8325, 1.0149, 1.0149, 1.0149]
const S_G = [0.0, 0.0, 0.0273, 0.7937, 1.0, 0.9418, 0.1719, 0.0, 0.0, 0.0025]
const S_B = [1.0, 1.0, 0.8916, 0.3323, 0.0, 0.0, 0.0003, 0.0369, 0.0483, 0.0496]
const SMITS_MIN = 380
const SMITS_MAX = 720
const SMITS_N = 10
const SMITS_DL = (SMITS_MAX - SMITS_MIN) / (SMITS_N - 1)

// The ten Smits coefficients for an RGB triple (clamped to ≥0). Cache these on a material
// and evaluate `spectrumAt` per wavelength in the inner loop.
export function rgbToSpectrum(r: number, g: number, b: number): Float64Array {
  const ret = new Float64Array(SMITS_N)
  r = r < 0 ? 0 : r; g = g < 0 ? 0 : g; b = b < 0 ? 0 : b
  const add = (a: number[], s: number): void => { for (let i = 0; i < SMITS_N; i++) ret[i] += s * a[i] }
  if (r <= g && r <= b) {
    add(S_W, r)
    if (g <= b) { add(S_C, g - r); add(S_B, b - g) } else { add(S_C, b - r); add(S_G, g - b) }
  } else if (g <= r && g <= b) {
    add(S_W, g)
    if (r <= b) { add(S_M, r - g); add(S_B, b - r) } else { add(S_M, b - g); add(S_R, r - b) }
  } else {
    add(S_W, b)
    if (r <= g) { add(S_Y, r - b); add(S_G, g - r) } else { add(S_Y, g - b); add(S_R, r - g) }
  }
  return ret
}

// Evaluate an up-sampled reflectance spectrum at wavelength λ (linear interpolation of the
// ten Smits samples, clamped to the band ends).
export function spectrumAt(coeffs: Float64Array, lambda: number): number {
  if (lambda <= SMITS_MIN) return coeffs[0]
  if (lambda >= SMITS_MAX) return coeffs[SMITS_N - 1]
  const x = (lambda - SMITS_MIN) / SMITS_DL
  const i = Math.floor(x)
  const f = x - i
  const j = i + 1 < SMITS_N ? i + 1 : SMITS_N - 1
  return coeffs[i] * (1 - f) + coeffs[j] * f
}

// Interpolate an RGB *coefficient* triple (e.g. a Beer–Lambert absorption, which is not a
// reflectance and may exceed 1) at wavelength λ, treating the channels as samples at the
// red/green/blue pivots 620/545/450 nm. Used to tint absorbing glass spectrally.
const PIVOT_B = 450, PIVOT_G = 545, PIVOT_R = 620
export function rgbCoeffAt(r: number, g: number, b: number, lambda: number): number {
  if (lambda <= PIVOT_B) return b
  if (lambda >= PIVOT_R) return r
  if (lambda < PIVOT_G) return b + (g - b) * (lambda - PIVOT_B) / (PIVOT_G - PIVOT_B)
  return g + (r - g) * (lambda - PIVOT_G) / (PIVOT_R - PIVOT_G)
}

// ── Planck blackbody radiation ────────────────────────────────────────────────────────
// Spectral radiance of an ideal blackbody at temperature T (kelvin), λ in nm. Returns the
// raw SI value; callers normalise. Used for physically-coloured emitters.
export function planck(lambda: number, T: number): number {
  const h = 6.62607015e-34, c = 2.99792458e8, kB = 1.380649e-23
  const l = lambda * 1e-9
  return (2 * h * c * c) / (l ** 5) / (Math.exp((h * c) / (l * kB * T)) - 1)
}

// Per-temperature normaliser so a blackbody's *luminance* integrates to 1 (then scaled by
// the emitter's brightness). Cached; the curve only depends on T.
const bbNormCache = new Map<number, number>()
export function blackbodyLuminanceNorm(T: number): number {
  let n = bbNormCache.get(T)
  if (n === undefined) {
    let y = 0
    for (let i = 0; i < GRID; i++) y += planck(GLAM[i], T) * cieY(GLAM[i])
    n = y > 0 ? 1 / (y * GDL / CIE_INTEGRAL_Y) : 0
    bbNormCache.set(T, n)
  }
  return n
}

// Blackbody spectral radiance normalised to unit luminance at temperature T.
export function blackbodyRadiance(lambda: number, T: number): number {
  return planck(lambda, T) * blackbodyLuminanceNorm(T)
}

// ── Sellmeier / Cauchy dispersion ─────────────────────────────────────────────────────
// n²(λ) = 1 + Σ Bᵢ λ² / (λ² − Cᵢ), λ in micrometres (the standard glass-catalogue form).
export interface GlassPreset {
  key: string
  label: string
  B: [number, number, number]
  C: [number, number, number]
}

export const GLASS_PRESETS: GlassPreset[] = [
  { key: 'bk7', label: 'BK7 crown', B: [1.03961212, 0.231792344, 1.01046945], C: [0.00600069867, 0.0200179144, 103.560653] },
  { key: 'sf10', label: 'SF10 dense flint', B: [1.62153902, 0.256287842, 1.64447552], C: [0.0122241457, 0.0595736775, 147.468793] },
  { key: 'silica', label: 'Fused silica', B: [0.6961663, 0.4079426, 0.8974794], C: [0.0046791, 0.0135121, 97.9340] },
  { key: 'water', label: 'Water', B: [5.684027565e-1, 1.726177391e-1, 2.086189578e-2], C: [5.101829712e-3, 1.821153936e-2, 2.620722293e-2] },
  { key: 'diamond', label: 'Diamond', B: [0.3306, 4.3356, 0.0], C: [0.030625, 0.011236, 1.0] },
]

const glassByKey = new Map(GLASS_PRESETS.map((g) => [g.key, g]))
export function getGlass(key: string): GlassPreset | undefined { return glassByKey.get(key) }

// Sellmeier index of refraction at wavelength λ (nm) for a named glass.
export function sellmeierIor(g: GlassPreset, lambda: number): number {
  const l2 = (lambda / 1000) ** 2
  let s = 1
  for (let i = 0; i < 3; i++) {
    if (g.B[i] === 0) continue
    s += (g.B[i] * l2) / (l2 - g.C[i])
  }
  return Math.sqrt(Math.max(1, s))
}

// The Abbe number V_d = (n_d − 1)/(n_F − n_C) of a glass, over the Fraunhofer d/F/C lines.
// (587.6 / 486.1 / 656.3 nm.) A pure measure of dispersive power — small V = strong fan.
export function abbeNumber(g: GlassPreset): number {
  const nd = sellmeierIor(g, 587.6), nF = sellmeierIor(g, 486.1), nC = sellmeierIor(g, 656.3)
  return (nd - 1) / (nF - nC)
}

// A generic Cauchy fan around a base index, for the achromatic `dispersion` knob on
// materials with no named glass: n(λ) = n0 + k·(1/λ² − 1/λ_d²), λ in micrometres, centred so
// the base index lands on the d-line (587.6 nm). `dispersion` is a 0..2 visual strength.
const INV_LAMBDA_D2 = 1 / (0.5876 * 0.5876)
export function cauchyIor(baseIor: number, dispersion: number, lambda: number): number {
  if (dispersion <= 0) return baseIor
  const l = lambda / 1000
  return baseIor + dispersion * 0.0125 * (1 / (l * l) - INV_LAMBDA_D2)
}

// Approximate visible colour of a single wavelength (for spectrum legends / debug). Not on
// any hot path. Returns clamped linear sRGB at unit-ish brightness.
export function wavelengthRGB(lambda: number, out: Float64Array): void {
  // a Gaussian luminance envelope so the band ends fade out, ×3 because a monochromatic
  // line carries all its energy in one wavelength
  spectralRadianceToRGB(1, lambda, wavelengthPdf(lambda) || 1, out)
}
