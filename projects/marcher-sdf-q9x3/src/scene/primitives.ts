// Primitive catalogue: the parameter schema for each SDF primitive plus factory
// helpers for building fresh nodes. Codegen and the inspector both read this so
// there is a single source of truth for "what knobs does a sphere have".

import type {
  Anim,
  BooleanOp,
  Material,
  Modifier,
  PrimitiveKind,
  PrimitiveSpec,
  SdfNode,
  Transform,
} from './types'

export const PRIMITIVES: Record<PrimitiveKind, PrimitiveSpec> = {
  sphere: {
    kind: 'sphere',
    label: 'Sphere',
    defaults: [0.8, 0, 0, 0],
    params: [{ key: 'radius', label: 'Radius', min: 0.05, max: 3, step: 0.01, slot: 0 }],
  },
  box: {
    kind: 'box',
    label: 'Box',
    defaults: [0.7, 0.7, 0.7, 0],
    params: [
      { key: 'sx', label: 'Width', min: 0.05, max: 3, step: 0.01, slot: 0 },
      { key: 'sy', label: 'Height', min: 0.05, max: 3, step: 0.01, slot: 1 },
      { key: 'sz', label: 'Depth', min: 0.05, max: 3, step: 0.01, slot: 2 },
    ],
  },
  roundBox: {
    kind: 'roundBox',
    label: 'Round Box',
    defaults: [0.6, 0.6, 0.6, 0.15],
    params: [
      { key: 'sx', label: 'Width', min: 0.05, max: 3, step: 0.01, slot: 0 },
      { key: 'sy', label: 'Height', min: 0.05, max: 3, step: 0.01, slot: 1 },
      { key: 'sz', label: 'Depth', min: 0.05, max: 3, step: 0.01, slot: 2 },
      { key: 'r', label: 'Radius', min: 0.01, max: 1, step: 0.01, slot: 3 },
    ],
  },
  torus: {
    kind: 'torus',
    label: 'Torus',
    defaults: [0.7, 0.25, 0, 0],
    params: [
      { key: 'major', label: 'Major R', min: 0.1, max: 3, step: 0.01, slot: 0 },
      { key: 'minor', label: 'Minor R', min: 0.02, max: 1, step: 0.01, slot: 1 },
    ],
  },
  capsule: {
    kind: 'capsule',
    label: 'Capsule',
    defaults: [0.8, 0.3, 0, 0],
    params: [
      { key: 'height', label: 'Height', min: 0.1, max: 3, step: 0.01, slot: 0 },
      { key: 'radius', label: 'Radius', min: 0.05, max: 1.5, step: 0.01, slot: 1 },
    ],
  },
  cylinder: {
    kind: 'cylinder',
    label: 'Cylinder',
    defaults: [0.5, 0.8, 0, 0],
    params: [
      { key: 'radius', label: 'Radius', min: 0.05, max: 2, step: 0.01, slot: 0 },
      { key: 'height', label: 'Half Height', min: 0.05, max: 3, step: 0.01, slot: 1 },
    ],
  },
  cone: {
    kind: 'cone',
    label: 'Cone',
    defaults: [0.7, 1.1, 0, 0],
    params: [
      { key: 'radius', label: 'Base R', min: 0.05, max: 2, step: 0.01, slot: 0 },
      { key: 'height', label: 'Height', min: 0.1, max: 3, step: 0.01, slot: 1 },
    ],
  },
  octahedron: {
    kind: 'octahedron',
    label: 'Octahedron',
    defaults: [0.9, 0, 0, 0],
    params: [{ key: 'size', label: 'Size', min: 0.1, max: 3, step: 0.01, slot: 0 }],
  },
  plane: {
    kind: 'plane',
    label: 'Plane',
    defaults: [0, 0, 0, 0],
    params: [],
  },
  ellipsoid: {
    kind: 'ellipsoid',
    label: 'Ellipsoid',
    defaults: [0.7, 0.95, 0.55, 0],
    params: [
      { key: 'rx', label: 'Radius X', min: 0.05, max: 3, step: 0.01, slot: 0 },
      { key: 'ry', label: 'Radius Y', min: 0.05, max: 3, step: 0.01, slot: 1 },
      { key: 'rz', label: 'Radius Z', min: 0.05, max: 3, step: 0.01, slot: 2 },
    ],
  },
  hexPrism: {
    kind: 'hexPrism',
    label: 'Hex Prism',
    defaults: [0.7, 0.5, 0, 0],
    params: [
      { key: 'radius', label: 'Radius', min: 0.05, max: 2, step: 0.01, slot: 0 },
      { key: 'height', label: 'Half Depth', min: 0.05, max: 3, step: 0.01, slot: 1 },
    ],
  },
  pyramid: {
    kind: 'pyramid',
    label: 'Pyramid',
    defaults: [1.3, 0, 0, 0],
    params: [{ key: 'height', label: 'Height', min: 0.2, max: 4, step: 0.01, slot: 0 }],
  },
  link: {
    kind: 'link',
    label: 'Link',
    defaults: [0.35, 0.5, 0.18, 0],
    params: [
      { key: 'len', label: 'Length', min: 0, max: 1.5, step: 0.01, slot: 0 },
      { key: 'r1', label: 'Ring R', min: 0.1, max: 2, step: 0.01, slot: 1 },
      { key: 'r2', label: 'Tube R', min: 0.02, max: 0.6, step: 0.01, slot: 2 },
    ],
  },
  roundCone: {
    kind: 'roundCone',
    label: 'Round Cone',
    defaults: [0.6, 0.22, 1.2, 0],
    params: [
      { key: 'r1', label: 'Base R', min: 0.05, max: 2, step: 0.01, slot: 0 },
      { key: 'r2', label: 'Top R', min: 0.02, max: 2, step: 0.01, slot: 1 },
      { key: 'h', label: 'Height', min: 0.1, max: 3, step: 0.01, slot: 2 },
    ],
  },
}

