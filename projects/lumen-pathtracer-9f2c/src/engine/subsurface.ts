// subsurface.ts — chromatic subsurface scattering (Lumen 15.0).
//
// Lumen 12.0 gave a dielectric a *scattering interior*: light refracts in,
// random-walks among microscopic scatterers, and glows back out (marble, jade,
// wax, skin). But that first model had a **scalar mean free path** — one σ_t for
// every colour — so all the chromatic character had to come from the per-collision
// single-scattering albedo. Real translucent media don't work that way: in skin,
// *red light travels far* (low extinction) while blue barely penetrates (high
// extinction), so a back-lit ear or a hand over a torch glows deep red not because
// red is absorbed less per bounce but because red simply reaches further before it
// is absorbed at all. That is a **chromatic mean free path**, and it is the single
// biggest reason skin/marble/milk look the way they do.
//
// 15.0 adds it by reusing the path tracer's existing **hero-wavelength** machinery
// (the same trick that disperses glass and colours real metals). A path that
// refracts into a spectral interior commits to one wavelength λ, picks up that
// wavelength's RGB weight once (E_λ[weight] = (1,1,1), so the estimator stays
// unbiased — colour is only a *spread* across λ), and then random-walks
// *monochromatically* with the extinction σ_t(λ) and single-scattering albedo
// ϖ(λ) resolved at that wavelength. Average over many paths' wavelengths and the
// chromatic translucency reconstructs exactly, energy-conserving by construction.
//
// Two pieces live here: `spectralAt`, the RGB→wavelength upsampling that turns an
// RGB extinction/albedo triple into a value at λ; and a library of **measured
// BSSRDF media** (Jensen, Marschner, Levoy & Hanrahan, "A Practical Model for
// Subsurface Light Transport", SIGGRAPH 2001, Table 2) so a scene can ask for real
// marble / skin / whole milk / ketchup and get its physically measured chromatic
// extinction, not a hand-tuned guess.

import type { Vec3 } from './vec3'
import { v } from './vec3'
import type { Subsurface } from './material'

// The representative wavelengths (nm) the three RGB channels stand in for. An RGB
// triple is read as a 3-point spectrum sampled at these wavelengths; `spectralAt`
// interpolates between them. They sit near the sRGB primaries' dominant
// wavelengths, spanning the visible band so the proofs' reconstruction is faithful.
export const LAMBDA_R = 650
export const LAMBDA_G = 550
export const LAMBDA_B = 450

// Evaluate an RGB-as-spectrum triple at wavelength λ (nm). Blue holds below 450 nm,
// red holds above 650 nm, and the value is piecewise-linear in between. By
// construction it (a) reproduces each channel exactly at its representative
// wavelength — spectralAt(c,450)=c.z, (…,550)=c.y, (…,650)=c.x; (b) stays within
// [min,max] of the three channels (so positivity and boundedness are inherited
// from the input); and (c) is *constant* for an achromatic (equal-channel) triple,
// which is what makes a chromatic medium with equal σ_t per channel collapse
// exactly onto the scalar 12.0 walk.
export function spectralAt(rgb: Vec3, lambdaNm: number): number {
  if (lambdaNm <= LAMBDA_B) return rgb.z
  if (lambdaNm >= LAMBDA_R) return rgb.x
  if (lambdaNm <= LAMBDA_G) {
    const t = (lambdaNm - LAMBDA_B) / (LAMBDA_G - LAMBDA_B)
    return rgb.z + (rgb.y - rgb.z) * t
  }
  const t = (lambdaNm - LAMBDA_G) / (LAMBDA_R - LAMBDA_G)
  return rgb.y + (rgb.x - rgb.y) * t
}

// Measured reduced scattering σ_s′ and absorption σ_a coefficients (per mm) for a
// real medium, one value per RGB channel. From Jensen et al. 2001, Table 2. σ_s′ is
// the *reduced* scattering coefficient σ_s(1−g) — the similarity-theory quantity
// the diffusion model is fit to — so converting it back to a true σ_s needs the
// chosen anisotropy g (see `subsurfacePreset`).
export interface BssrdfMeasurement {
  sigmaSPrime: Vec3 // reduced scattering σ_s′ (per mm), RGB
  sigmaA: Vec3 // absorption σ_a (per mm), RGB
}

