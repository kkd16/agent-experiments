// Scene description + a handful of presets. A scene is a list of objects (each a
// mesh kind, a transform, a material, a texture and a normal map), a set of
// lights, and environment settings (ambient, background gradient/sky, fog).
import type { MeshKind } from '../geometry/mesh.ts'
import type { Light, Material } from '../render/shading.ts'
import type { TextureKind, NormalMapKind } from '../render/texture.ts'
import type { SkyParams } from '../render/environment.ts'
import { DEFAULT_SKY } from '../render/environment.ts'
import type { Vec3 } from '../math/vec.ts'
import { normalize } from '../math/vec.ts'

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
  normalMap: NormalMapKind
}

export interface SceneConfig {
  name: string
  objects: SceneObject[]
  ground: boolean
  groundTexture: TextureKind
  groundNormalMap: NormalMapKind
  groundMaterial: Material
  lights: Light[]
  ambient: Vec3
  bgTop: Vec3
  bgBottom: Vec3
  fogColor: Vec3
  fogDensity: number
  sky: SkyParams
  view?: { target: Vec3; yaw: number; pitch: number; distance: number } // optional camera framing
}

// Material with both Blinn–Phong (specular/shininess) and PBR (metallic/
// roughness) parameters so either lighting model renders it sensibly.
const mat = (
  albedo: Vec3,
  specular = 0.5,
  shininess = 48,
  rim = 0.0,
  metallic = 0.0,
  roughness = 0.5,
): Material => ({ albedo, specular, shininess, rim, metallic, roughness })

const keyLights = (warm = true): Light[] => [
  { type: 'dir', direction: [-0.5, -0.85, -0.4], color: warm ? [1, 0.95, 0.85] : [0.9, 0.95, 1], intensity: 1.05 },
  { type: 'dir', direction: [0.7, -0.3, 0.6], color: [0.35, 0.45, 0.7], intensity: 0.5 },
  { type: 'point', position: [2.2, 2.4, 2.2], color: [1, 0.6, 0.3], intensity: 6, range: 9 },
]

const showcase = (): SceneConfig => ({
  name: 'Showcase',
  ground: true,
  groundTexture: 'checker',
  groundNormalMap: 'none',
  groundMaterial: mat([0.8, 0.8, 0.82], 0.15, 16, 0, 0.0, 0.7),
  objects: [
    {
      id: 'knot', meshKind: 'knot', position: [0, 0.9, 0], scale: 1.15,
      spin: 0.5, tiltSpin: 0.12, baseRotation: [0, 0, 0],
      material: mat([0.95, 0.55, 0.3], 0.9, 90, 0.1, 1.0, 0.28), texture: 'none', normalMap: 'none',
    },
    {
      id: 'sphere', meshKind: 'sphere', position: [-2.4, 0.8, 0.4], scale: 0.8,
      spin: 0.3, tiltSpin: 0, baseRotation: [0, 0, 0],
      material: mat([0.85, 0.85, 0.9], 0.8, 80, 0, 0.0, 0.35), texture: 'grid', normalMap: 'bumps',
    },
    {
      id: 'cube', meshKind: 'cube', position: [2.3, 0.75, -0.4], scale: 0.7,
      spin: -0.45, tiltSpin: 0.2, baseRotation: [0.3, 0.4, 0],
      material: mat([0.9, 0.8, 0.35], 0.6, 40, 0, 0.1, 0.5), texture: 'bricks', normalMap: 'brick',
    },
    {
      id: 'torus', meshKind: 'torus', position: [0.2, 0.6, 2.4], scale: 0.85,
      spin: 0.7, tiltSpin: 0.3, baseRotation: [0.9, 0, 0],
      material: mat([0.85, 0.9, 0.95], 0.85, 100, 0, 1.0, 0.18), texture: 'none', normalMap: 'none',
    },
  ],
  lights: keyLights(true),
  ambient: [0.18, 0.2, 0.26],
  bgTop: [0.07, 0.09, 0.14],
  bgBottom: [0.16, 0.13, 0.18],
  fogColor: [0.12, 0.12, 0.17],
  fogDensity: 0.012,
  sky: DEFAULT_SKY,
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
    groundNormalMap: 'none',
    groundMaterial: mat([0.7, 0.72, 0.78], 0.2, 24, 0, 0, 0.6),
    objects: cols.map((c, i) => ({
      id: `s${i}`,
      meshKind: 'sphere' as MeshKind,
      position: [(i - (cols.length - 1) / 2) * 1.5, 0.8, 0] as Vec3,
      scale: 0.62,
      spin: 0.25,
      tiltSpin: 0,
      baseRotation: [0, 0, 0] as Vec3,
      // a roughness sweep, half of them metallic
      material: mat(c, 0.2 + (i / cols.length) * 0.8, 8 + i * 24, 0.05,
        i % 2 === 0 ? 1 : 0, 0.08 + (i / (cols.length - 1)) * 0.7),
      texture: 'none' as TextureKind,
      normalMap: 'none' as NormalMapKind,
    })),
    lights: keyLights(false),
    ambient: [0.2, 0.22, 0.28],
    bgTop: [0.05, 0.07, 0.1],
    bgBottom: [0.12, 0.14, 0.2],
    fogColor: [0.1, 0.12, 0.16],
    fogDensity: 0.01,
    sky: DEFAULT_SKY,
  }
}

