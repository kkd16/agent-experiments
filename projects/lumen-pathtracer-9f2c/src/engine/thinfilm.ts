// thinfilm.ts — thin-film interference, the wave-optics origin of the iridescent
// colour of soap bubbles, oil slicks, anodised titanium and beetle shells.
//
// A film of thickness d (nanometres) and index n₁ sits on a substrate of index
// n₂. Light reflects partly off the top air→film interface and partly off the
// bottom film→substrate interface; the second reflection travels an extra
// optical path 2·n₁·d·cosθ₁, so the two waves interfere with a phase difference
//
//   δ = (4π · n₁ · d · cosθ₁) / λ.
//
// Constructive interference at one wavelength is destructive at another, so the
// reflectance becomes a vivid function of λ — which is why a single soap film
// shows the whole spectrum. We evaluate the exact two-interface **Airy
// reflectance** per polarisation (s and p) and average them for unpolarised
// light. Because Lumen already commits each path to a hero wavelength for
// dispersion, feeding that λ here yields a full iridescent colour for free.

// Amplitude reflection coefficients (s- and p-polarised) at an interface from a
// medium of index ni (incidence cosine cosI) into one of index nt (refraction
// cosine cosT). These are the Fresnel equations in amplitude (signed) form.
function fresnelAmplitudes(
  ni: number,
  nt: number,
  cosI: number,
  cosT: number,
): { rs: number; rp: number } {
  const rs = (ni * cosI - nt * cosT) / (ni * cosI + nt * cosT)
  const rp = (nt * cosI - ni * cosT) / (nt * cosI + ni * cosT)
  return { rs, rp }
}

// Airy intensity reflectance of a single film for one polarisation, given the
// two interface amplitude coefficients and the round-trip phase δ.
//   R = (r₁² + r₂² + 2 r₁ r₂ cosδ) / (1 + r₁² r₂² + 2 r₁ r₂ cosδ)
function airy(r1: number, r2: number, cosDelta: number): number {
  const num = r1 * r1 + r2 * r2 + 2 * r1 * r2 * cosDelta
  const den = 1 + r1 * r1 * r2 * r2 + 2 * r1 * r2 * cosDelta
  return den > 1e-12 ? num / den : 1
}

// Unpolarised reflectance R(λ) of a thin film of thickness `thicknessNm` and
// index `filmIor` on a substrate `baseIor`, for an incidence cosine `cosI` in
// air (index 1). Returns a value in [0, 1].
export function thinFilmReflectance(
  cosI: number,
  lambdaNm: number,
  thicknessNm: number,
  filmIor: number,
  baseIor: number,
): number {
  const n0 = 1
  const n1 = filmIor
  const n2 = baseIor
  const c0 = Math.min(1, Math.max(0, cosI))
  const sin0sq = 1 - c0 * c0
  // Refraction into the film (n1 ≥ 1, so this never totally reflects).
  const sin1sq = (n0 * n0 * sin0sq) / (n1 * n1)
  const c1 = Math.sqrt(Math.max(0, 1 - sin1sq))
  // Refraction into the substrate; total internal reflection there ⇒ r₂ = ±1.
  const sin2sq = (n0 * n0 * sin0sq) / (n2 * n2)
  const tir2 = sin2sq >= 1
  const c2 = tir2 ? 0 : Math.sqrt(Math.max(0, 1 - sin2sq))

  const top = fresnelAmplitudes(n0, n1, c0, c1) // air → film
  const bot = tir2
    ? { rs: 1, rp: 1 }
    : fresnelAmplitudes(n1, n2, c1, c2) // film → substrate

  // Round-trip phase through the film at this wavelength and angle.
  const delta = (4 * Math.PI * n1 * thicknessNm * c1) / lambdaNm
  const cosDelta = Math.cos(delta)

  const Rs = airy(top.rs, bot.rs, cosDelta)
  const Rp = airy(top.rp, bot.rp, cosDelta)
  return Math.min(1, Math.max(0, 0.5 * (Rs + Rp)))
}