export const PRIMITIVE_LIST: PrimitiveKind[] = [
  'sphere',
  'box',
  'roundBox',
  'torus',
  'capsule',
  'cylinder',
  'cone',
  'octahedron',
  'ellipsoid',
  'hexPrism',
  'pyramid',
  'link',
  'roundCone',
  'plane',
]

export const OP_LIST: BooleanOp[] = ['union', 'subtract', 'intersect']

export const OP_LABELS: Record<BooleanOp, string> = {
  union: 'Union',
  subtract: 'Subtract',
  intersect: 'Intersect',
}

// A clean, deterministic accent palette used to colour freshly-added nodes.
export const NODE_COLORS: string[] = [
  '#e0524a',
  '#f0a43a',
  '#f4d35e',
  '#8bd450',
  '#43c6ac',
  '#4a9fe0',
  '#7a6ff0',
  '#d36fb3',
]

let counter = 0
export function uid(prefix = 'n'): string {
  counter += 1
  return `${prefix}${counter.toString(36)}${(counter * 2654435761 % 100000).toString(36)}`
}

export function defaultTransform(): Transform {
  return { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 }
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

export function defaultMaterial(index = 0): Material {
  return {
    color: hexToRgb(NODE_COLORS[index % NODE_COLORS.length]),
    metallic: 0.0,
    roughness: 0.4,
    reflectivity: 0.1,
    emission: 0.0,
    transmission: 0.0,
    ior: 1.5,
    absorption: 0.0,
    dispersion: 0.0,
    texture: 'none',
    texScale: 3,
    texStrength: 0.6,
  }
}

export function defaultModifier(): Modifier {
  return {
    domain: 'none',
    repeat: [2, 0, 2],
    repeatLimit: 0,
    mirror: [0, 0, 0],
    twist: 1.2,
    bend: 0.4,
    elongate: [0.4, 0, 0],
    polar: 6,
    round: 0,
    shellOn: false,
    shell: 0.06,
  }
}

export function defaultAnim(): Anim {
  return {
    enabled: false,
    posAmp: [0, 0.4, 0],
    posSpeed: [1, 1, 1],
    spin: [0, 45, 0],
    scalePulse: 0,
    scaleSpeed: 1,
  }
}

export function makeNode(kind: PrimitiveKind, index = 0): SdfNode {
  const spec = PRIMITIVES[kind]
  return {
    id: uid(),
    name: spec.label,
    visible: true,
    kind,
    params: [...spec.defaults],
    transform: defaultTransform(),
    material: defaultMaterial(index),
    combine: { op: 'union', smooth: true, radius: 0.3 },
    modifier: defaultModifier(),
    anim: defaultAnim(),
  }
}

/** Ordered list of domain modifiers for the modifier picker. */
export const DOMAIN_LABELS: Record<Modifier['domain'], string> = {
  none: 'None',
  repeat: 'Repeat',
  mirror: 'Mirror',
  twist: 'Twist',
  bend: 'Bend',
  elongate: 'Elongate',
  polar: 'Polar',
}

export const DOMAIN_LIST: Array<Modifier['domain']> = [
  'none',
  'repeat',
  'mirror',
  'twist',
  'bend',
  'elongate',
  'polar',
]

export const TEXTURE_LABELS: Record<Material['texture'], string> = {
  none: 'None',
  checker: 'Checker',
  noise: 'Noise',
  marble: 'Marble',
  wood: 'Wood',
  grid: 'Grid',
}

export const TEXTURE_LIST: Array<Material['texture']> = [
  'none',
  'checker',
  'noise',
  'marble',
  'wood',
  'grid',
]

/** Stable numeric index for a texture kind (matches the GLSL switch in the shader). */
export const TEXTURE_INDEX: Record<Material['texture'], number> = {
  none: 0,
  checker: 1,
  noise: 2,
  marble: 3,
  wood: 4,
  grid: 5,
}
