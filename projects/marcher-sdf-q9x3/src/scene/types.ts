// The scene data model. Everything the editor manipulates and everything the
// GLSL code generator reads lives here. Kept plain-JSON-serialisable so scenes
// round-trip cleanly through localStorage and the preset table.

export type Vec3 = [number, number, number]

export type PrimitiveKind =
  | 'sphere'
  | 'box'
  | 'roundBox'
  | 'torus'
  | 'capsule'
  | 'cylinder'
  | 'cone'
  | 'octahedron'
  | 'plane'
  | 'ellipsoid'
  | 'hexPrism'
  | 'pyramid'
  | 'link'
  | 'roundCone'

export type BooleanOp = 'union' | 'subtract' | 'intersect'

/** Domain warp applied to a node's local space before its distance is evaluated. */
export type DomainMod = 'none' | 'repeat' | 'mirror' | 'twist' | 'bend' | 'elongate' | 'polar'

/** Procedural surface pattern that modulates a material's albedo. */
export type TextureKind = 'none' | 'checker' | 'noise' | 'marble' | 'wood' | 'grid'

export interface Transform {
  position: Vec3
  /** Euler angles in degrees, applied XYZ. */
  rotation: Vec3
  /** Uniform scale — keeps the distance field metrically valid. */
  scale: number
}

export interface Material {
  /** Base colour, linear 0..1. */
  color: Vec3
  metallic: number
  roughness: number
  reflectivity: number
  emission: number
  /** Procedural pattern woven into the albedo. */
  texture: TextureKind
  /** Feature frequency of the texture (world units). */
  texScale: number
  /** How strongly the texture modulates the base colour, 0..1. */
  texStrength: number
}

/**
 * A per-node domain warp + post-distance shaping. Which `domain` is chosen (and
 * whether `shellOn`) changes the generated GLSL; every numeric value below is a
 * uniform, so dragging a slider never triggers a recompile.
 */
export interface Modifier {
  domain: DomainMod
  /** repeat: cell spacing per axis (0 on an axis = no tiling there). */
  repeat: Vec3
  /** repeat: 0 = infinite, N = mirror-limited to ±N cells. */
  repeatLimit: number
  /** mirror: per-axis 0/1 flags folding the domain about each plane. */
  mirror: Vec3
  /** twist: radians of rotation per unit of height. */
  twist: number
  /** bend: curvature applied along X. */
  bend: number
  /** elongate: per-axis stretch length (the shape is extruded by ±this along each axis). */
  elongate: Vec3
  /** polar: number of angular sectors folded around the Y axis (kaleidoscopic). */
  polar: number
  /** round: inflates the surface, rounding every edge (post-distance). */
  round: number
  /** shell/onion: hollow the shape into a shell of this thickness. */
  shellOn: boolean
  shell: number
}

/** Time-driven animation for a node's transform, evaluated on the render loop. */
export interface Anim {
  enabled: boolean
  /** Position sine amplitude per axis. */
  posAmp: Vec3
  /** Position sine speed per axis (Hz-ish). */
  posSpeed: Vec3
  /** Continuous spin in degrees/second per axis, added to the base rotation. */
  spin: Vec3
  /** Scale pulse amplitude (fraction) and speed. */
  scalePulse: number
  scaleSpeed: number
}

export interface Combine {
  op: BooleanOp
  smooth: boolean
  /** Blend radius for smooth ops. */
  radius: number
}

export interface SdfNode {
  id: string
  name: string
  visible: boolean
  kind: PrimitiveKind
  /** Up to four primitive-specific floats (packed into a vec4 uniform). */
  params: number[]
  transform: Transform
  material: Material
  /** How this node folds into the accumulated field before it. */
  combine: Combine
  /** Domain + distance shaping applied to this node only. */
  modifier: Modifier
  /** Optional time-driven motion. */
  anim: Anim
}

export interface Camera {
  target: Vec3
  distance: number
  /** Orbit angle around Y, degrees. */
  azimuth: number
  /** Orbit angle above the horizon, degrees. */
  elevation: number
  fov: number
  autoRotate: boolean
  autoRotateSpeed: number
  /** Thin-lens aperture radius. 0 = pinhole (no depth-of-field). */
  aperture: number
  /** World distance to the focal plane for depth-of-field. */
  focusDistance: number
}

export interface Sun {
  azimuth: number
  elevation: number
  color: Vec3
  intensity: number
  /** Angular radius (degrees) of the sun disc — widens the penumbra of soft shadows. */
  angle: number
}

export interface Environment {
  skyColor: Vec3
  horizonColor: Vec3
  groundColor: Vec3
  ambient: number
  fogDensity: number
  fogColor: Vec3
  /** Let emissive nodes cast light onto the rest of the scene (area lights). */
  emissive: boolean
  /** Global multiplier on the light gathered from emissive nodes. */
  emissiveStrength: number
  /** Trace a visibility ray to each emitter (costlier, crisper contact shadows). */
  emissiveShadows: boolean
}

export interface Ground {
  enabled: boolean
  height: number
  checker: boolean
  color1: Vec3
  color2: Vec3
}

export interface Quality {
  maxSteps: number
  maxDist: number
  surfaceEps: number
  shadowSoftness: number
  shadowStrength: number
  aoStrength: number
  reflections: boolean
  /** 2×2 supersampled anti-aliasing (HDR-correct, ~4× cost). */
  antialias: boolean
  /** Internal render buffer scale, 0.25..1. */
  resolutionScale: number
}

export interface Post {
  exposure: number
  gamma: number
  vignette: number
  saturation: number
}

/** Progressive accumulation settings — how the frame refines over time. */
export interface Render {
  /**
   * Average many jittered samples over successive frames into a float buffer,
   * converging to a clean image while the view holds still. Falls back to the
   * single-pass direct renderer when float render targets aren't available.
   */
  accumulate: boolean
  /** How many samples to accumulate before the image is considered converged. */
  maxSamples: number
}

export interface Scene {
  nodes: SdfNode[]
  camera: Camera
  sun: Sun
  env: Environment
  ground: Ground
  quality: Quality
  post: Post
  render: Render
  /** Master switch for per-node time animation. */
  animate: boolean
}

/** The primitive metadata that drives the inspector and codegen. */
export interface ParamSpec {
  key: string
  label: string
  min: number
  max: number
  step: number
  /** Index into SdfNode.params. */
  slot: number
}

export interface PrimitiveSpec {
  kind: PrimitiveKind
  label: string
  params: ParamSpec[]
  defaults: number[]
}
