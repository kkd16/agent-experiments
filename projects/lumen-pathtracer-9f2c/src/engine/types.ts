// types.ts — plain, structured-clone-friendly types shared between the UI
// thread and the render workers. Nothing here holds class instances, functions,
// or typed arrays so a SceneDef can cross a postMessage boundary verbatim.

import type { Vec3 } from './vec3'
import type { Material } from './material'
import type { CameraDef } from './camera'

export type PrimDef =
  | { kind: 'sphere'; center: Vec3; radius: number; material: number }
  // A triangle. `n0..n2`, when present, are per-vertex shading normals that the
  // scene interpolates across the face (smooth shading); without them the flat
  // geometric normal is used.
  | { kind: 'tri'; p0: Vec3; p1: Vec3; p2: Vec3; material: number; n0?: Vec3; n1?: Vec3; n2?: Vec3 }

// The environment radiance seen by escaping rays — also the scene's ambient fill.
// An environment with a sun (`gradient` with a `sunDir`, or `sky`) is also a
// *sampled* light: the integrator next-event-estimates its solar disc (see scene.ts).
export type EnvDef =
  | { kind: 'solid'; color: Vec3 }
  // Vertical gradient blended by ray.dir.y, with an optional disc "sun".
  | { kind: 'gradient'; top: Vec3; bottom: Vec3; sunDir?: Vec3; sunColor?: Vec3; sunSize?: number }
  // Preetham analytic daylight: physically based sky colour from sun position +
  // turbidity, with a hard solar disc. See sky.ts.
  | {
      kind: 'sky'
      sunDir: Vec3
      turbidity: number
      intensity: number
      sunSize?: number
      sunIntensity?: number
      ground?: Vec3
    }

// A procedural 3D density field that modulates a medium's extinction in space,
// turning a uniformly-foggy sphere into a real cloud / smoke plume / fog layer.
// The field is evaluated to a *normalised* density in [0, 1]; the medium's
// `sigmaT` is the majorant extinction (the value at density 1), which is exactly
// what delta/ratio tracking needs as its constant collision rate. Absent ⇒ the
// medium is homogeneous (density ≡ 1) and the analytic Beer–Lambert path runs.
export type DensityDef =
  // Fractional-Brownian-motion noise: cumulus clouds and smoke. The raw fBm is
  // thresholded by `coverage` (higher ⇒ sparser) and remapped to [0, 1]; `edge`
  // is a soft spherical falloff width (fraction of radius) so the cloud fades to
  // nothing at the medium boundary; `verticalBias` thins the field with height
  // (>0, smoke dissipating upward) or with depth (<0); `warp` curls the billows.
  | {
      kind: 'fbm'
      frequency: number // base spatial frequency (cycles per world unit)
      octaves: number
      lacunarity: number
      gain: number
      coverage: number // density floor subtracted before renormalising, [0,1)
      edge: number // soft spherical edge falloff width, fraction of radius
      verticalBias?: number // density attenuation per world unit of height
      warp?: number // domain-warp displacement (world units)
      seed?: number
    }
  // An exponential vertical fog layer: density peaks at world-y `base` and decays
  // upward with e-folding height `scaleHeight`, optionally lumped by noise.
  | {
      kind: 'layer'
      base: number
      scaleHeight: number
      noiseAmount?: number // 0 = smooth slab, →1 = lumpy fog bank
      frequency?: number
      seed?: number
    }

// A bounded participating medium: a sphere of fog / smoke / cloud. `sigmaT` is
// the (majorant) scalar extinction coefficient (collisions per world unit);
// `albedo` is the per-channel single-scattering albedo σ_s/σ_t (1 = lossless
// scattering, 0 = pure absorption), which is also what tints the volume; `g` is
// the Henyey–Greenstein anisotropy; the optional `density` field makes the
// medium heterogeneous (a procedural cloud/smoke/fog) rather than uniform. Media
// are assumed not to overlap in depth along any ray (each scene places at most
// one enclosing volume), which keeps the free-flight estimator a simple
// nearest-collision search.
export interface MediumDef {
  center: Vec3
  radius: number
  sigmaT: number
  albedo: Vec3
  g: number
  // (16.0) Optional **chromatic extinction**: per-channel σ_t read as a 3-point
  // spectrum at the R/G/B representative wavelengths (see subsurface.ts/`spectralAt`).
  // When present the medium's extinction depends on wavelength — blue scattered out
  // sooner than red (a reddening dusty atmosphere), or a smoke that lets one colour
  // through — and the path commits a hero wavelength to delta/ratio-track at σ_t(λ).
  // Absent ⇒ the scalar (achromatic) medium, bit-for-bit. For a heterogeneous field
  // the normalised density shape is shared; only the extinction *scale* is chromatic.
  sigmaTSpectral?: Vec3
  density?: DensityDef
  // Optional volumetric emission (a glowing medium: fire, embers, a luminous
  // nebula). At a real collision the path picks up `(σ_a/σ_t)·emission =
  // (1−albedo)·emission` of self-emitted radiance, so the glow concentrates in
  // the dense, high-collision-rate core of a heterogeneous field.
  emission?: Vec3
}