export type MediumName =
  | 'marble'
  | 'skin1'
  | 'skin2'
  | 'skimmilk'
  | 'wholemilk'
  | 'cream'
  | 'ketchup'
  | 'chicken'
  | 'potato'
  | 'apple'

// Jensen et al. 2001, Table 2 — the canonical measured BSSRDF coefficients. Units
// are per millimetre; a scene scales them into its own units (see subsurfacePreset).
// Note the chromatic extinction σ_t = σ_s′+σ_a: for skin/marble red has the *lowest*
// σ_t (longest mean free path), which is exactly why they glow red when back-lit.
export const BSSRDF_MEASUREMENTS: Record<MediumName, BssrdfMeasurement> = {
  marble: { sigmaSPrime: v(2.19, 2.62, 3.0), sigmaA: v(0.0021, 0.0041, 0.0071) },
  skin1: { sigmaSPrime: v(0.74, 0.88, 1.01), sigmaA: v(0.032, 0.17, 0.48) },
  skin2: { sigmaSPrime: v(1.09, 1.59, 1.79), sigmaA: v(0.013, 0.07, 0.145) },
  skimmilk: { sigmaSPrime: v(0.7, 1.22, 1.9), sigmaA: v(0.0014, 0.0025, 0.0142) },
  wholemilk: { sigmaSPrime: v(2.55, 3.21, 3.77), sigmaA: v(0.0011, 0.0024, 0.014) },
  cream: { sigmaSPrime: v(7.38, 5.47, 3.15), sigmaA: v(0.0002, 0.0028, 0.0163) },
  ketchup: { sigmaSPrime: v(0.18, 0.07, 0.03), sigmaA: v(0.061, 0.97, 1.45) },
  chicken: { sigmaSPrime: v(0.15, 0.21, 0.38), sigmaA: v(0.015, 0.077, 0.19) },
  potato: { sigmaSPrime: v(0.68, 0.7, 0.55), sigmaA: v(0.0024, 0.009, 0.12) },
  apple: { sigmaSPrime: v(2.29, 2.39, 1.97), sigmaA: v(0.003, 0.0034, 0.046) },
}

// Build a spectral `Subsurface` from a measured medium. `scale` maps the paper's
// per-mm coefficients into scene units: objects here are ~unit-sized, so the raw
// per-mm values would be almost transparent — a `scale` of a few makes the medium
// read as the dense translucent solid the measurement describes (smaller ⇒ deeper,
// glassier glow; larger ⇒ more opaque/chalky). `g` is the Henyey–Greenstein
// anisotropy used for the *true* walk: since the table stores the *reduced* σ_s′,
// we recover σ_s = σ_s′/(1−g) so the extinction is physically consistent with the
// phase function the integrator actually samples (g=0 leaves σ_s = σ_s′).
//
// The returned medium carries BOTH a spectral description (`sigmaTSpectral`,
// `albedoSpectral`, driving the chromatic hero-wavelength walk) AND scalar
// `sigmaT`/`albedo` fallbacks (the channel mean / per-channel albedo) for the
// achromatic BDPT path and the denoiser guide.
export function subsurfacePreset(name: MediumName, scale: number, g = 0): Subsurface {
  const m = BSSRDF_MEASUREMENTS[name]
  const unreduce = 1 / (1 - g)
  const ext = (sp: number, sa: number) => (sp * unreduce + sa) * scale
  const alb = (sp: number, sa: number) => {
    const ss = sp * unreduce
    const t = ss + sa
    return t > 0 ? ss / t : 0
  }
  const sigmaTSpectral = v(
    ext(m.sigmaSPrime.x, m.sigmaA.x),
    ext(m.sigmaSPrime.y, m.sigmaA.y),
    ext(m.sigmaSPrime.z, m.sigmaA.z),
  )
  const albedoSpectral = v(
    alb(m.sigmaSPrime.x, m.sigmaA.x),
    alb(m.sigmaSPrime.y, m.sigmaA.y),
    alb(m.sigmaSPrime.z, m.sigmaA.z),
  )
  const sigmaTMean = (sigmaTSpectral.x + sigmaTSpectral.y + sigmaTSpectral.z) / 3
  return { sigmaT: sigmaTMean, albedo: albedoSpectral, g, sigmaTSpectral, albedoSpectral }
}
