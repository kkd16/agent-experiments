// Built-in scenes. The first one is the default the studio opens with; the rest
// are one-click starting points that show off different corners of the engine
// (smooth blends, hard CSG, metal + reflections, emissive fog, organic unions).

import type {
  BooleanOp,
  Camera,
  DomainMod,
  Environment,
  Ground,
  Post,
  PrimitiveKind,
  Quality,
  Scene,
  SdfNode,
  Sun,
  TextureKind,
  Vec3,
} from './types'
import { makeNode } from './primitives'

function c(hex: string): Vec3 {
  const n = parseInt(hex.slice(1), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

interface NodeOpts {
  name?: string
  pos?: Vec3
  rot?: Vec3
  scale?: number
  params?: number[]
  color?: string
  metallic?: number
  rough?: number
  refl?: number
  emission?: number
  op?: BooleanOp
  smooth?: boolean
  radius?: number
  // Domain modifier
  domain?: DomainMod
  repeat?: Vec3
  repeatLimit?: number
  mirror?: Vec3
  twist?: number
  bend?: number
  round?: number
  shell?: number
  // Material texture
  texture?: TextureKind
  texScale?: number
  texStrength?: number
  // Animation
  spin?: Vec3
  posAmp?: Vec3
  posSpeed?: Vec3
  scalePulse?: number
  scaleSpeed?: number
}

function mk(kind: PrimitiveKind, o: NodeOpts = {}): SdfNode {
  const n = makeNode(kind)
  if (o.name) n.name = o.name
  if (o.pos) n.transform.position = o.pos
  if (o.rot) n.transform.rotation = o.rot
  if (o.scale != null) n.transform.scale = o.scale
  if (o.params) n.params = o.params
  if (o.color) n.material.color = c(o.color)
  if (o.metallic != null) n.material.metallic = o.metallic
  if (o.rough != null) n.material.roughness = o.rough
  if (o.refl != null) n.material.reflectivity = o.refl
  if (o.emission != null) n.material.emission = o.emission
  if (o.op) n.combine.op = o.op
  if (o.smooth != null) n.combine.smooth = o.smooth
  if (o.radius != null) n.combine.radius = o.radius
  if (o.domain) n.modifier.domain = o.domain
  if (o.repeat) n.modifier.repeat = o.repeat
  if (o.repeatLimit != null) n.modifier.repeatLimit = o.repeatLimit
  if (o.mirror) n.modifier.mirror = o.mirror
  if (o.twist != null) n.modifier.twist = o.twist
  if (o.bend != null) n.modifier.bend = o.bend
  if (o.round != null) n.modifier.round = o.round
  if (o.shell != null) {
    n.modifier.shellOn = true
    n.modifier.shell = o.shell
  }
  if (o.texture) n.material.texture = o.texture
  if (o.texScale != null) n.material.texScale = o.texScale
  if (o.texStrength != null) n.material.texStrength = o.texStrength
  if (o.spin || o.posAmp || o.posSpeed || o.scalePulse != null || o.scaleSpeed != null) {
    n.anim.enabled = true
    if (o.spin) n.anim.spin = o.spin
    if (o.posAmp) n.anim.posAmp = o.posAmp
    if (o.posSpeed) n.anim.posSpeed = o.posSpeed
    if (o.scalePulse != null) n.anim.scalePulse = o.scalePulse
    if (o.scaleSpeed != null) n.anim.scaleSpeed = o.scaleSpeed
  }
  return n
}

export function defaultCamera(): Camera {
  return {
    target: [0, 0.6, 0],
    distance: 6,
    azimuth: 35,
    elevation: 22,
    fov: 45,
    autoRotate: true,
    autoRotateSpeed: 8,
  }
}

export function defaultSun(): Sun {
  return { azimuth: 40, elevation: 42, color: c('#fff3e0'), intensity: 1.15 }
}

export function defaultEnv(): Environment {
  return {
    skyColor: c('#5b8fd6'),
    horizonColor: c('#cfe3f5'),
    groundColor: c('#3a3a44'),
    ambient: 0.55,
    fogDensity: 0.012,
    fogColor: c('#cfe3f5'),
  }
}

export function defaultGround(): Ground {
  return {
    enabled: true,
    height: -1,
    checker: true,
    color1: c('#20222b'),
    color2: c('#2b2e39'),
  }
}

export function defaultQuality(): Quality {
  return {
    maxSteps: 140,
    maxDist: 60,
    surfaceEps: 0.0012,
    shadowSoftness: 12,
    shadowStrength: 0.9,
    aoStrength: 0.9,
    reflections: true,
    antialias: false,
    resolutionScale: 1,
  }
}

export function defaultPost(): Post {
  return { exposure: 1.15, gamma: 2.2, vignette: 0.35, saturation: 1.08 }
}

function base(nodes: SdfNode[], over: Partial<Scene> = {}): Scene {
  return {
    nodes,
    camera: defaultCamera(),
    sun: defaultSun(),
    env: defaultEnv(),
    ground: defaultGround(),
    quality: defaultQuality(),
    post: defaultPost(),
    animate: true,
    ...over,
  }
}

function genesis(): Scene {
  return base([
    mk('sphere', { name: 'Core', pos: [-0.7, 0.4, 0], params: [0.9, 0, 0, 0], color: '#e0524a', rough: 0.35 }),
    mk('box', {
      name: 'Slab',
      pos: [0.7, 0.2, 0],
      params: [0.7, 0.5, 0.7, 0],
      color: '#4a9fe0',
      op: 'union',
      smooth: true,
      radius: 0.5,
      rough: 0.3,
    }),
    mk('torus', {
      name: 'Ring',
      pos: [0, 0.9, 0],
      rot: [90, 0, 0],
      params: [1.1, 0.18, 0, 0],
      color: '#f4d35e',
      op: 'union',
      smooth: true,
      radius: 0.3,
      metallic: 0.6,
      rough: 0.25,
      refl: 0.3,
    }),
  ])
}

function lattice(): Scene {
  return base(
    [
      mk('box', { name: 'Block', params: [1, 1, 1, 0], pos: [0, 0.4, 0], color: '#43c6ac', rough: 0.3 }),
      mk('sphere', {
        name: 'Round',
        params: [1.28, 0, 0, 0],
        pos: [0, 0.4, 0],
        op: 'intersect',
        smooth: false,
        color: '#43c6ac',
      }),
      mk('cylinder', {
        name: 'Bore X',
        params: [0.42, 2, 0, 0],
        rot: [0, 0, 90],
        pos: [0, 0.4, 0],
        op: 'subtract',
        smooth: false,
      }),
      mk('cylinder', { name: 'Bore Y', params: [0.42, 2, 0, 0], pos: [0, 0.4, 0], op: 'subtract', smooth: false }),
      mk('cylinder', {
        name: 'Bore Z',
        params: [0.42, 2, 0, 0],
        rot: [90, 0, 0],
        pos: [0, 0.4, 0],
        op: 'subtract',
        smooth: false,
      }),
    ],
    { camera: { ...defaultCamera(), autoRotate: true, autoRotateSpeed: 12, elevation: 26 } },
  )
}

function orrery(): Scene {
  return base(
    [
      mk('sphere', { name: 'Sun', params: [0.7, 0, 0, 0], pos: [0, 0.8, 0], color: '#ffb347', emission: 0.9, rough: 0.5 }),
      mk('torus', {
        name: 'Orbit 1',
        params: [1.5, 0.04, 0, 0],
        pos: [0, 0.8, 0],
        rot: [80, 0, 12],
        color: '#9fb3c8',
        op: 'union',
        smooth: false,
        metallic: 1,
        rough: 0.15,
        refl: 0.5,
      }),
      mk('torus', {
        name: 'Orbit 2',
        params: [2.2, 0.04, 0, 0],
        pos: [0, 0.8, 0],
        rot: [72, 20, -8],
        color: '#9fb3c8',
        op: 'union',
        smooth: false,
        metallic: 1,
        rough: 0.15,
        refl: 0.5,
      }),
      mk('sphere', {
        name: 'Planet',
        params: [0.28, 0, 0, 0],
        pos: [1.5, 1.05, 0],
        color: '#4a9fe0',
        metallic: 0.9,
        rough: 0.2,
        refl: 0.6,
      }),
    ],
    {
      sun: { ...defaultSun(), intensity: 1.0, elevation: 30 },
      env: { ...defaultEnv(), skyColor: c('#0d1b3a'), horizonColor: c('#243b6b'), ambient: 0.35, fogColor: c('#0d1b3a'), fogDensity: 0.02 },
      ground: { ...defaultGround(), checker: false, color1: c('#12131a'), color2: c('#12131a') },
      post: { ...defaultPost(), exposure: 1.25, vignette: 0.55, saturation: 1.15 },
    },
  )
}

function monolith(): Scene {
  return base(
    [
      mk('roundBox', {
        name: 'Slab',
        params: [0.5, 1.8, 0.5, 0.08],
        pos: [0, 0.9, 0],
        color: '#1b1d26',
        rough: 0.2,
        metallic: 0.4,
        refl: 0.4,
      }),
      mk('box', {
        name: 'Seam',
        params: [0.6, 0.03, 0.6, 0],
        pos: [0, 1.4, 0],
        op: 'subtract',
        smooth: false,
      }),
      mk('sphere', {
        name: 'Ember',
        params: [0.22, 0, 0, 0],
        pos: [0, 2.4, 0],
        color: '#ff5a2b',
        emission: 1.0,
        op: 'union',
        smooth: true,
        radius: 0.2,
      }),
    ],
    {
      camera: { ...defaultCamera(), elevation: 10, distance: 7, target: [0, 1, 0] },
      sun: { ...defaultSun(), elevation: 12, azimuth: 120, color: c('#ff7a3c'), intensity: 1.4 },
      env: { ...defaultEnv(), skyColor: c('#2a1030'), horizonColor: c('#5a2438'), groundColor: c('#150a12'), ambient: 0.3, fogColor: c('#3a1626'), fogDensity: 0.05 },
      ground: { ...defaultGround(), checker: false, color1: c('#0e0910'), color2: c('#0e0910') },
      post: { ...defaultPost(), exposure: 1.2, vignette: 0.7, saturation: 1.2 },
    },
  )
}

function bloom(): Scene {
  const petals: SdfNode[] = []
  const colors = ['#e0524a', '#f0a43a', '#f4d35e', '#8bd450', '#43c6ac', '#7a6ff0']
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2
    petals.push(
      mk('capsule', {
        name: `Petal ${i + 1}`,
        params: [0.7, 0.28, 0, 0],
        pos: [Math.cos(a) * 0.8, 0.7, Math.sin(a) * 0.8],
        rot: [90, (a * 180) / Math.PI, 0],
        color: colors[i],
        op: 'union',
        smooth: true,
        radius: 0.5,
        rough: 0.4,
      }),
    )
  }
  return base(
    [
      mk('sphere', { name: 'Heart', params: [0.5, 0, 0, 0], pos: [0, 0.7, 0], color: '#f4d35e', emission: 0.3 }),
      ...petals,
    ],
    {
      camera: { ...defaultCamera(), elevation: 35, distance: 5.5 },
      env: { ...defaultEnv(), skyColor: c('#6fa8dc'), horizonColor: c('#e9f2fb'), ambient: 0.65 },
      post: { ...defaultPost(), saturation: 1.2, exposure: 1.1 },
    },
  )
}

// Infinite colonnade — a single node tiled by the repeat modifier, with a
// procedural marble texture and a slow drifting camera.
function colonnade(): Scene {
  return base(
    [
      mk('box', {
        name: 'Floor strip',
        params: [6, 0.12, 1.2, 0],
        pos: [0, -0.9, 0],
        color: '#d8cdb8',
        rough: 0.6,
        texture: 'checker',
        texScale: 1.2,
        texStrength: 0.35,
      }),
      mk('roundCone', {
        name: 'Columns',
        params: [0.42, 0.3, 2.2, 0],
        pos: [0, 0.2, 0],
        color: '#efe7d6',
        rough: 0.45,
        refl: 0.06,
        domain: 'repeat',
        repeat: [2.2, 0, 0],
        repeatLimit: 3,
        texture: 'marble',
        texScale: 1.6,
        texStrength: 0.5,
        op: 'union',
        smooth: false,
      }),
      mk('hexPrism', {
        name: 'Capitals',
        params: [0.6, 0.16, 0, 0],
        rot: [90, 0, 0],
        pos: [0, 1.5, 0],
        color: '#efe7d6',
        rough: 0.45,
        domain: 'repeat',
        repeat: [2.2, 0, 0],
        repeatLimit: 3,
        op: 'union',
        smooth: false,
      }),
    ],
    {
      camera: { ...defaultCamera(), distance: 9, elevation: 12, azimuth: 24, autoRotateSpeed: 5 },
      sun: { ...defaultSun(), azimuth: 60, elevation: 30, intensity: 1.3 },
      env: { ...defaultEnv(), ambient: 0.6, skyColor: c('#6a97cf'), horizonColor: c('#efe9dc') },
      ground: { ...defaultGround(), checker: false, color1: c('#b6a88c'), color2: c('#b6a88c'), height: -1 },
    },
  )
}

// A twisted tower: one tall box warped by the twist modifier, metallic and
// spinning, throwing real reflections off a mirror floor.
function gyre(): Scene {
  return base(
    [
      mk('box', {
        name: 'Tower',
        params: [0.7, 1.7, 0.7, 0],
        pos: [0, 0.9, 0],
        color: '#c85a9c',
        metallic: 0.85,
        rough: 0.22,
        refl: 0.5,
        domain: 'twist',
        twist: 1.7,
        round: 0.05,
        spin: [0, 24, 0],
      }),
      mk('octahedron', {
        name: 'Crown',
        params: [0.55, 0, 0, 0],
        pos: [0, 2.5, 0],
        color: '#f4d35e',
        metallic: 1,
        rough: 0.15,
        refl: 0.6,
        op: 'union',
        smooth: true,
        radius: 0.25,
        spin: [0, -40, 0],
      }),
    ],
    {
      camera: { ...defaultCamera(), distance: 7, elevation: 16, target: [0, 1.1, 0], autoRotateSpeed: 6 },
      sun: { ...defaultSun(), elevation: 36, azimuth: 70 },
      env: { ...defaultEnv(), skyColor: c('#20304f'), horizonColor: c('#5a6f97'), ambient: 0.4, fogColor: c('#20304f'), fogDensity: 0.015 },
      ground: { ...defaultGround(), checker: false, color1: c('#0c0e16'), color2: c('#0c0e16'), height: -0.05 },
      quality: { ...defaultQuality(), reflections: true },
      post: { ...defaultPost(), exposure: 1.2, vignette: 0.5, saturation: 1.15 },
    },
  )
}

// Kaleidoscopic pod: mirror symmetry folds a handful of shapes into a jewel.
function kaleido(): Scene {
  return base(
    [
      mk('torus', {
        name: 'Weave',
        params: [0.9, 0.16, 0, 0],
        pos: [0, 0.9, 0],
        rot: [40, 0, 0],
        color: '#43c6ac',
        metallic: 0.6,
        rough: 0.25,
        refl: 0.35,
        domain: 'mirror',
        mirror: [1, 0, 1],
      }),
      mk('capsule', {
        name: 'Spokes',
        params: [0.8, 0.14, 0, 0],
        pos: [0.5, 0.9, 0.5],
        rot: [0, 0, 55],
        color: '#7a6ff0',
        metallic: 0.5,
        rough: 0.3,
        domain: 'mirror',
        mirror: [1, 1, 1],
        op: 'union',
        smooth: true,
        radius: 0.3,
      }),
      mk('sphere', {
        name: 'Heart',
        params: [0.5, 0, 0, 0],
        pos: [0, 0.9, 0],
        color: '#f4d35e',
        emission: 0.5,
        op: 'union',
        smooth: true,
        radius: 0.35,
        scalePulse: 0.12,
        scaleSpeed: 2,
      }),
    ],
    {
      camera: { ...defaultCamera(), distance: 5.5, elevation: 24, target: [0, 0.9, 0] },
      env: { ...defaultEnv(), skyColor: c('#3a2a5a'), horizonColor: c('#c9b8e8'), ambient: 0.55 },
      post: { ...defaultPost(), saturation: 1.25, exposure: 1.15, vignette: 0.45 },
    },
  )
}

// A little bestiary of the new primitives with procedural surfaces and gentle motion.
function menagerie(): Scene {
  return base(
    [
      mk('ellipsoid', {
        name: 'Egg',
        params: [0.55, 0.8, 0.5, 0],
        pos: [-1.6, 0.2, 0],
        color: '#e0a24a',
        rough: 0.5,
        texture: 'noise',
        texScale: 6,
        texStrength: 0.4,
        posAmp: [0, 0.25, 0],
        posSpeed: [1.4, 1.4, 1.4],
      }),
      mk('link', {
        name: 'Link',
        params: [0.32, 0.5, 0.16, 0],
        pos: [0, 0.4, 0],
        rot: [0, 0, 0],
        color: '#4a9fe0',
        metallic: 0.9,
        rough: 0.2,
        refl: 0.5,
        op: 'union',
        smooth: false,
        spin: [40, 0, 20],
      }),
      mk('pyramid', {
        name: 'Ziggurat',
        params: [1.4, 0, 0, 0],
        pos: [1.7, -0.5, 0],
        scale: 0.9,
        color: '#8bd450',
        rough: 0.55,
        texture: 'wood',
        texScale: 2.2,
        texStrength: 0.45,
        op: 'union',
        smooth: false,
      }),
      mk('hexPrism', {
        name: 'Bolt',
        params: [0.5, 0.35, 0, 0],
        pos: [0, 1.4, -0.2],
        color: '#d36fb3',
        metallic: 0.7,
        rough: 0.3,
        refl: 0.3,
        op: 'union',
        smooth: true,
        radius: 0.2,
        spin: [0, 60, 0],
      }),
    ],
    {
      camera: { ...defaultCamera(), distance: 7, elevation: 20 },
      env: { ...defaultEnv(), ambient: 0.6 },
      quality: { ...defaultQuality(), reflections: true },
    },
  )
}

export interface Preset {
  id: string
  name: string
  build: () => Scene
}

export const PRESETS: Preset[] = [
  { id: 'genesis', name: 'Genesis', build: genesis },
  { id: 'lattice', name: 'Lattice', build: lattice },
  { id: 'orrery', name: 'Orrery', build: orrery },
  { id: 'monolith', name: 'Monolith', build: monolith },
  { id: 'bloom', name: 'Bloom', build: bloom },
  { id: 'colonnade', name: 'Colonnade', build: colonnade },
  { id: 'gyre', name: 'Gyre', build: gyre },
  { id: 'kaleido', name: 'Kaleido', build: kaleido },
  { id: 'menagerie', name: 'Menagerie', build: menagerie },
]

export function defaultScene(): Scene {
  return genesis()
}
