// Scene description + a handful of presets. A scene is a list of objects (each a
// mesh kind, a transform, a material and a texture), a set of lights, and
// environment settings (ambient, background gradient, fog).
import type { MeshKind } from '../geometry/mesh.ts'
import type { Light, Material } from '../render/shading.ts'
import type { TextureKind } from '../render/texture.ts'
import type { Vec3 } from '../math/vec.ts'

export interface SceneObject {
  id: string
  meshKind: MeshKind
  position: Vec3
  scale: number
  spin: number // radians / second around Y
  tiltSpin: number // radians / second around X (adds a wobble)
  baseRotation: Vec3 // static euler offset
  material: Material
  texture: TextureKind
}

export interface SceneConfig {
  name: string
  objects: SceneObject[]
  ground: boolean
  groundTexture: TextureKind
  groundMaterial: Material
  lights: Light[]
  ambient: Vec3
  bgTop: Vec3
  bgBottom: Vec3
  fogColor: Vec3
  fogDensity: number
}

const mat = (albedo: Vec3, specular = 0.5, shininess = 48, rim = 0.0): Material => ({
  albedo, specular, shininess, rim,
})

const keyLights = (warm = true): Light[] => [
  { type: 'dir', direction: [-0.5, -0.85, -0.4], color: warm ? [1, 0.95, 0.85] : [0.9, 0.95, 1], intensity: 1.05 },
  { type: 'dir', direction: [0.7, -0.3, 0.6], color: [0.35, 0.45, 0.7], intensity: 0.5 },
  { type: 'point', position: [2.2, 2.4, 2.2], color: [1, 0.6, 0.3], intensity: 6, range: 9 },
]

const showcase = (): SceneConfig => ({
  name: 'Showcase',
  ground: true,
  groundTexture: 'checker',
  groundMaterial: mat([0.8, 0.8, 0.82], 0.15, 16),
  objects: [
    {
      id: 'knot', meshKind: 'knot', position: [0, 0.9, 0], scale: 1.15,
      spin: 0.5, tiltSpin: 0.12, baseRotation: [0, 0, 0],
      material: mat([0.95, 0.45, 0.2], 0.9, 90, 0.15), texture: 'none',
    },
    {
      id: 'sphere', meshKind: 'sphere', position: [-2.4, 0.8, 0.4], scale: 0.8,
      spin: 0.3, tiltSpin: 0, baseRotation: [0, 0, 0],
      material: mat([0.85, 0.85, 0.9], 0.8, 80), texture: 'grid',
    },
    {
      id: 'cube', meshKind: 'cube', position: [2.3, 0.75, -0.4], scale: 0.7,
      spin: -0.45, tiltSpin: 0.2, baseRotation: [0.3, 0.4, 0],
      material: mat([0.9, 0.8, 0.35], 0.6, 40), texture: 'bricks',
    },
    {
      id: 'torus', meshKind: 'torus', position: [0.2, 0.6, 2.4], scale: 0.85,
      spin: 0.7, tiltSpin: 0.3, baseRotation: [0.9, 0, 0],
      material: mat([0.3, 0.75, 0.95], 0.85, 100), texture: 'none',
    },
  ],
  lights: keyLights(true),
  ambient: [0.18, 0.2, 0.26],
  bgTop: [0.07, 0.09, 0.14],
  bgBottom: [0.16, 0.13, 0.18],
  fogColor: [0.12, 0.12, 0.17],
  fogDensity: 0.012,
})

