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

export type BooleanOp = 'union' | 'subtract' | 'intersect'

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
}

export interface Sun {
  azimuth: number
  elevation: number
  color: Vec3
  intensity: number
}

export interface Environment {
  skyColor: Vec3
  horizonColor: Vec3
  groundColor: Vec3
  ambient: number
  fogDensity: number
  fogColor: Vec3
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
  /** Internal render buffer scale, 0.25..1. */
  resolutionScale: number
}

export interface Post {
  exposure: number
  gamma: number
  vignette: number
  saturation: number
}

export interface Scene {
  nodes: SdfNode[]
  camera: Camera
  sun: Sun
  env: Environment
  ground: Ground
  quality: Quality
  post: Post
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
