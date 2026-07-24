// Buckling scenario library: prismatic columns with a range of textbook end
// conditions plus a compression panel, each expressed as a mesh + boundary /
// load recipe for the continuum buckling solver, together with the closed-form
// Euler reference (effective-length factor, second moment, radius of gyration)
// so the studio can plot the FE critical load against the analytical column.

import { rectPlateQ, type QuadMesh } from './quadmesh'
import { eulerLoad, type BucklingInput } from './buckling'
import type { QOrder } from './isoparam'

export interface BMaterial {
  id: string
  name: string
  E: number // Pa
  nu: number
  rho: number // kg/m³
  sigmaY: number // Pa (yield / squash stress)
}

export const BUCKLING_MATERIALS: BMaterial[] = [
  { id: 'steel', name: 'Structural steel', E: 210e9, nu: 0.3, rho: 7850, sigmaY: 250e6 },
  { id: 'aluminium', name: 'Aluminium 6061', E: 69e9, nu: 0.33, rho: 2700, sigmaY: 240e6 },
  { id: 'titanium', name: 'Titanium Ti-6Al-4V', E: 116e9, nu: 0.32, rho: 4500, sigmaY: 830e6 },
]

export function bucklingMaterialById(id: string): BMaterial {
  return BUCKLING_MATERIALS.find((m) => m.id === id) ?? BUCKLING_MATERIALS[0]
}

export interface BucklingScenario {
  id: string
  name: string
  blurb: string
  /** Textbook end-condition label. */
  ends: string
  /**
   * Effective-length factor K for the Euler reference P_cr = π²EI/(KL)².
   * `null` for cases (panels) without a 1-D Euler analogue.
   */
  kEff: number | null
  /** Aspect the studio uses to pick a sensible default slenderness. */
  kind: 'column' | 'panel'
}

export const BUCKLING_SCENARIOS: BucklingScenario[] = [
  {
    id: 'cantilever',
    name: 'Flagpole column',
    blurb: 'Fixed base, free tip under axial compression — the fixed–free cantilever (K = 2).',
    ends: 'fixed–free',
    kEff: 2.0,
    kind: 'column',
  },
  {
    id: 'fixed-pinned',
    name: 'Braced column',
    blurb: 'Clamped base, laterally-braced top under compression — the fixed–pinned strut (K ≈ 0.699).',
    ends: 'fixed–pinned',
    kEff: 0.6992,
    kind: 'column',
  },
  {
    id: 'panel',
    name: 'Compression panel',
    blurb: 'A wide plate clamped along its loaded edges — buckles into a lateral bulge, not a 1-D column.',
    ends: 'plate',
    kEff: null,
    kind: 'panel',
  },
]

export function bucklingScenarioById(id: string): BucklingScenario {
  return BUCKLING_SCENARIOS.find((s) => s.id === id) ?? BUCKLING_SCENARIOS[0]
}

export interface BucklingParams {
  scenarioId: string
  materialId: string
  /** Slenderness handle — column length as a multiple of its width b. */
  aspect: number
  order: QOrder
  nModes: number
}

export const BUCKLING_DEFAULTS: BucklingParams = {
  scenarioId: 'cantilever',
  materialId: 'steel',
  aspect: 45,
  order: 8,
  nModes: 3,
}

/** Section width b (in-plane) and out-of-plane thickness t are fixed handles. */
const SECTION_B = 0.02 // m
const SECTION_T = 0.01 // m
/** Reference compressive traction magnitude (unit stress), so λ reads directly. */
const REF_TRACTION = 1

export interface BucklingGeometry {
  L: number
  b: number
  t: number
  area: number
  I: number
  radiusGyration: number
  E: number
  nu: number
  kEff: number | null
  /** Euler critical load for the ideal column (N), null for panels. */
  eulerLoad: number | null
  /** Reference axial load actually applied (N) — λ × this = the buckling load. */
  refLoad: number
  slenderness: number | null
}

export interface BuiltBuckling {
  input: BucklingInput
  geom: BucklingGeometry
  mesh: QuadMesh
}

/** Column meshes are tall (axis = +y); panels are wide. Density tracks aspect. */
function meshFor(scenario: BucklingScenario, order: QOrder, aspect: number) {
  const b = SECTION_B
  if (scenario.kind === 'panel') {
    const W = b * 6
    const H = b * 4
    // Panels have clustered eigenvalues; keep the mesh coarse so the subspace
    // solve stays interactive.
    return { mesh: rectPlateQ(order, W, H, order === 8 ? 10 : 18, order === 8 ? 6 : 12), L: H, width: W }
  }
  const L = b * aspect
  // Two elements across the width resolve the bending mode with Q8 (which does
  // not shear-lock); a slender column needs several along its length. Q8 stays
  // accurate to <0.3% with far fewer elements than Q4, so it can be much
  // coarser — which keeps the eigenproblem interactive.
  const ny = order === 8 ? Math.min(30, Math.max(16, Math.round(aspect * 0.6))) : Math.min(56, Math.max(28, aspect))
  const nx = order === 8 ? 2 : 6
  return { mesh: rectPlateQ(order, b, L, nx, ny), L, width: b }
}

export function buildBuckling(params: BucklingParams): BuiltBuckling {
  const scenario = bucklingScenarioById(params.scenarioId)
  const mat = bucklingMaterialById(params.materialId)
  const { mesh, L, width } = meshFor(scenario, params.order, params.aspect)
  const t = SECTION_T

  const fix: BucklingInput['fix'] = []
  if (scenario.id === 'cantilever') {
    fix.push({ edge: 'bottom', dofs: ['x', 'y'] })
  } else if (scenario.id === 'fixed-pinned') {
    fix.push({ edge: 'bottom', dofs: ['x', 'y'] })
    fix.push({ edge: 'top', dofs: ['x'] }) // lateral brace → pin at the loaded end
  } else {
    // panel: clamp the bottom loaded edge, brace the top loaded edge laterally.
    fix.push({ edge: 'bottom', dofs: ['x', 'y'] })
    fix.push({ edge: 'top', dofs: ['x'] })
  }

  const input: BucklingInput = {
    mesh,
    E: mat.E,
    nu: mat.nu,
    thickness: t,
    fix,
    traction: { edge: 'top', tx: 0, ty: -REF_TRACTION },
    nModes: params.nModes,
  }

  // Section properties for in-plane (about-z) bending of a b×t rectangle.
  const b = width
  const area = b * t
  const I = (t * b * b * b) / 12
  const radiusGyration = Math.sqrt(I / area)
  const refLoad = REF_TRACTION * b * t // |traction| × loaded-edge area
  const kEff = scenario.kEff
  const euler = kEff != null ? eulerLoad(mat.E, I, L, kEff) : null
  const slenderness = kEff != null ? (kEff * L) / radiusGyration : null

  return {
    input,
    mesh,
    geom: {
      L,
      b,
      t,
      area,
      I,
      radiusGyration,
      E: mat.E,
      nu: mat.nu,
      kEff,
      eulerLoad: euler,
      refLoad,
      slenderness,
    },
  }
}
