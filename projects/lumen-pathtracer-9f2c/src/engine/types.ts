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

// A bounded homogeneous participating medium: a sphere of fog / smoke / cloud.
// `sigmaT` is the scalar extinction coefficient (collisions per world unit);
// `albedo` is the per-channel single-scattering albedo σ_s/σ_t (1 = lossless
// scattering, 0 = pure absorption), which is also what tints the volume; `g` is
// the Henyey–Greenstein anisotropy. Media are assumed not to overlap in depth
// along any ray (each scene places at most one enclosing volume), which keeps
// the free-flight estimator a simple nearest-collision search.
export interface MediumDef {
  center: Vec3
  radius: number
  sigmaT: number
  albedo: Vec3
  g: number
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
  // estimate), which excels at caustics. All four converge to the same image.
  integrator?: 'pt' | 'bdpt' | 'pssmlt' | 'sppm'
}

// Tone-mapping operators applied on the UI thread to the accumulated HDR buffer.
export type ToneMapping = 'aces' | 'reinhard' | 'filmic' | 'linear'

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