// A canonical metalness × roughness grid — the classic PBR validation chart that
// only reads correctly with image-based lighting switched on.
const pbrSweep = (): SceneConfig => {
  const COLS = 6
  const ROWS = 2
  const objects: SceneObject[] = []
  for (let r = 0; r < ROWS; r++) {
    const metallic = r === 0 ? 1 : 0
    for (let c = 0; c < COLS; c++) {
      const roughness = 0.06 + (c / (COLS - 1)) * 0.9
      objects.push({
        id: `m${r}_${c}`,
        meshKind: 'sphere',
        position: [(c - (COLS - 1) / 2) * 1.25, 1.7 - r * 1.25, 0],
        scale: 0.52,
        spin: 0,
        tiltSpin: 0,
        baseRotation: [0, 0, 0],
        material: mat(metallic ? [0.95, 0.78, 0.42] : [0.2, 0.45, 0.85], 0.6, 60, 0, metallic, roughness),
        texture: 'none',
        normalMap: 'none',
      })
    }
  }
  return {
    name: 'PBR Sweep',
    ground: true,
    groundTexture: 'none',
    groundNormalMap: 'none',
    groundMaterial: mat([0.32, 0.33, 0.36], 0.2, 24, 0, 0, 0.55),
    objects,
    lights: [
      { type: 'dir', direction: normalize([-0.4, -0.8, -0.45]) as Vec3, color: [1, 0.96, 0.9], intensity: 2.4 },
      { type: 'point', position: [3, 2.5, 3], color: [0.5, 0.7, 1], intensity: 8, range: 12 },
    ],
    ambient: [0.16, 0.18, 0.22],
    bgTop: [0.08, 0.1, 0.14],
    bgBottom: [0.14, 0.15, 0.19],
    fogColor: [0.1, 0.12, 0.16],
    fogDensity: 0.0,
    sky: DEFAULT_SKY,
  }
}

const primitives = (): SceneConfig => {
  const kinds: MeshKind[] = ['cube', 'sphere', 'cylinder', 'torus', 'knot']
  const tex: TextureKind[] = ['bricks', 'checker', 'grid', 'uv', 'none']
  const nrm: NormalMapKind[] = ['brick', 'none', 'none', 'scales', 'none']
  return {
    name: 'Primitive Zoo',
    ground: true,
    groundTexture: 'checker',
    groundNormalMap: 'none',
    groundMaterial: mat([0.78, 0.79, 0.82], 0.18, 18, 0, 0, 0.6),
    objects: kinds.map((k, i) => ({
      id: k,
      meshKind: k,
      position: [(i - (kinds.length - 1) / 2) * 1.7, 0.85, 0] as Vec3,
      scale: 0.78,
      spin: 0.4 + i * 0.05,
      tiltSpin: i % 2 ? 0.2 : 0,
      baseRotation: [0, 0, 0] as Vec3,
      material: mat([0.8, 0.82, 0.85], 0.7, 60, 0, 0, 0.45),
      texture: tex[i],
      normalMap: nrm[i],
    })),
    lights: keyLights(true),
    ambient: [0.2, 0.22, 0.27],
    bgTop: [0.06, 0.08, 0.12],
    bgBottom: [0.14, 0.13, 0.17],
    fogColor: [0.11, 0.12, 0.16],
    fogDensity: 0.011,
    sky: DEFAULT_SKY,
  }
}

