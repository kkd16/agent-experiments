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
  Render,
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
  transmission?: number
  ior?: number
  absorption?: number
  dispersion?: number
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
  elongate?: Vec3
  polar?: number
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
  if (o.transmission != null) n.material.transmission = o.transmission
  if (o.ior != null) n.material.ior = o.ior
  if (o.absorption != null) n.material.absorption = o.absorption
  if (o.dispersion != null) n.material.dispersion = o.dispersion
  if (o.op) n.combine.op = o.op
  if (o.smooth != null) n.combine.smooth = o.smooth
  if (o.radius != null) n.combine.radius = o.radius
  if (o.domain) n.modifier.domain = o.domain
  if (o.repeat) n.modifier.repeat = o.repeat
  if (o.repeatLimit != null) n.modifier.repeatLimit = o.repeatLimit
  if (o.mirror) n.modifier.mirror = o.mirror
  if (o.twist != null) n.modifier.twist = o.twist
  if (o.bend != null) n.modifier.bend = o.bend
  if (o.elongate) n.modifier.elongate = o.elongate
  if (o.polar != null) n.modifier.polar = o.polar
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
    aperture: 0,
    focusDistance: 6,
  }
}

export function defaultSun(): Sun {
  return { azimuth: 40, elevation: 42, color: c('#fff3e0'), intensity: 1.15, angle: 2 }
}

export function defaultEnv(): Environment {
  return {
    skyColor: c('#5b8fd6'),
    horizonColor: c('#cfe3f5'),
    groundColor: c('#3a3a44'),
    ambient: 0.55,
    fogDensity: 0.012,
    fogColor: c('#cfe3f5'),
    emissive: false,
    emissiveStrength: 1,
    emissiveShadows: false,
  }
}

