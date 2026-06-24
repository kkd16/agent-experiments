// Thin-film interference — the spectral optics of a single dielectric film (a soap
// bubble's wall, the oil sheen on a puddle, the anodised skin of a beetle). When light
// meets a film of thickness d sitting between media n0│n1│n2, part reflects off the top
// interface and part off the bottom; the two reflected waves are out of step by the
// extra optical path the second wave travels, 2·n1·d·cosθ1, so they interfere — and
// because that path is a fixed length in *nanometres* while the phase it produces is
// 2π·(path)/λ, each wavelength interferes differently. The net reflectance R(λ) is
// therefore coloured, and the colour drifts with thickness and viewing angle: the
// structural colour you see in bubbles and oil, no pigment involved.
//
// We solve the exact two-interface Airy summation in closed form (real amplitude
// coefficients for a non-absorbing stack), evaluate it across the visible spectrum, and
// fold R(λ) through the CIE 1931 colour-matching functions into a linear-sRGB reflectance.
// That RGB triple is then used as the microfacet Fresnel term in the BRDF, so the film
// reads identically under the rasterizer's Cook–Torrance path and the path tracer.
//
// Everything here is pure, allocation-light and DOM-free; a one-off `buildFilmLUT` bakes
// the angle dependence into a small table so the inner shading loops stay a lerp.
//
// Identities re-derived in `thinfilm_verify.ts`:
//   • energy:        0 ≤ R(θ,λ) ≤ 1 for every angle/thickness (no film makes light),
//   • d → 0 collapse: a vanishing film reproduces the bare Fresnel reflectance of n0│n2
//                     via the Stokes relation r02 = (r01+r12)/(1+r01·r12),
//   • neutrality:    a non-dispersive flat stack integrates to a neutral grey, and a
//                     perfect reflector integrates to white (the CIE normalisation),
//   • hue drift:     the first-order constructive peak λ ≈ 2·n1·d·cosθ1 moves to longer
//                     wavelengths as the film thickens — bubbles cycle blue→gold→magenta.

// ── CIE 1931 colour-matching functions ──────────────────────────────────────────────
// Wyman, Sloan & Shirley (JCGT 2013) "Simple Analytic Approximations to the CIE XYZ
// Colour Matching Functions": each bar is a sum of asymmetric (piecewise-σ) Gaussians,
// accurate to a few percent and needing no 471-entry table. λ in nanometres.
function gauss(x: number, mu: number, s1: number, s2: number): number {
  const t = (x - mu) * (x < mu ? 1 / s1 : 1 / s2)
  return Math.exp(-0.5 * t * t)
}
function clamp01(x: number): number { return x < 0 ? 0 : x > 1 ? 1 : x }
function cieX(l: number): number {
  return 1.056 * gauss(l, 599.8, 37.9, 31.0) + 0.362 * gauss(l, 442.0, 16.0, 26.7) - 0.065 * gauss(l, 501.1, 20.4, 26.2)
}
function cieY(l: number): number {
  return 0.821 * gauss(l, 568.8, 46.9, 40.5) + 0.286 * gauss(l, 530.9, 16.3, 31.1)
}
function cieZ(l: number): number {
  return 1.217 * gauss(l, 437.0, 11.8, 36.0) + 0.681 * gauss(l, 459.0, 26.0, 13.8)
}