const materials = (): SceneConfig => {
  const cols: Vec3[] = [
    [0.9, 0.2, 0.2], [0.95, 0.6, 0.15], [0.9, 0.85, 0.2],
    [0.25, 0.8, 0.35], [0.2, 0.6, 0.95], [0.6, 0.35, 0.9],
  ]
  return {
    name: 'Material Lineup',
    ground: true,
    groundTexture: 'grid',
    groundMaterial: mat([0.7, 0.72, 0.78], 0.2, 24),
    objects: cols.map((c, i) => ({
      id: `s${i}`,
      meshKind: 'sphere' as MeshKind,
      position: [(i - (cols.length - 1) / 2) * 1.5, 0.8, 0] as Vec3,
      scale: 0.62,
      spin: 0.25,
      tiltSpin: 0,
      baseRotation: [0, 0, 0] as Vec3,
      material: mat(c, 0.2 + (i / cols.length) * 0.8, 8 + i * 24, 0.05),
      texture: 'none' as TextureKind,
    })),
    lights: keyLights(false),
    ambient: [0.2, 0.22, 0.28],
    bgTop: [0.05, 0.07, 0.1],
    bgBottom: [0.12, 0.14, 0.2],
    fogColor: [0.1, 0.12, 0.16],
    fogDensity: 0.01,
  }
}

const primitives = (): SceneConfig => {
  const kinds: MeshKind[] = ['cube', 'sphere', 'cylinder', 'torus', 'knot']
  const tex: TextureKind[] = ['bricks', 'checker', 'grid', 'uv', 'none']
  return {
    name: 'Primitive Zoo',
    ground: true,
    groundTexture: 'checker',
    groundMaterial: mat([0.78, 0.79, 0.82], 0.18, 18),
    objects: kinds.map((k, i) => ({
      id: k,
      meshKind: k,
      position: [(i - (kinds.length - 1) / 2) * 1.7, 0.85, 0] as Vec3,
      scale: 0.78,
      spin: 0.4 + i * 0.05,
      tiltSpin: i % 2 ? 0.2 : 0,
      baseRotation: [0, 0, 0] as Vec3,
      material: mat([0.8, 0.82, 0.85], 0.7, 60),
      texture: tex[i],
    })),
    lights: keyLights(true),
    ambient: [0.2, 0.22, 0.27],
    bgTop: [0.06, 0.08, 0.12],
    bgBottom: [0.14, 0.13, 0.17],
    fogColor: [0.11, 0.12, 0.16],
    fogDensity: 0.011,
  }
}

const exhibit = (): SceneConfig => ({
  name: 'Math Exhibit',
  ground: true,
  groundTexture: 'grid',
  groundMaterial: mat([0.74, 0.76, 0.8], 0.2, 22),
  objects: [
    {
      id: 'klein', meshKind: 'klein', position: [-2.6, 1.0, 0], scale: 1.0,
      spin: 0.4, tiltSpin: 0.0, baseRotation: [0.2, 0, 0],
      material: mat([0.95, 0.5, 0.75], 0.8, 70, 0.12), texture: 'none',
    },
    {
      id: 'spring', meshKind: 'spring', position: [0, 0.95, 0], scale: 1.05,
      spin: 0.6, tiltSpin: 0.0, baseRotation: [0, 0, 0],
      material: mat([0.8, 0.85, 0.5], 0.9, 90), texture: 'none',
    },
    {
      id: 'mobius', meshKind: 'mobius', position: [2.6, 0.95, 0], scale: 1.1,
      spin: 0.5, tiltSpin: 0.18, baseRotation: [0.4, 0, 0],
      material: mat([0.45, 0.8, 0.95], 0.85, 80, 0.1), texture: 'none',
    },
  ],
  lights: keyLights(true),
  ambient: [0.19, 0.21, 0.27],
  bgTop: [0.06, 0.08, 0.13],
  bgBottom: [0.15, 0.12, 0.16],
  fogColor: [0.11, 0.12, 0.16],
  fogDensity: 0.011,
})

export const PRESETS: Record<string, () => SceneConfig> = {
  showcase,
  materials,
  primitives,
  exhibit,
}

export const PRESET_LABELS: { key: string; label: string }[] = [
  { key: 'showcase', label: 'Showcase' },
  { key: 'materials', label: 'Materials' },
  { key: 'primitives', label: 'Primitives' },
  { key: 'exhibit', label: 'Math Exhibit' },
]
