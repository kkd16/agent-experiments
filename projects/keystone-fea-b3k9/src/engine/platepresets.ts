// Canonical plate-bending scenarios with their closed-form check values.
//
// Each scenario fixes the support conditions and the load pattern; the studio
// owns the geometry, thickness, material and load magnitude as live sliders.
// Where a classical (Timoshenko & Woinowsky-Krieger) solution exists we carry
// the deflection coefficient so the studio can show FE-vs-theory live — the same
// "trust the numbers" contract as the rest of Keystone.

import type { PlateBC, PlateEdges } from './platesolve'
import { flexuralRigidity, type PlateMaterial } from './plate'

export interface PlateMaterialDef extends PlateMaterial {
  id: string
  name: string
  blurb: string
}

export const PLATE_MATERIALS: PlateMaterialDef[] = [
  { id: 'steel', name: 'Structural steel', E: 200e9, nu: 0.3, rho: 7850, blurb: 'E = 200 GPa · ν = 0.30' },
  { id: 'aluminium', name: 'Aluminium 6061', E: 69e9, nu: 0.33, rho: 2700, blurb: 'E = 69 GPa · ν = 0.33' },
  { id: 'concrete', name: 'Reinforced concrete', E: 30e9, nu: 0.2, rho: 2400, blurb: 'E = 30 GPa · ν = 0.20' },
  { id: 'glass', name: 'Soda-lime glass', E: 70e9, nu: 0.22, rho: 2500, blurb: 'E = 70 GPa · ν = 0.22' },
  { id: 'silicon', name: 'Silicon die', E: 165e9, nu: 0.22, rho: 2330, blurb: 'E = 165 GPa · ν = 0.22' },
]

export type LoadKind = 'uniform' | 'point' | 'hydrostatic'

export interface PlateScenario {
  id: string
  name: string
  blurb: string
  /** aspect Ly/Lx of the plate (short span is always Lx = 1 base unit) */
  aspect: number
  edges: PlateEdges
  loadKind: LoadKind
  /** simply-supported point supports at the four corners (edges usually free) */
  cornerSupports?: boolean
  /** uniform-load central-deflection coefficient α:  w_c = α · q · a⁴ / D  (a = short span) */
  alpha?: number
  /** point-load central-deflection coefficient β:  w_c = β · P · a² / D */
  beta?: number
  /** when all edges are simply supported, the analytic fundamental (m,n) half-wave numbers */
  modal?: { m: number; n: number }
  /** short physics note shown under the validation panel */
  note: string
}

const ss = (): PlateEdges => ({ left: 'ss', right: 'ss', bottom: 'ss', top: 'ss' })
const clamped = (): PlateEdges => ({ left: 'clamped', right: 'clamped', bottom: 'clamped', top: 'clamped' })
const free = (): PlateEdges => ({ left: 'free', right: 'free', bottom: 'free', top: 'free' })
const edge = (l: PlateBC, r: PlateBC, b: PlateBC, t: PlateBC): PlateEdges => ({ left: l, right: r, bottom: b, top: t })