export interface SceneDef {
  name: string
  materials: Material[]
  prims: PrimDef[]
  camera: CameraDef
  env: EnvDef
  // Optional volumetric media filling bounded spherical regions of the scene.
  media?: MediumDef[]
}

export interface IntegratorSettings {
  maxDepth: number // maximum path length (bounces)
  rrStart: number // bounce after which Russian roulette kicks in
  clampIndirect: number // firefly clamp on indirect radiance (0 = off)
  // Light-transport algorithm. 'pt' is the unidirectional path tracer (NEE+MIS);
  // 'bdpt' is the bidirectional path tracer (camera×light connections + MIS);
  // 'pssmlt' is primary-sample-space Metropolis light transport (a Markov chain
  // over the path tracer's random stream); 'sppm' is stochastic progressive
  // photon mapping (photons from the lights + a shrinking-radius density
  // estimate), which excels at caustics; 'guided' is the unidirectional path
  // tracer augmented with **practical path guiding** — an SD-tree that learns the
  // incident-radiance field online and importance-samples it (mixed with the BSDF
  // via MIS), cutting indirect-light noise. All converge to the same image.
  integrator?: 'pt' | 'bdpt' | 'pssmlt' | 'sppm' | 'guided'
  // (14.0) Importance-sample which light to next-event-estimate via the light BVH
  // (power/distance/orientation) instead of uniformly. Affects the unidirectional
  // path tracer's NEE (so 'pt', 'guided' and 'pssmlt', which reuse it); 'bdpt' and
  // 'sppm' do their own light sampling and are unaffected. Unbiased either way.
  manyLights?: boolean
}

// Tone-mapping operators applied on the UI thread to the accumulated HDR buffer.
export type ToneMapping = 'agx' | 'aces' | 'reinhard' | 'filmic' | 'linear'

// ---- Worker message protocol -------------------------------------------------

export interface InitMsg {
  type: 'init'
  scene: SceneDef
  width: number
  height: number
  bandStart: number // first image row this worker owns (inclusive)
  bandEnd: number // last image row this worker owns (exclusive)
  settings: IntegratorSettings
  seed: number
}

export interface PassMsg {
  type: 'pass'
  sampleIndex: number // 0-based index of the sample this pass adds
  captureGBuffer: boolean
}

export type ToWorker = InitMsg | PassMsg | { type: 'reset' }

export interface ReadyMsg {
  type: 'ready'
  buildMs: number
  triCount: number
  bvhNodes: number
  bvhDepth: number
}

export interface PassDoneMsg {
  type: 'passDone'
  sampleIndex: number
  bandStart: number
  bandEnd: number
  rays: number // primary+secondary rays traced this pass (for stats)
  // Interleaved [r,g,b] radiance for this single pass over the band.
  radiance: ArrayBuffer
  // Optional G-buffer for denoising (albedo, normal) — captured on early passes.
  albedo?: ArrayBuffer
  normal?: ArrayBuffer
}

// Full-frame estimator progress (PSSMLT *and* SPPM): a worker running its own
// independent chains / photon passes posts, each pass, its current full-frame
// HDR estimate plus how far it has run. The UI thread averages the workers'
// estimates weighted by progress (each is independently consistent).
export interface MltDoneMsg {
  type: 'mltDone'
  image: ArrayBuffer // full-frame interleaved [r,g,b] normalised radiance (W×H)
  mpp: number // progress: mutations-per-pixel (PSSMLT) or passes (SPPM)
  rays: number // rays traced since the previous pass (for the stats readout)
  b: number // this worker's bootstrap brightness estimate (for diagnostics)
}

export type FromWorker = ReadyMsg | PassDoneMsg | MltDoneMsg