const exhibit = (): SceneConfig => ({
  name: 'Math Exhibit',
  ground: true,
  groundTexture: 'grid',
  groundNormalMap: 'none',
  groundMaterial: mat([0.74, 0.76, 0.8], 0.2, 22, 0, 0, 0.6),
  objects: [
    {
      id: 'klein', meshKind: 'klein', position: [-2.6, 1.0, 0], scale: 1.0,
      spin: 0.4, tiltSpin: 0.0, baseRotation: [0.2, 0, 0],
      material: mat([0.95, 0.5, 0.75], 0.8, 70, 0.12, 0.2, 0.35), texture: 'none', normalMap: 'none',
    },
    {
      id: 'spring', meshKind: 'spring', position: [0, 0.95, 0], scale: 1.05,
      spin: 0.6, tiltSpin: 0.0, baseRotation: [0, 0, 0],
      material: mat([0.85, 0.88, 0.5], 0.9, 90, 0, 1.0, 0.3), texture: 'none', normalMap: 'none',
    },
    {
      id: 'mobius', meshKind: 'mobius', position: [2.6, 0.95, 0], scale: 1.1,
      spin: 0.5, tiltSpin: 0.18, baseRotation: [0.4, 0, 0],
      material: mat([0.45, 0.8, 0.95], 0.85, 80, 0.1, 0, 0.3), texture: 'none', normalMap: 'none',
    },
  ],
  lights: keyLights(true),
  ambient: [0.19, 0.21, 0.27],
  bgTop: [0.06, 0.08, 0.13],
  bgBottom: [0.15, 0.12, 0.16],
  fogColor: [0.11, 0.12, 0.16],
  fogDensity: 0.011,
  sky: DEFAULT_SKY,
})

// A single-object stage for an imported OBJ mesh. The mesh itself lives in the
// renderer's custom-mesh slot; this just frames it nicely.
export const customScene = (): SceneConfig => ({
  name: 'Custom Mesh',
  ground: true,
  groundTexture: 'grid',
  groundNormalMap: 'none',
  groundMaterial: mat([0.7, 0.72, 0.78], 0.2, 24, 0, 0, 0.6),
  objects: [
    {
      id: 'custom', meshKind: 'custom', position: [0, 1.0, 0], scale: 1.2,
      spin: 0.5, tiltSpin: 0.08, baseRotation: [0, 0, 0],
      material: mat([0.85, 0.86, 0.9], 0.85, 90, 0.05, 0.7, 0.3), texture: 'none', normalMap: 'none',
    },
  ],
  lights: keyLights(true),
  ambient: [0.19, 0.21, 0.27],
  bgTop: [0.06, 0.08, 0.13],
  bgBottom: [0.15, 0.13, 0.17],
  fogColor: [0.11, 0.12, 0.16],
  fogDensity: 0.008,
  sky: DEFAULT_SKY,
})

// A Cornell box — five diffuse walls (classic red/green/white albedos) lit only by
// an emissive ceiling panel. There are no punctual lights: every photon comes from
// the panel and bounces, so the white surfaces pick up red/green colour bleed and
// the objects cast soft contact shadows. The rasterizer (no area lights, no GI)
// renders it nearly flat; the path tracer renders it correctly. Best in RT mode.
const cornell = (): SceneConfig => {
  const S = 3.0
  const wWhite = mat([0.73, 0.73, 0.73], 0.0, 8, 0, 0, 0.9)
  const wRed = mat([0.63, 0.065, 0.05], 0.0, 8, 0, 0, 0.9)
  const wGreen = mat([0.14, 0.45, 0.091], 0.0, 8, 0, 0, 0.9)
  const lightMat: Material = { albedo: [0, 0, 0], specular: 0, shininess: 1, rim: 0, metallic: 0, roughness: 1, emission: [10, 9.2, 7.5] }
  const wall = (id: string, position: Vec3, baseRotation: Vec3, material: Material): SceneObject => ({
    id, meshKind: 'quad', position, scale: S, spin: 0, tiltSpin: 0, baseRotation, material, texture: 'none', normalMap: 'none',
  })
  return {
    name: 'Cornell Box',
    ground: false,
    groundTexture: 'none',
    groundNormalMap: 'none',
    groundMaterial: wWhite,
    objects: [
      wall('floor', [0, 0, 0], [0, 0, 0], wWhite),
      wall('ceiling', [0, S, 0], [0, 0, 0], wWhite),
      wall('back', [0, S / 2, -S / 2], [Math.PI / 2, 0, 0], wWhite),
      wall('left', [-S / 2, S / 2, 0], [0, 0, Math.PI / 2], wRed),
      wall('right', [S / 2, S / 2, 0], [0, 0, Math.PI / 2], wGreen),
      { id: 'light', meshKind: 'quad', position: [0, S - 0.02, 0], scale: S * 0.32, spin: 0, tiltSpin: 0, baseRotation: [0, 0, 0], material: lightMat, texture: 'none', normalMap: 'none' },
      { id: 'box', meshKind: 'cube', position: [-0.55, 0.5, -0.45], scale: 0.56, spin: 0, tiltSpin: 0, baseRotation: [0, 0.5, 0], material: mat([0.75, 0.75, 0.75], 0.1, 16, 0, 0, 0.8), texture: 'none', normalMap: 'none' },
      { id: 'ball', meshKind: 'sphere', position: [0.62, 0.5, 0.5], scale: 0.5, spin: 0, tiltSpin: 0, baseRotation: [0, 0, 0], material: mat([0.95, 0.9, 0.6], 0.9, 90, 0, 1, 0.08), texture: 'none', normalMap: 'none' },
    ],
    lights: [],
    ambient: [0, 0, 0],
    bgTop: [0.01, 0.01, 0.012],
    bgBottom: [0.01, 0.01, 0.012],
    fogColor: [0, 0, 0],
    fogDensity: 0,
    sky: { zenith: [0.02, 0.02, 0.03], horizon: [0.02, 0.02, 0.03], ground: [0.01, 0.01, 0.01], sunDir: normalize([0, 1, 0]) as Vec3, sunColor: [0, 0, 0], sunIntensity: 0, sunAngularSize: 0.02, intensity: 1 },
    view: { target: [0, 1.35, 0], yaw: 0, pitch: 0.05, distance: 5.0 },
  }
}