export const PLATE_SCENARIOS: PlateScenario[] = [
  {
    id: 'ss-square-udl',
    name: 'Simply-supported slab',
    blurb: 'Square floor slab, all edges simply supported, uniform pressure',
    aspect: 1,
    edges: ss(),
    loadKind: 'uniform',
    alpha: 0.004062,
    modal: { m: 1, n: 1 },
    note: 'Navier double-sine series: w_c = 0.004062 q a⁴/D. The FE surface reproduces it as the mesh refines.',
  },
  {
    id: 'clamped-square-udl',
    name: 'Clamped cover plate',
    blurb: 'Square plate, all edges built-in, uniform pressure (a manhole cover / vessel wall)',
    aspect: 1,
    edges: clamped(),
    loadKind: 'uniform',
    alpha: 0.00126,
    note: 'Building in the edges roughly triples the stiffness: w_c = 0.00126 q a⁴/D, about 3.2× smaller than simply supported.',
  },
  {
    id: 'ss-rect-udl',
    name: 'Rectangular panel 2:1',
    blurb: 'Two-to-one simply-supported panel, uniform pressure',
    aspect: 2,
    edges: ss(),
    loadKind: 'uniform',
    alpha: 0.01013,
    modal: { m: 1, n: 1 },
    note: 'A long panel bends almost cylindrically: w_c = 0.01013 q a⁴/D (a = short span), approaching the strip limit 0.01302.',
  },
  {
    id: 'ss-square-point',
    name: 'Point load at centre',
    blurb: 'Simply-supported square, a concentrated load at the centre',
    aspect: 1,
    edges: ss(),
    loadKind: 'point',
    beta: 0.01160,
    note: 'A concentrated load: w_c = 0.01160 P a²/D. The bending moment is theoretically singular under the point — watch the moment field spike.',
  },
  {
    id: 'clamped-square-point',
    name: 'Clamped, point load',
    blurb: 'Built-in square plate, concentrated central load',
    aspect: 1,
    edges: clamped(),
    loadKind: 'point',
    beta: 0.0056,
    note: 'Clamped edges halve the point-load deflection: w_c = 0.00560 P a²/D.',
  },
  {
    id: 'corner-supported',
    name: 'Flat slab on columns',
    blurb: 'Square slab carried on four corner columns, uniform pressure',
    aspect: 1,
    edges: free(),
    cornerSupports: true,
    loadKind: 'uniform',
    note: 'With only the corners held, the slab sags and its edges curl up — the flat-plate action behind column-grid floors. No simple closed form.',
  },
  {
    id: 'cantilever',
    name: 'Cantilever plate',
    blurb: 'One edge built-in, three edges free — a balcony / diving board, uniform load',
    aspect: 1,
    edges: edge('clamped', 'free', 'free', 'free'),
    loadKind: 'uniform',
    note: 'A plate cantilever twists as well as bends (anticlastic curvature). Switch to Modes to see its low, floppy fundamental.',
  },
  {
    id: 'tank-wall',
    name: 'Tank wall (hydrostatic)',
    blurb: 'Base built-in, sides simply supported, pressure growing with depth',
    aspect: 1,
    edges: edge('ss', 'ss', 'clamped', 'free'),
    loadKind: 'hydrostatic',
    note: 'A retaining/tank wall: the triangular hydrostatic load peaks at the clamped base and vanishes at the free top.',
  },
]

export function scenarioById(id: string): PlateScenario {
  return PLATE_SCENARIOS.find((s) => s.id === id) ?? PLATE_SCENARIOS[0]
}

export interface PlateExact {
  wCenter?: number
  f1?: number
  label: string
}

/**
 * Closed-form comparison for the current scenario/params, when one exists.
 * `q` is the uniform pressure (N/m²), `P` the point force (N).
 */
export function plateExact(
  sc: PlateScenario,
  mat: PlateMaterial,
  t: number,
  Lx: number,
  Ly: number,
  q: number,
  P: number,
): PlateExact | null {
  const D = flexuralRigidity(mat, t)
  const a = Math.min(Lx, Ly)
  if (sc.loadKind === 'uniform' && sc.alpha != null) {
    return { wCenter: (sc.alpha * q * a ** 4) / D, label: `w_c = ${sc.alpha} q a⁴/D` }
  }
  if (sc.loadKind === 'point' && sc.beta != null) {
    return { wCenter: (sc.beta * P * a * a) / D, label: `w_c = ${sc.beta} P a²/D` }
  }
  return null
}

/** Analytic fundamental frequency (Hz) for an all-simply-supported plate. */
export function plateModalExact(
  sc: PlateScenario,
  mat: PlateMaterial,
  t: number,
  Lx: number,
  Ly: number,
): number | null {
  if (!sc.modal) return null
  const D = flexuralRigidity(mat, t)
  const { m, n } = sc.modal
  const omega = Math.PI * Math.PI * ((m / Lx) ** 2 + (n / Ly) ** 2) * Math.sqrt(D / (mat.rho * t))
  return omega / (2 * Math.PI)
}