// Visible-spectrum integration grid (equal-energy illuminant E). 360→760 nm is plenty;
// the CMFs are negligible outside it. We precompute the per-sample CMF weights and the
// white-point normaliser once at module load.
const LAMBDA_MIN = 360
const LAMBDA_MAX = 760
const SPECTRAL_SAMPLES = 80
const DL = (LAMBDA_MAX - LAMBDA_MIN) / SPECTRAL_SAMPLES
const LAMBDAS = new Float64Array(SPECTRAL_SAMPLES)
const CMF_X = new Float64Array(SPECTRAL_SAMPLES)
const CMF_Y = new Float64Array(SPECTRAL_SAMPLES)
const CMF_Z = new Float64Array(SPECTRAL_SAMPLES)
let WHITE_R = 1, WHITE_G = 1, WHITE_B = 1 // linear-sRGB colour of a flat unit reflector
let CMF_Y_SUM = 1 // Σ ȳ over the grid — the luminance normaliser
{
  let wx = 0, wy = 0, wz = 0
  for (let i = 0; i < SPECTRAL_SAMPLES; i++) {
    const l = LAMBDA_MIN + (i + 0.5) * DL
    LAMBDAS[i] = l
    const x = cieX(l), y = cieY(l), z = cieZ(l)
    CMF_X[i] = x; CMF_Y[i] = y; CMF_Z[i] = z
    wx += x; wy += y; wz += z
  }
  CMF_Y_SUM = wy
  // normalise so that R(λ) ≡ 1 maps to XYZ = (1,1,1)·k → componentwise white in sRGB.
  const inv = 1 / wy
  const W = xyzToLinearSrgb(wx * inv, wy * inv, wz * inv)
  WHITE_R = W[0]; WHITE_G = W[1]; WHITE_B = W[2]
}

// CIE XYZ → linear sRGB (IEC 61966-2-1, D65). May be negative for out-of-gamut spectra;
// callers clamp at the end.
function xyzToLinearSrgb(X: number, Y: number, Z: number): [number, number, number] {
  return [
    3.2406 * X - 1.5372 * Y - 0.4986 * Z,
    -0.9689 * X + 1.8758 * Y + 0.0415 * Z,
    0.0557 * X - 0.2040 * Y + 1.0570 * Z,
  ]
}

// ── Fresnel amplitude reflection coefficients (real, non-absorbing dielectric) ───────
// rs/rp for the interface n_i│n_t at the given cosines. Standard form; for a clean stack
// these are real numbers in [−1, 1]. Returned as [rs, rp].
function fresnelAmplitude(ni: number, nt: number, cosI: number, cosT: number): [number, number] {
  const rs = (ni * cosI - nt * cosT) / (ni * cosI + nt * cosT + 1e-12)
  const rp = (nt * cosI - ni * cosT) / (nt * cosI + ni * cosT + 1e-12)
  return [rs, rp]
}

// Reflectance of a single film n0│n1│n2 of thickness `dNm`, at outer-incidence cosine
// `cosTheta0`, for one wavelength `lambdaNm`. Closed-form Airy modulus for real coeffs:
//   R = (a² + b² + 2ab·cosφ) / (1 + a²b² + 2ab·cosφ)   averaged over s/p polarisation,
// with a = r01, b = r12 and φ = 4π·n1·d·cosθ1 / λ the round-trip phase inside the film.
// Total internal reflection at either interface is handled by saturating that interface's
// |r| to 1 (the magnitude is exactly unity past the critical angle).
export function filmReflectanceAt(
  cosTheta0: number, n0: number, n1: number, n2: number, dNm: number, lambdaNm: number,
): number {
  const c0 = Math.min(1, Math.max(1e-4, cosTheta0))
  const sin0 = Math.sqrt(Math.max(0, 1 - c0 * c0))
  // refraction into the film (n0·sinθ0 = n1·sinθ1)
  const sin1 = (n0 / n1) * sin0
  // and through to the substrate (n0·sinθ0 = n2·sinθ2) — Snell is transitive across the film
  const sin2 = (n0 / n2) * sin0

  // top interface n0│n1: n0 < n1 in every film we model, so no TIR here
  const cos1 = Math.sqrt(Math.max(0, 1 - sin1 * sin1))
  const [rs01, rp01] = fresnelAmplitude(n0, n1, c0, cos1)

  // bottom interface n1│n2: if n1 > n2 a steep angle can exceed the critical angle → TIR
  let rs12: number, rp12: number
  if (sin2 >= 1) {
    rs12 = 1; rp12 = 1 // |r| = 1 at/under TIR (phase shift of TIR is approximated away)
  } else {
    const cos2 = Math.sqrt(Math.max(0, 1 - sin2 * sin2))
    ;[rs12, rp12] = fresnelAmplitude(n1, n2, cos1, cos2)
  }

  const phi = (4 * Math.PI * n1 * dNm * cos1) / lambdaNm
  const cosPhi = Math.cos(phi)

  const airy = (a: number, b: number): number => {
    const ab = a * b
    const num = a * a + b * b + 2 * ab * cosPhi
    const den = 1 + ab * ab + 2 * ab * cosPhi
    const R = num / (den + 1e-12)
    return R < 0 ? 0 : R > 1 ? 1 : R
  }
  return 0.5 * (airy(rs01, rs12) + airy(rp01, rp12))
}

