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

// A stage for a marching-cubes implicit mesh. Like the OBJ scene it shows a single
// object in the renderer's custom-mesh slot — the SDF panel keeps that slot fed — but
// frames it on a darker plinth with a clean dielectric so the meshed surface reads.
export const implicitScene = (): SceneConfig => ({
  name: 'Implicit (SDF)',
  ground: true,
  groundTexture: 'grid',
  groundNormalMap: 'none',
  groundMaterial: mat([0.32, 0.33, 0.37], 0.4, 40, 0, 0.0, 0.45),
  objects: [
    {
      id: 'custom', meshKind: 'custom', position: [0, 1.05, 0], scale: 1.15,
      spin: 0.45, tiltSpin: 0.0, baseRotation: [0, 0, 0],
      material: mat([0.86, 0.84, 0.9], 0.85, 95, 0.06, 0.1, 0.32), texture: 'none', normalMap: 'none',
    },
  ],
  lights: [
    { type: 'dir', direction: normalize([-0.45, -0.82, -0.4]) as Vec3, color: [1, 0.96, 0.9], intensity: 1.7 },
    { type: 'dir', direction: normalize([0.7, -0.3, 0.5]) as Vec3, color: [0.45, 0.55, 0.8], intensity: 0.45 },
    { type: 'point', position: [2.2, 2.6, 2.4], color: [1, 0.66, 0.4], intensity: 6, range: 10 },
  ],
  ambient: [0.18, 0.2, 0.26],
  bgTop: [0.05, 0.07, 0.12],
  bgBottom: [0.13, 0.12, 0.16],
  fogColor: [0.1, 0.11, 0.15],
  fogDensity: 0.006,
  sky: DEFAULT_SKY,
  view: { target: [0, 1.0, 0], yaw: 0.5, pitch: 0.12, distance: 5.4 },
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

// An enclosed alcove built to flaunt the v4 screen-space passes: a glossy floor that
// reflects the props (SSR), deep corners and props in mutual contact (SSAO + contact
// shadows), and tall pillars that occlude each other. Reads markedly richer with the
// "Screen-space FX" section on, and can be A/B'd against the path tracer in the split.
const interior = (): SceneConfig => {
  const floor = mat([0.21, 0.22, 0.25], 0.9, 130, 0, 0.1, 0.08) // near-mirror dielectric
  const wall = mat([0.56, 0.53, 0.5], 0.1, 12, 0, 0, 0.88)
  const pillar = mat([0.8, 0.78, 0.73], 0.3, 36, 0, 0, 0.42)
  const objects: SceneObject[] = [
    { id: 'floor', meshKind: 'quad', position: [0, 0, 0], scale: 15, spin: 0, tiltSpin: 0, baseRotation: [0, 0, 0], material: floor, texture: 'none', normalMap: 'none' },
    { id: 'back', meshKind: 'quad', position: [0, 3, -3.6], scale: 8, spin: 0, tiltSpin: 0, baseRotation: [Math.PI / 2, 0, 0], material: wall, texture: 'none', normalMap: 'none' },
    { id: 'left', meshKind: 'quad', position: [-4, 3, 0], scale: 8, spin: 0, tiltSpin: 0, baseRotation: [0, 0, Math.PI / 2], material: wall, texture: 'none', normalMap: 'none' },
    { id: 'right', meshKind: 'quad', position: [4, 3, 0], scale: 8, spin: 0, tiltSpin: 0, baseRotation: [0, 0, Math.PI / 2], material: wall, texture: 'none', normalMap: 'none' },
    // pillars along the back
    { id: 'p0', meshKind: 'cylinder', position: [-3, 1.5, -2.9], scale: 1.5, spin: 0, tiltSpin: 0, baseRotation: [0, 0, 0], material: pillar, texture: 'none', normalMap: 'none' },
    { id: 'p1', meshKind: 'cylinder', position: [-1.2, 1.5, -3.1], scale: 1.5, spin: 0, tiltSpin: 0, baseRotation: [0, 0, 0], material: pillar, texture: 'none', normalMap: 'none' },
    { id: 'p2', meshKind: 'cylinder', position: [1.2, 1.5, -3.1], scale: 1.5, spin: 0, tiltSpin: 0, baseRotation: [0, 0, 0], material: pillar, texture: 'none', normalMap: 'none' },
    { id: 'p3', meshKind: 'cylinder', position: [3, 1.5, -2.9], scale: 1.5, spin: 0, tiltSpin: 0, baseRotation: [0, 0, 0], material: pillar, texture: 'none', normalMap: 'none' },
    // clustered props in mutual contact on the reflective floor
    { id: 'knot', meshKind: 'knot', position: [0, 0.72, 0.5], scale: 0.62, spin: 0.4, tiltSpin: 0.1, baseRotation: [0, 0, 0], material: mat([1.0, 0.76, 0.34], 0.95, 120, 0.05, 1, 0.18), texture: 'none', normalMap: 'none' },
    { id: 'chrome', meshKind: 'sphere', position: [-1.25, 0.55, 1.15], scale: 0.55, spin: 0.2, tiltSpin: 0, baseRotation: [0, 0, 0], material: mat([0.95, 0.96, 0.98], 0.95, 140, 0, 1, 0.05), texture: 'none', normalMap: 'none' },
    { id: 'glass', meshKind: 'sphere', position: [1.15, 0.5, 1.05], scale: 0.5, spin: 0, tiltSpin: 0, baseRotation: [0, 0, 0], material: { albedo: [0.85, 0.92, 1], specular: 0.9, shininess: 120, rim: 0, metallic: 0, roughness: 0.04, transmission: 1, ior: 1.5, attenuation: [0.15, 0.05, 0.02], dispersion: 0 }, texture: 'none', normalMap: 'none' },
    { id: 'cube', meshKind: 'cube', position: [0.3, 0.42, 1.7], scale: 0.42, spin: 0, tiltSpin: 0, baseRotation: [0.2, 0.5, 0], material: mat([0.85, 0.25, 0.22], 0.3, 24, 0, 0, 0.55), texture: 'bricks', normalMap: 'brick' },
    { id: 'torus', meshKind: 'torus', position: [-1.7, 0.34, 0.0], scale: 0.5, spin: 0.5, tiltSpin: 0.2, baseRotation: [1.0, 0, 0], material: mat([0.5, 0.85, 0.6], 0.7, 70, 0, 0.2, 0.3), texture: 'none', normalMap: 'none' },
  ]
  return {
    name: 'Interior',
    ground: false,
    groundTexture: 'none',
    groundNormalMap: 'none',
    groundMaterial: floor,
    objects,
    lights: [
      { type: 'dir', direction: normalize([-0.45, -0.82, -0.38]) as Vec3, color: [1, 0.94, 0.82], intensity: 1.7 },
      { type: 'dir', direction: normalize([0.6, -0.3, 0.5]) as Vec3, color: [0.55, 0.65, 0.85], intensity: 0.35 },
      { type: 'point', position: [1.6, 2.3, 2.1], color: [1, 0.66, 0.36], intensity: 6, range: 9 },
    ],
    ambient: [0.15, 0.17, 0.21],
    bgTop: [0.04, 0.05, 0.08],
    bgBottom: [0.1, 0.1, 0.13],
    fogColor: [0.08, 0.09, 0.12],
    fogDensity: 0,
    sky: DEFAULT_SKY,
    view: { target: [0, 1.0, 0], yaw: 0.32, pitch: 0.2, distance: 7.6 },
  }
}

// A colonnade lit by a low, bright sun — built for the volumetric medium. The pillars
// occlude the key light, so wherever the medium fills the shadow behind one the beam
// is carved out, and the lit gaps between them glow with forward-scattered light: real
// crepuscular "god rays", produced by next-event estimation through the medium rather
// than any screen-space trick. Best in RT mode with the Atmosphere medium on (the
// scene turns both on for you).
const cathedral = (): SceneConfig => {
  const stone = mat([0.66, 0.63, 0.58], 0.2, 28, 0, 0, 0.62)
  const floor = mat([0.34, 0.33, 0.33], 0.2, 26, 0, 0, 0.7)
  const objects: SceneObject[] = []
  const N = 5
  for (let i = 0; i < N; i++) {
    // thin, well-spaced columns so the key light streams through the gaps between them
    objects.push({
      id: `col${i}`, meshKind: 'cylinder', position: [(i - (N - 1) / 2) * 2.15, 1.5, -0.6] as Vec3,
      scale: 1.35, spin: 0, tiltSpin: 0, baseRotation: [0, 0, 0], material: stone, texture: 'none', normalMap: 'none',
    })
  }
  // a couple of floating occluders to break the beams up overhead
  objects.push({ id: 'orbA', meshKind: 'sphere', position: [0.1, 2.7, 0.6], scale: 0.5, spin: 0.2, tiltSpin: 0, baseRotation: [0, 0, 0], material: mat([0.7, 0.68, 0.64], 0.3, 40, 0, 0, 0.5), texture: 'none', normalMap: 'none' })
  objects.push({ id: 'orbB', meshKind: 'torus', position: [2.3, 2.4, 0.2], scale: 0.65, spin: 0.4, tiltSpin: 0.2, baseRotation: [0.8, 0, 0], material: mat([0.72, 0.7, 0.66], 0.4, 50, 0, 0.2, 0.4), texture: 'none', normalMap: 'none' })
  return {
    name: 'Cathedral',
    ground: true,
    groundTexture: 'checker',
    groundNormalMap: 'none',
    groundMaterial: floor,
    objects,
    lights: [
      { type: 'dir', direction: normalize([0.62, -0.5, 0.6]) as Vec3, color: [1, 0.9, 0.72], intensity: 2.7 },
      { type: 'dir', direction: normalize([-0.4, -0.4, -0.5]) as Vec3, color: [0.4, 0.5, 0.72], intensity: 0.35 },
    ],
    ambient: [0.05, 0.06, 0.09],
    bgTop: [0.03, 0.05, 0.09],
    bgBottom: [0.1, 0.09, 0.1],
    fogColor: [0.1, 0.1, 0.13],
    fogDensity: 0,
    sky: { ...DEFAULT_SKY, sunDir: normalize([-0.62, 0.5, -0.6]) as Vec3, sunColor: [1, 0.88, 0.66], sunIntensity: 3.4, sunAngularSize: 0.035, zenith: [0.05, 0.07, 0.13], horizon: [0.18, 0.15, 0.14], ground: [0.05, 0.05, 0.06] },
    view: { target: [0, 1.3, 0], yaw: 0.18, pitch: 0.06, distance: 8.4 },
  }
}

// A glowing interstellar cloud: a heterogeneous scattering medium lit from within by a
// bright coloured core. There are no surfaces to speak of — the image is almost all
// volume, so it only renders under the participating-media pass. A scatter of small
// bodies sets the cloud's extent; the medium box fits to them. Turns the medium on for
// you (preset "Nebula").
const nebula = (): SceneConfig => {
  const rock = mat([0.16, 0.16, 0.2], 0.2, 20, 0, 0, 0.7)
  const coreMat: Material = { albedo: [0, 0, 0], specular: 0, shininess: 1, rim: 0, metallic: 0, roughness: 1, emission: [5, 3.6, 7] }
  const objects: SceneObject[] = [
    { id: 'core', meshKind: 'sphere', position: [0, 0.3, 0], scale: 0.34, spin: 0, tiltSpin: 0, baseRotation: [0, 0, 0], material: coreMat, texture: 'none', normalMap: 'none' },
    { id: 'p1', meshKind: 'sphere', position: [-3.1, 1.4, -1.6], scale: 0.32, spin: 0.3, tiltSpin: 0, baseRotation: [0, 0, 0], material: rock, texture: 'none', normalMap: 'none' },
    { id: 'p2', meshKind: 'sphere', position: [3.0, -1.0, 1.6], scale: 0.3, spin: 0.2, tiltSpin: 0, baseRotation: [0, 0, 0], material: rock, texture: 'none', normalMap: 'none' },
    { id: 'p3', meshKind: 'sphere', position: [1.6, 2.4, -2.2], scale: 0.24, spin: 0.4, tiltSpin: 0, baseRotation: [0, 0, 0], material: rock, texture: 'none', normalMap: 'none' },
    { id: 'p4', meshKind: 'sphere', position: [-1.9, -1.8, 2.2], scale: 0.26, spin: 0.3, tiltSpin: 0, baseRotation: [0, 0, 0], material: rock, texture: 'none', normalMap: 'none' },
  ]
  return {
    name: 'Nebula',
    ground: false,
    groundTexture: 'none',
    groundNormalMap: 'none',
    groundMaterial: rock,
    objects,
    lights: [
      { type: 'point', position: [0, 0.3, 0], color: [0.78, 0.55, 1.0], intensity: 26, range: 14 },
      { type: 'point', position: [-2.4, 1.0, -1.0], color: [0.35, 0.7, 1.0], intensity: 9, range: 10 },
    ],
    ambient: [0, 0, 0],
    bgTop: [0.012, 0.01, 0.03],
    bgBottom: [0.02, 0.012, 0.035],
    fogColor: [0, 0, 0],
    fogDensity: 0,
    sky: { ...DEFAULT_SKY, sunDir: normalize([0, 1, 0]) as Vec3, sunColor: [0, 0, 0], sunIntensity: 0, zenith: [0.015, 0.012, 0.035], horizon: [0.02, 0.012, 0.035], ground: [0.01, 0.008, 0.025], intensity: 1 },
    view: { target: [0, 0.2, 0], yaw: 0.45, pitch: 0.12, distance: 8.6 },
  }
}

// A glass cabinet — the v8 dielectric showcase. A row of transmissive bodies over a
// checker floor with a few opaque colour props behind them, so the refraction reads:
// a clear smooth glass sphere, a frosted (rough-dielectric) sphere, two coloured
// absorbing spheres (Beer–Lambert tint by path length), and a solid glass cube. There
// are no tricks — every bend is the path tracer solving Snell + Fresnel at each facet,
// so the spheres act as lenses (the checker behind them flips) and pool light beneath.
// Reads correctly only under the path tracer (it auto-switches).
const glass = (): SceneConfig => {
  const glassMat = (albedo: Vec3, roughness: number, ior: number, attenuation: Vec3, dispersion = 0): Material =>
    ({ albedo, specular: 0.9, shininess: 120, rim: 0, metallic: 0, roughness, transmission: 1, ior, attenuation, dispersion })
  const objects: SceneObject[] = [
    { id: 'clear', meshKind: 'sphere', position: [-2.5, 0.75, 0], scale: 0.72, spin: 0, tiltSpin: 0, baseRotation: [0, 0, 0], material: glassMat([1, 1, 1], 0.0, 1.5, [0, 0, 0]), texture: 'none', normalMap: 'none' },
    { id: 'frost', meshKind: 'sphere', position: [-0.85, 0.75, 0], scale: 0.72, spin: 0, tiltSpin: 0, baseRotation: [0, 0, 0], material: glassMat([1, 1, 1], 0.18, 1.5, [0, 0, 0]), texture: 'none', normalMap: 'none' },
    { id: 'amber', meshKind: 'sphere', position: [0.85, 0.75, 0], scale: 0.72, spin: 0, tiltSpin: 0, baseRotation: [0, 0, 0], material: glassMat([1, 1, 1], 0.0, 1.5, [0.35, 1.1, 2.4]), texture: 'none', normalMap: 'none' },
    { id: 'cube', meshKind: 'cube', position: [2.55, 0.7, 0], scale: 0.6, spin: 0.15, tiltSpin: 0, baseRotation: [0.2, 0.5, 0], material: glassMat([1, 1, 1], 0.0, 1.5, [1.9, 0.6, 0.25]), texture: 'none', normalMap: 'none' },
    // opaque colour props set behind the glass so the refraction has something to bend
    { id: 'b0', meshKind: 'sphere', position: [-1.7, 0.45, -2.2], scale: 0.4, spin: 0, tiltSpin: 0, baseRotation: [0, 0, 0], material: mat([0.9, 0.3, 0.32], 0.4, 40, 0, 0, 0.4), texture: 'none', normalMap: 'none' },
    { id: 'b1', meshKind: 'sphere', position: [0, 0.45, -2.4], scale: 0.4, spin: 0, tiltSpin: 0, baseRotation: [0, 0, 0], material: mat([0.3, 0.85, 0.45], 0.4, 40, 0, 0, 0.4), texture: 'none', normalMap: 'none' },
    { id: 'b2', meshKind: 'sphere', position: [1.7, 0.45, -2.2], scale: 0.4, spin: 0, tiltSpin: 0, baseRotation: [0, 0, 0], material: mat([0.35, 0.55, 0.95], 0.4, 40, 0, 0, 0.4), texture: 'none', normalMap: 'none' },
  ]
  return {
    name: 'Glass',
    ground: true,
    groundTexture: 'checker',
    groundNormalMap: 'none',
    groundMaterial: mat([0.82, 0.83, 0.86], 0.2, 24, 0, 0, 0.5),
    objects,
    lights: [
      { type: 'dir', direction: normalize([-0.45, -0.85, -0.35]) as Vec3, color: [1, 0.97, 0.92], intensity: 2.0 },
      { type: 'point', position: [2.6, 2.8, 2.6], color: [0.6, 0.75, 1], intensity: 7, range: 12 },
    ],
    ambient: [0.14, 0.16, 0.2],
    bgTop: [0.07, 0.09, 0.14],
    bgBottom: [0.16, 0.16, 0.2],
    fogColor: [0.1, 0.12, 0.16],
    fogDensity: 0,
    sky: DEFAULT_SKY,
    view: { target: [0, 0.7, 0], yaw: 0.32, pitch: 0.14, distance: 7.2 },
  }
}

// A dispersion prism — a triangular glass prism against a dark backdrop lit by a single
// bright sun. Each wavelength has a slightly different IOR (Cauchy), so the prism bends
// red least and blue most and the refracted image of the sun fans into a spectrum. The
// path tracer renders one hero RGB channel per ray with that channel's IOR, recombining
// to the rainbow over many samples. Dispersion is on; let it converge.
const prism = (): SceneConfig => {
  const prismMat: Material = { albedo: [1, 1, 1], specular: 0.9, shininess: 130, rim: 0, metallic: 0, roughness: 0, transmission: 1, ior: 1.52, attenuation: [0, 0, 0], dispersion: 1.4 }
  const objects: SceneObject[] = [
    { id: 'prism', meshKind: 'prism', position: [0, 1.0, 0], scale: 1.5, spin: 0, tiltSpin: 0, baseRotation: [0, 0.0, 0], material: prismMat, texture: 'none', normalMap: 'none' },
    // a bright emissive bar behind the prism acts as the light source the prism disperses
    { id: 'lamp', meshKind: 'cube', position: [-3.2, 1.4, -1.0], scale: 0.12, spin: 0, tiltSpin: 0, baseRotation: [0, 0, 0], material: { albedo: [0, 0, 0], specular: 0, shininess: 1, rim: 0, metallic: 0, roughness: 1, emission: [22, 22, 22] }, texture: 'none', normalMap: 'none' },
  ]
  return {
    name: 'Prism',
    ground: true,
    groundTexture: 'none',
    groundNormalMap: 'none',
    groundMaterial: mat([0.16, 0.17, 0.2], 0.2, 24, 0, 0, 0.6),
    objects,
    lights: [
      { type: 'dir', direction: normalize([0.7, -0.35, -0.2]) as Vec3, color: [1, 1, 1], intensity: 1.4 },
    ],
    ambient: [0.02, 0.02, 0.03],
    bgTop: [0.015, 0.018, 0.025],
    bgBottom: [0.02, 0.022, 0.03],
    fogColor: [0, 0, 0],
    fogDensity: 0,
    sky: { ...DEFAULT_SKY, zenith: [0.02, 0.025, 0.04], horizon: [0.04, 0.04, 0.05], ground: [0.01, 0.01, 0.012], sunDir: normalize([-0.7, 0.4, 0.2]) as Vec3, sunColor: [1, 1, 1], sunIntensity: 6, sunAngularSize: 0.012 },
    view: { target: [0, 1.0, 0], yaw: 0.0, pitch: 0.05, distance: 6.4 },
  }
}

// An iridescence cabinet — the v9 thin-film showcase. The front row is a *thickness
// ladder*: six identical spheres whose only difference is the nanometre thickness of a
// high-index (TiO₂-like) coat, so the structural colour marches blue → gold → magenta →
// cyan across the row as the interference order shifts — the thickness→hue mapping made
// literal. Behind them sit an anodised-titanium knot (a coat over metal) and a real soap
// bubble (a pale air│water│air film — physically correct, hence the soft pastels). No
// textures, no pigment: every colour is wavelength interference solved in `thinfilm.ts`.
// Reads best under the path tracer (richest reflections), but the rasterizer twin shows
// the same coat through pbr.ts.
const iridescence = (): SceneConfig => {
  // a coat of `dNm` nanometres, index `filmIor`, over a substrate of index `ior`
  const filmMat = (albedo: Vec3, metallic: number, roughness: number, ior: number, filmIor: number, dNm: number): Material =>
    ({ albedo, specular: 0.9, shininess: 120, rim: 0, metallic, roughness, ior, filmIor, filmThicknessNm: dNm })
  const ladder = [180, 260, 340, 430, 520, 640]
  const objects: SceneObject[] = ladder.map((d, i): SceneObject => ({
    id: `film${i}`,
    meshKind: 'sphere',
    position: [(i - (ladder.length - 1) / 2) * 1.25, 0.62, 1.4],
    scale: 0.52, spin: 0, tiltSpin: 0, baseRotation: [0, 0, 0],
    // dark, near-black substrate so the structural colour is the only thing seen
    material: filmMat([0.02, 0.02, 0.025], 0, 0.06, 1.5, 2.3, d),
    texture: 'none', normalMap: 'none',
  }))
  objects.push(
    // anodised-titanium knot — a thin oxide coat over a metal substrate (high IOR)
    { id: 'anodised', meshKind: 'knot', position: [-1.4, 1.05, -0.9], scale: 0.95, spin: 0.35, tiltSpin: 0.1, baseRotation: [0, 0, 0], material: filmMat([0.55, 0.56, 0.58], 1, 0.12, 2.5, 2.4, 300), texture: 'none', normalMap: 'none' },
    // a real soap bubble — symmetric air│water│air film, so the colours are honestly pale
    { id: 'bubble', meshKind: 'sphere', position: [1.5, 1.0, -1.0], scale: 0.85, spin: 0, tiltSpin: 0, baseRotation: [0, 0, 0], material: filmMat([0.015, 0.015, 0.02], 0, 0.05, 1.0, 1.33, 460), texture: 'none', normalMap: 'none' },
  )
  return {
    name: 'Iridescence',
    ground: true,
    groundTexture: 'none',
    groundNormalMap: 'none',
    groundMaterial: mat([0.04, 0.045, 0.05], 0.1, 24, 0, 0, 0.5),
    objects,
    lights: [
      { type: 'dir', direction: normalize([-0.4, -0.82, -0.42]) as Vec3, color: [1, 0.98, 0.95], intensity: 1.7 },
      { type: 'point', position: [2.6, 2.9, 2.4], color: [0.8, 0.85, 1], intensity: 8, range: 13 },
    ],
    ambient: [0.06, 0.07, 0.09],
    bgTop: [0.05, 0.06, 0.09],
    bgBottom: [0.09, 0.09, 0.12],
    fogColor: [0, 0, 0],
    fogDensity: 0,
    sky: { ...DEFAULT_SKY, zenith: [0.16, 0.2, 0.32], horizon: [0.28, 0.3, 0.36], ground: [0.04, 0.04, 0.05], sunDir: normalize([-0.4, 0.7, 0.3]) as Vec3, sunColor: [1, 0.97, 0.92], sunIntensity: 3.2, sunAngularSize: 0.03, intensity: 1 },
    view: { target: [0, 0.8, 0.2], yaw: 0.12, pitch: 0.16, distance: 7.4 },
  }
}

export const PRESETS: Record<string, () => SceneConfig> = {
  showcase,
  interior,
  materials,
  pbrSweep,
  primitives,
  exhibit,
  cornell,
  reflections,
  glass,
  prism,
  iridescence,
  cathedral,
  nebula,
  implicit: implicitScene,
  custom: customScene,
}

export const PRESET_LABELS: { key: string; label: string }[] = [
  { key: 'showcase', label: 'Showcase' },
  { key: 'interior', label: 'Interior' },
  { key: 'materials', label: 'Materials' },
  { key: 'pbrSweep', label: 'PBR Sweep' },
  { key: 'primitives', label: 'Primitives' },
  { key: 'exhibit', label: 'Math Exhibit' },
  { key: 'cornell', label: 'Cornell Box' },
  { key: 'reflections', label: 'Reflections' },
  { key: 'glass', label: 'Glass' },
  { key: 'prism', label: 'Prism' },
  { key: 'iridescence', label: 'Iridescence' },
  { key: 'cathedral', label: 'Cathedral' },
  { key: 'nebula', label: 'Nebula' },
  { key: 'implicit', label: 'Implicit (SDF)' },
  { key: 'custom', label: 'Custom OBJ' },
]