export function defaultRender(): Render {
  return { accumulate: true, maxSamples: 256, integrator: 'raymarch', bounces: 4, fireflyClamp: 6 }
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
  return {
    exposure: 1.15,
    gamma: 2.2,
    vignette: 0.35,
    saturation: 1.08,
    bloom: 0,
    bloomThreshold: 1.1,
    bloomRadius: 1,
  }
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
    render: defaultRender(),
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

// A row of spheres marching into the distance — the near and far ones melt into
// bokeh while the middle one snaps into focus. Best seen with auto-rotate off.
function aperture(): Scene {
  const nodes: SdfNode[] = []
  const cols = ['#e0524a', '#f0a43a', '#f4d35e', '#43c6ac', '#4a9fe0', '#7a6ff0']
  for (let i = 0; i < 6; i++) {
    nodes.push(
      mk('sphere', {
        name: `Bead ${i + 1}`,
        params: [0.5, 0, 0, 0],
        pos: [(i - 2.5) * 1.15, 0.1, -(i - 2.5) * 1.15],
        color: cols[i],
        metallic: 0.2,
        rough: 0.25,
        refl: 0.25,
        op: 'union',
        smooth: false,
      }),
    )
  }
  return base(nodes, {
    camera: {
      ...defaultCamera(),
      autoRotate: false,
      distance: 8,
      elevation: 8,
      azimuth: 34,
      fov: 38,
      aperture: 0.11,
      focusDistance: 8,
      target: [0, 0.1, 0],
    },
    sun: { ...defaultSun(), elevation: 34, azimuth: 55, angle: 3 },
    env: { ...defaultEnv(), ambient: 0.5 },
    ground: { ...defaultGround(), checker: true, color1: c('#1a1c24'), color2: c('#23262f') },
    post: { ...defaultPost(), vignette: 0.5, exposure: 1.15 },
    render: { ...defaultRender(), maxSamples: 512 },
  })
}

// A glowing lantern that genuinely lights the darkness around it: the emissive
// core is the only real light, spilling warm colour onto the pillars and floor.
function lantern(): Scene {
  return base(
    [
      mk('roundBox', {
        name: 'Cage',
        params: [0.42, 0.6, 0.42, 0.05],
        pos: [0, 0.7, 0],
        color: '#2a2118',
        rough: 0.4,
        metallic: 0.6,
        refl: 0.2,
        shell: 0.06,
      }),
      mk('sphere', {
        name: 'Flame',
        params: [0.28, 0, 0, 0],
        pos: [0, 0.7, 0],
        color: '#ffb14a',
        emission: 1.4,
        op: 'union',
        smooth: false,
        scalePulse: 0.06,
        scaleSpeed: 3,
      }),
      mk('cylinder', {
        name: 'Pillars',
        params: [0.18, 1.1, 0, 0],
        pos: [1.7, 0.1, 0],
        color: '#c9c2b4',
        rough: 0.5,
        domain: 'polar',
        polar: 5,
        op: 'union',
        smooth: false,
      }),
    ],
    {
      camera: { ...defaultCamera(), distance: 6.5, elevation: 14, target: [0, 0.7, 0], autoRotateSpeed: 5 },
      sun: { ...defaultSun(), intensity: 0.15, elevation: 60 },
      env: {
        ...defaultEnv(),
        skyColor: c('#0a0c14'),
        horizonColor: c('#141824'),
        groundColor: c('#0a0a10'),
        ambient: 0.12,
        fogColor: c('#0a0c14'),
        fogDensity: 0.03,
        emissive: true,
        emissiveStrength: 1.6,
        emissiveShadows: true,
      },
      ground: { ...defaultGround(), checker: false, color1: c('#0c0d12'), color2: c('#0c0d12') },
      post: { ...defaultPost(), exposure: 1.3, vignette: 0.7, saturation: 1.2 },
      render: { ...defaultRender(), maxSamples: 512 },
    },
  )
}

// A brass gear machine: one tooth elongated and folded into rings by the polar
// modifier, stacked into interlocking cogs. Shows off elongate + polar together.
function gearwork(): Scene {
  return base(
    [
      mk('box', {
        name: 'Gear A',
        params: [0.16, 0.12, 0.16, 0],
        pos: [-0.9, 0.6, 0],
        color: '#c8963e',
        metallic: 0.9,
        rough: 0.28,
        refl: 0.35,
        domain: 'polar',
        polar: 12,
        elongate: [1.0, 0, 0],
        spin: [0, 30, 0],
      }),
      mk('cylinder', {
        name: 'Hub A',
        params: [0.4, 0.14, 0, 0],
        pos: [-0.9, 0.6, 0],
        color: '#8a6a2a',
        metallic: 0.9,
        rough: 0.3,
        refl: 0.3,
        op: 'union',
        smooth: true,
        radius: 0.08,
        spin: [0, 30, 0],
      }),
      mk('box', {
        name: 'Gear B',
        params: [0.14, 0.12, 0.14, 0],
        pos: [0.62, 0.6, 0],
        color: '#c8963e',
        metallic: 0.9,
        rough: 0.28,
        refl: 0.35,
        domain: 'polar',
        polar: 10,
        elongate: [0.85, 0, 0],
        op: 'union',
        smooth: false,
        spin: [0, -36, 0],
      }),
    ],
    {
      camera: { ...defaultCamera(), distance: 6, elevation: 46, target: [0, 0.6, 0], autoRotateSpeed: 4 },
      sun: { ...defaultSun(), elevation: 52, azimuth: 30, angle: 4 },
      env: { ...defaultEnv(), skyColor: c('#26313f'), horizonColor: c('#aeb9c6'), ambient: 0.5 },
      ground: { ...defaultGround(), checker: false, color1: c('#15171e'), color2: c('#15171e'), height: -0.2 },
      quality: { ...defaultQuality(), reflections: true },
      post: { ...defaultPost(), exposure: 1.15, saturation: 1.12 },
    },
  )
}

// The canonical global-illumination test scene: a white room with one red wall,
// one green wall and a single glowing panel in the ceiling. With the path tracer
// on you see the effect that no raymarch shade can fake — the red and green walls
// bleed their colour onto the white floor, ceiling and the two inner blocks. Best
// viewed head-on (auto-rotate off); the front is open so the camera looks in.
function cornellBox(): Scene {
  const white = '#d6d6d1'
  const wall = (o: NodeOpts): SdfNode =>
    mk('box', { color: white, rough: 0.92, refl: 0.02, op: 'union', smooth: false, ...o })
  return base(
    [
      wall({ name: 'Floor', params: [1.5, 0.05, 1.5, 0], pos: [0, 0, 0] }),
      wall({ name: 'Ceiling', params: [1.5, 0.05, 1.5, 0], pos: [0, 3, 0] }),
      wall({ name: 'Back wall', params: [1.5, 1.5, 0.05, 0], pos: [0, 1.5, -1.5] }),
      wall({ name: 'Left wall (red)', params: [0.05, 1.5, 1.5, 0], pos: [-1.5, 1.5, 0], color: '#c1352b' }),
      wall({ name: 'Right wall (green)', params: [0.05, 1.5, 1.5, 0], pos: [1.5, 1.5, 0], color: '#2f9e44' }),
      mk('box', {
        name: 'Light',
        params: [0.55, 0.02, 0.5, 0],
        pos: [0, 2.96, -0.1],
        color: '#fff4e0',
        emission: 4.2,
        rough: 1,
        op: 'union',
        smooth: false,
      }),
      wall({ name: 'Tall block', params: [0.32, 0.72, 0.32, 0], pos: [-0.52, 0.72, -0.42], rot: [0, 19, 0] }),
      wall({ name: 'Short block', params: [0.34, 0.34, 0.34, 0], pos: [0.55, 0.34, 0.42], rot: [0, -22, 0] }),
    ],
    {
      camera: {
        ...defaultCamera(),
        autoRotate: false,
        target: [0, 1.4, 0],
        distance: 5.6,
        azimuth: 0,
        elevation: 4,
        fov: 42,
      },
      sun: { ...defaultSun(), intensity: 0 },
      env: {
        ...defaultEnv(),
        skyColor: c('#05060a'),
        horizonColor: c('#05060a'),
        groundColor: c('#05060a'),
        ambient: 0,
        fogDensity: 0,
        fogColor: c('#05060a'),
        emissive: true,
        emissiveStrength: 1,
      },
      ground: { ...defaultGround(), enabled: false },
      quality: { ...defaultQuality(), maxSteps: 120, maxDist: 40 },
      post: { ...defaultPost(), exposure: 1.35, vignette: 0.25, saturation: 1.05 },
      render: { ...defaultRender(), integrator: 'pathtrace', bounces: 6, maxSamples: 640, fireflyClamp: 8 },
    },
  )
}

// A colour-bleeding still life under a soft sun: a matte white sphere flanked by a
// saturated red wall and a blue wall. Path-traced, the sphere's shadow flank glows
// red on one side and blue on the other — bounce light carrying wall colour — while
// a little chrome sphere mirrors the whole set. The lesson of indirect light in one
// frame; switch to Ray march to watch the colour bleed vanish.
function radiance(): Scene {
  return base(
    [
      mk('sphere', { name: 'Matte sphere', params: [0.8, 0, 0, 0], pos: [0, 0.8, 0], color: '#e8e4dc', rough: 0.95, refl: 0.02 }),
      mk('box', {
        name: 'Red wall',
        params: [0.06, 1.3, 1.4, 0],
        pos: [-1.5, 1.3, 0],
        color: '#d1332a',
        rough: 0.95,
        op: 'union',
        smooth: false,
      }),
      mk('box', {
        name: 'Blue wall',
        params: [0.06, 1.3, 1.4, 0],
        pos: [1.5, 1.3, 0],
        color: '#2f6bd1',
        rough: 0.95,
        op: 'union',
        smooth: false,
      }),
      mk('sphere', {
        name: 'Chrome',
        params: [0.45, 0, 0, 0],
        pos: [0.95, 0.45, 1.0],
        color: '#e8e8ee',
        metallic: 1,
        rough: 0.06,
        refl: 0.7,
        op: 'union',
        smooth: false,
      }),
    ],
    {
      camera: { ...defaultCamera(), autoRotate: false, target: [0, 0.8, 0], distance: 6.2, azimuth: 12, elevation: 12, fov: 40 },
      sun: { ...defaultSun(), elevation: 58, azimuth: 35, intensity: 1.05, angle: 3 },
      env: { ...defaultEnv(), skyColor: c('#8fb2e0'), horizonColor: c('#dfeaf6'), ambient: 0.4, fogDensity: 0 },
      ground: { ...defaultGround(), checker: false, color1: c('#cfcabd'), color2: c('#cfcabd'), height: 0 },
      quality: { ...defaultQuality(), maxSteps: 130, maxDist: 50 },
      post: { ...defaultPost(), exposure: 1.2, vignette: 0.35, saturation: 1.1 },
      render: { ...defaultRender(), integrator: 'pathtrace', bounces: 5, maxSamples: 512, fireflyClamp: 8 },
    },
  )
}

// Pure emissive global illumination: a dark room with no sun, lit only by two
// coloured neon bars — magenta on the left, cyan on the right. Path-traced, each
// bar is a real area light; where their beams overlap on the central shapes the
// colours mix toward white, one flank of every object glows magenta and the other
// cyan, and the soft penumbrae come straight from the bars' finite size. The
// clearest demonstration of the multi-emitter next-event estimation.
function nocturne(): Scene {
  return base(
    [
      mk('roundBox', { name: 'Floor', params: [3, 0.1, 2.4, 0.05], pos: [0, -0.1, 0], color: '#15151c', rough: 0.55, refl: 0.12, op: 'union', smooth: false }),
      mk('sphere', { name: 'Sphere', params: [0.62, 0, 0, 0], pos: [-0.55, 0.62, 0], color: '#d8d8e0', rough: 0.85, op: 'union', smooth: false }),
      mk('octahedron', { name: 'Gem', params: [0.7, 0, 0, 0], pos: [0.7, 0.66, 0.1], color: '#e8e8ee', metallic: 0.6, rough: 0.25, refl: 0.4, op: 'union', smooth: false, spin: [0, 24, 0] }),
      mk('roundBox', {
        name: 'Neon left (magenta)',
        params: [0.05, 0.9, 0.05, 0.04],
        pos: [-1.9, 1.0, 0],
        color: '#ff3ba7',
        emission: 3.4,
        rough: 1,
        op: 'union',
        smooth: false,
      }),
      mk('roundBox', {
        name: 'Neon right (cyan)',
        params: [0.05, 0.9, 0.05, 0.04],
        pos: [1.9, 1.0, 0],
        color: '#37e0ff',
        emission: 3.4,
        rough: 1,
        op: 'union',
        smooth: false,
      }),
    ],
    {
      camera: { ...defaultCamera(), autoRotate: true, autoRotateSpeed: 5, target: [0, 0.6, 0], distance: 6.4, elevation: 14, azimuth: 8 },
      sun: { ...defaultSun(), intensity: 0 },
      env: {
        ...defaultEnv(),
        skyColor: c('#04040a'),
        horizonColor: c('#04040a'),
        groundColor: c('#04040a'),
        ambient: 0,
        fogColor: c('#04040a'),
        fogDensity: 0.02,
        emissive: true,
        emissiveStrength: 1.1,
      },
      ground: { ...defaultGround(), enabled: false },
      quality: { ...defaultQuality(), maxSteps: 130, maxDist: 50 },
      post: { ...defaultPost(), exposure: 1.35, vignette: 0.6, saturation: 1.2 },
      render: { ...defaultRender(), integrator: 'pathtrace', bounces: 5, maxSamples: 640, fireflyClamp: 8 },
    },
  )
}

// Prism — chromatic dispersion. A cut-glass gem and a bead rest on a bright checker
// floor and bend it beneath them; because each path commits to one wavelength the
// accumulation reconstructs a full rainbow along every refracting edge. The
// signature of the new dielectric path.
function prism(): Scene {
  return base(
    [
      mk('octahedron', {
        name: 'Gem',
        params: [1.0, 0, 0, 0],
        pos: [0, 1.0, 0],
        rot: [10, 22, 0],
        color: '#ffffff',
        rough: 0.02,
        transmission: 1,
        ior: 1.7,
        dispersion: 0.55,
      }),
      mk('sphere', {
        name: 'Bead',
        params: [0.5, 0, 0, 0],
        pos: [1.35, 0.5, 0.7],
        color: '#ffffff',
        rough: 0.02,
        transmission: 1,
        ior: 1.5,
        dispersion: 0.45,
        op: 'union',
        smooth: false,
      }),
    ],
    {
      camera: {
        ...defaultCamera(),
        autoRotate: false,
        distance: 5,
        elevation: 16,
        azimuth: 26,
        target: [0, 0.85, 0],
        fov: 42,
      },
      sun: { ...defaultSun(), intensity: 1.8, elevation: 44, azimuth: 120, angle: 1.5, color: c('#ffffff') },
      env: {
        ...defaultEnv(),
        skyColor: c('#6f92c8'),
        horizonColor: c('#e6eefb'),
        groundColor: c('#4a5568'),
        ambient: 0.4,
        fogDensity: 0,
      },
      ground: { ...defaultGround(), checker: true, color1: c('#e9edf4'), color2: c('#2a3550'), height: 0 },
      quality: { ...defaultQuality(), maxSteps: 190 },
      post: { ...defaultPost(), exposure: 1.2, vignette: 0.45, saturation: 1.3, bloom: 0.22, bloomThreshold: 1.5 },
      render: { ...defaultRender(), integrator: 'pathtrace', bounces: 8, maxSamples: 768, fireflyClamp: 5 },
    },
  )
}

// Crystal — refraction + coloured absorption. A clear glass ball and a teal block
// sit in an open studio box lit by a single panel: the ball bends the room behind
// it, the block drinks red and green as light travels through it (Beer–Lambert), so
// it glows teal from the inside. Path-traced.
function crystal(): Scene {
  const white = '#cfcfca'
  const wall = (o: NodeOpts): SdfNode =>
    mk('box', { color: white, rough: 0.9, refl: 0.02, op: 'union', smooth: false, ...o })
  return base(
    [
      wall({ name: 'Floor', params: [1.6, 0.05, 1.6, 0], pos: [0, 0, 0] }),
      wall({ name: 'Back wall', params: [1.6, 1.5, 0.05, 0], pos: [0, 1.5, -1.6] }),
      wall({ name: 'Left wall (blue)', params: [0.05, 1.5, 1.6, 0], pos: [-1.6, 1.5, 0], color: '#3b6fb0' }),
      wall({ name: 'Right wall (amber)', params: [0.05, 1.5, 1.6, 0], pos: [1.6, 1.5, 0], color: '#c46b2e' }),
      mk('box', {
        name: 'Light',
        params: [0.6, 0.02, 0.5, 0],
        pos: [0, 2.7, 0],
        color: '#fff4e0',
        emission: 4.0,
        rough: 1,
        op: 'union',
        smooth: false,
      }),
      mk('sphere', {
        name: 'Clear ball',
        params: [0.62, 0, 0, 0],
        pos: [-0.6, 0.62, 0.25],
        color: '#ffffff',
        rough: 0.02,
        transmission: 1,
        ior: 1.5,
        op: 'union',
        smooth: false,
      }),
      mk('roundBox', {
        name: 'Teal glass',
        params: [0.4, 0.72, 0.4, 0.08],
        pos: [0.62, 0.72, -0.25],
        rot: [0, 18, 0],
        color: '#3ad6c0',
        rough: 0.03,
        transmission: 1,
        ior: 1.45,
        absorption: 3.2,
        op: 'union',
        smooth: false,
      }),
    ],
    {
      camera: {
        ...defaultCamera(),
        autoRotate: false,
        target: [0, 1.0, 0],
        distance: 5.4,
        azimuth: 0,
        elevation: 6,
        fov: 44,
      },
      sun: { ...defaultSun(), intensity: 0 },
      env: {
        ...defaultEnv(),
        skyColor: c('#05060a'),
        horizonColor: c('#05060a'),
        groundColor: c('#05060a'),
        ambient: 0.03,
        fogDensity: 0,
        emissive: true,
        emissiveStrength: 1,
      },
      ground: { ...defaultGround(), enabled: false },
      quality: { ...defaultQuality(), maxSteps: 170, maxDist: 40 },
      post: { ...defaultPost(), exposure: 1.3, vignette: 0.3, saturation: 1.12, bloom: 0.2, bloomThreshold: 1.5 },
      render: { ...defaultRender(), integrator: 'pathtrace', bounces: 8, maxSamples: 768, fireflyClamp: 6 },
    },
  )
}

// Supernova — a bloom showcase. A blazing core and two neon rings on a dark stage;
// the HDR bright-pass + Gaussian glare bleeds a soft halo from everything hotter
// than the threshold. Uses the raymarch shade under accumulation so it stays clean
// and animated while the glow does the work.
function supernova(): Scene {
  return base(
    [
      mk('sphere', { name: 'Core', params: [0.7, 0, 0, 0], pos: [0, 1.0, 0], color: '#ffd48a', emission: 2.4, rough: 1 }),
      mk('torus', {
        name: 'Ring',
        params: [1.5, 0.06, 0, 0],
        pos: [0, 1.0, 0],
        rot: [80, 0, 0],
        color: '#ff5da2',
        emission: 1.5,
        rough: 1,
        op: 'union',
        smooth: false,
        spin: [0, 0, 30],
      }),
      mk('torus', {
        name: 'Ring 2',
        params: [1.95, 0.05, 0, 0],
        pos: [0, 1.0, 0],
        rot: [66, 32, 0],
        color: '#5db8ff',
        emission: 1.2,
        rough: 1,
        op: 'union',
        smooth: false,
        spin: [0, 0, -24],
      }),
    ],
    {
      camera: { ...defaultCamera(), distance: 6.5, elevation: 16, target: [0, 1.0, 0], autoRotate: true, autoRotateSpeed: 6 },
      sun: { ...defaultSun(), intensity: 0 },
      env: {
        ...defaultEnv(),
        skyColor: c('#03040a'),
        horizonColor: c('#070a16'),
        groundColor: c('#03040a'),
        ambient: 0.05,
        fogDensity: 0.012,
        fogColor: c('#05060f'),
        emissive: true,
        emissiveStrength: 1.4,
      },
      ground: { ...defaultGround(), enabled: false },
      quality: { ...defaultQuality(), maxSteps: 140, reflections: true },
      post: { ...defaultPost(), exposure: 1.15, vignette: 0.5, saturation: 1.25, bloom: 0.85, bloomThreshold: 1.05, bloomRadius: 1.7 },
      render: { ...defaultRender(), integrator: 'raymarch', maxSamples: 256 },
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
  { id: 'cornell', name: 'Cornell Box', build: cornellBox },
  { id: 'radiance', name: 'Radiance', build: radiance },
  { id: 'prism', name: 'Prism', build: prism },
  { id: 'crystal', name: 'Crystal', build: crystal },
  { id: 'supernova', name: 'Supernova', build: supernova },
  { id: 'nocturne', name: 'Nocturne', build: nocturne },
  { id: 'lattice', name: 'Lattice', build: lattice },
  { id: 'orrery', name: 'Orrery', build: orrery },
  { id: 'monolith', name: 'Monolith', build: monolith },
  { id: 'bloom', name: 'Bloom', build: bloom },
  { id: 'colonnade', name: 'Colonnade', build: colonnade },
  { id: 'gyre', name: 'Gyre', build: gyre },
  { id: 'kaleido', name: 'Kaleido', build: kaleido },
  { id: 'menagerie', name: 'Menagerie', build: menagerie },
  { id: 'aperture', name: 'Aperture', build: aperture },
  { id: 'lantern', name: 'Lantern', build: lantern },
  { id: 'gearwork', name: 'Gearwork', build: gearwork },
]

export function defaultScene(): Scene {
  return genesis()
}