// Spectral → linear-sRGB reflectance of the film at outer-incidence cosine `cosTheta0`.
// Integrates R(λ) against the CIE CMFs under an equal-energy illuminant, converts to
// linear sRGB and divides by the flat-unit-reflector white so a featureless stack stays
// neutral and a perfect reflector is exactly [1,1,1]. Out-of-gamut negatives are clamped.
export function filmReflectanceRGB(
  cosTheta0: number, n0: number, n1: number, n2: number, dNm: number, out: Float64Array,
): void {
  let X = 0, Y = 0, Z = 0
  for (let i = 0; i < SPECTRAL_SAMPLES; i++) {
    const R = filmReflectanceAt(cosTheta0, n0, n1, n2, dNm, LAMBDAS[i])
    X += R * CMF_X[i]; Y += R * CMF_Y[i]; Z += R * CMF_Z[i]
  }
  // same 1/Σȳ scale used to set the white point → reflectance ≡ 1 reproduces white
  const inv = 1 / (CMF_Y_SUM)
  const rgb = xyzToLinearSrgb(X * inv, Y * inv, Z * inv)
  out[0] = clamp01(rgb[0] / WHITE_R)
  out[1] = clamp01(rgb[1] / WHITE_G)
  out[2] = clamp01(rgb[2] / WHITE_B)
}

// ── baked angle LUT ──────────────────────────────────────────────────────────────────
// The film's RGB reflectance depends on the incidence cosine; thickness and IORs are
// fixed per material. We bake `size` entries over cosθ ∈ (0,1] once, so the BRDF evaluates
// the film with a single lerp. Index 0 holds the grazing limit, `size-1` the head-on value.
export interface FilmLUT {
  rgb: Float32Array // size × 3
  size: number
}

export function buildFilmLUT(n1: number, n2: number, dNm: number, size = 64, n0 = 1.0): FilmLUT {
  const rgb = new Float32Array(size * 3)
  const tmp = new Float64Array(3)
  for (let i = 0; i < size; i++) {
    const cos = (i + 0.5) / size // (0,1]
    filmReflectanceRGB(cos, n0, n1, n2, dNm, tmp)
    rgb[i * 3] = tmp[0]; rgb[i * 3 + 1] = tmp[1]; rgb[i * 3 + 2] = tmp[2]
  }
  return { rgb, size }
}

// Sample the baked LUT at incidence cosine `cosTheta`, writing linear-sRGB into out[0..2].
export function sampleFilmLUT(lut: FilmLUT, cosTheta: number, out: Float64Array): void {
  const c = cosTheta < 0 ? 0 : cosTheta > 1 ? 1 : cosTheta
  const x = c * lut.size - 0.5
  const i0 = Math.max(0, Math.min(lut.size - 1, Math.floor(x)))
  const i1 = Math.min(lut.size - 1, i0 + 1)
  const f = x - Math.floor(x)
  const a = i0 * 3, b = i1 * 3
  const g = f < 0 ? 0 : f > 1 ? 1 : f
  out[0] = lut.rgb[a] * (1 - g) + lut.rgb[b] * g
  out[1] = lut.rgb[a + 1] * (1 - g) + lut.rgb[b + 1] * g
  out[2] = lut.rgb[a + 2] * (1 - g) + lut.rgb[b + 2] * g
}

// A module-level cache so the rasterizer (which re-shades every frame) and repeated
// scene rebuilds share one LUT per (thickness, filmIor, baseIor) triple.
const lutCache = new Map<string, FilmLUT>()
export function getFilmLUT(dNm: number, n1: number, n2: number): FilmLUT {
  const key = `${dNm.toFixed(1)}|${n1.toFixed(3)}|${n2.toFixed(3)}`
  let lut = lutCache.get(key)
  if (!lut) { lut = buildFilmLUT(n1, n2, dNm); lutCache.set(key, lut) }
  return lut
}