// A hall of mirrors: metal spheres of rising roughness on a near-mirror floor under
// the analytic sky. The spheres reflect each other and the floor reflects them all —
// genuine inter-reflection the rasterizer's single IBL probe can only fake. Best in
// RT mode (Path tracer, low roughness).
const reflections = (): SceneConfig => {
  const cols: Vec3[] = [
    [1.0, 0.78, 0.35], [0.95, 0.95, 0.97], [0.95, 0.6, 0.4], [0.6, 0.78, 0.98], [0.7, 0.95, 0.7],
  ]
  const objects: SceneObject[] = cols.map((c, i) => ({
    id: `m${i}`,
    meshKind: 'sphere' as MeshKind,
    position: [(i - (cols.length - 1) / 2) * 1.5, 0.7, 0] as Vec3,
    scale: 0.66,
    spin: 0,
    tiltSpin: 0,
    baseRotation: [0, 0, 0] as Vec3,
    material: mat(c, 0.9, 120, 0, 1, 0.02 + (i / (cols.length - 1)) * 0.3),
    texture: 'none' as TextureKind,
    normalMap: 'none' as NormalMapKind,
  }))
  // a smaller floating sphere to be caught in the reflections
  objects.push({
    id: 'orb', meshKind: 'sphere', position: [0, 1.7, -1.4], scale: 0.42, spin: 0, tiltSpin: 0,
    baseRotation: [0, 0, 0], material: mat([0.9, 0.3, 0.35], 0.8, 90, 0, 0, 0.18), texture: 'none', normalMap: 'none',
  })
  objects.push({
    id: 'mirror-floor', meshKind: 'quad', position: [0, 0, 0], scale: 16, spin: 0, tiltSpin: 0,
    baseRotation: [0, 0, 0], material: mat([0.55, 0.57, 0.6], 0.9, 120, 0, 0.9, 0.07), texture: 'none', normalMap: 'none',
  })
  return {
    name: 'Reflections',
    ground: false,
    groundTexture: 'none',
    groundNormalMap: 'none',
    groundMaterial: mat([0.3, 0.3, 0.32], 0.2, 24, 0, 0, 0.5),
    objects,
    lights: [
      { type: 'dir', direction: normalize([-0.4, -0.85, -0.35]) as Vec3, color: [1, 0.96, 0.9], intensity: 2.0 },
      { type: 'point', position: [2.5, 2.6, 2.5], color: [0.6, 0.75, 1], intensity: 7, range: 12 },
    ],
    ambient: [0.12, 0.14, 0.18],
    bgTop: [0.05, 0.07, 0.11],
    bgBottom: [0.12, 0.14, 0.2],
    fogColor: [0.1, 0.12, 0.16],
    fogDensity: 0,
    sky: DEFAULT_SKY,
    view: { target: [0, 0.55, 0], yaw: 0.5, pitch: 0.16, distance: 6.2 },
  }
}

export const PRESETS: Record<string, () => SceneConfig> = {
  showcase,
  materials,
  pbrSweep,
  primitives,
  exhibit,
  cornell,
  reflections,
  custom: customScene,
}

export const PRESET_LABELS: { key: string; label: string }[] = [
  { key: 'showcase', label: 'Showcase' },
  { key: 'materials', label: 'Materials' },
  { key: 'pbrSweep', label: 'PBR Sweep' },
  { key: 'primitives', label: 'Primitives' },
  { key: 'exhibit', label: 'Math Exhibit' },
  { key: 'cornell', label: 'Cornell Box' },
  { key: 'reflections', label: 'Reflections' },
  { key: 'custom', label: 'Custom OBJ' },
]
