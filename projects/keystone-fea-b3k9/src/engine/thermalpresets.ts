// The thermal scenario library — the model cases the Thermal & Multiphysics tab
// offers. Each scenario fixes the *geometry* and the *type* of boundary
// condition on every edge (which face is held hot, which convects, where heat is
// generated) and how the part is mechanically restrained for the thermal-stress
// overlay. The live slider values (κ, ρc, α, E, temperatures, film coefficient,
// generation) are injected at build time so one scenario spans a whole family of
// physical situations.

import { rectPlateQ, cantileverMeshQ, plateWithHoleQ, type QuadMesh } from './quadmesh'
import type { QOrder } from './isoparam'
import type { ThermalInput } from './thermal'
import type { MechFix } from './thermoelastic'

export interface ThermalParams {
  k: number // conductivity W/m·K
  rhoc: number // volumetric heat capacity ρc J/m³·K
  alpha: number // thermal expansion 1/K
  E: number // Young's modulus Pa
  Thot: number // hot-face / source temperature °C
  Tcold: number // cold-face / sink temperature °C
  h: number // convective film coefficient W/m²·K
  Tinf: number // ambient temperature °C
  gen: number // volumetric generation W/m³
  Tref: number // stress-free reference temperature °C
  T0: number // transient initial temperature °C
}

export interface ThermalScenario {
  id: string
  name: string
  blurb: string
  /** Characteristic length used for slider scaling / labels. */
  span: number
  build: (
    order: QOrder,
    density: number,
    p: ThermalParams,
  ) => { input: ThermalInput; teFix: MechFix[] }
}

const grid = (density: number, base: number) => Math.max(4, Math.round(base * density))

function meshWall(order: QOrder, density: number): QuadMesh {
  return rectPlateQ(order, 0.2, 0.2, grid(density, 20), grid(density, 20))
}

export const THERMAL_SCENARIOS: ThermalScenario[] = [
  {
    id: 'cooling-wall',
    name: 'Cooling wall',
    blurb: 'A slab held hot on the left face, cold on the right; the classic linear conduction gradient. Restrained on the hot face, it bows and stresses.',
    span: 0.2,
    build: (order, density, p) => {
      const mesh = meshWall(order, density)
      const input: ThermalInput = {
        mesh,
        k: p.k,
        rhoc: p.rhoc,
        thickness: 0.02,
        bcs: {
          left: { kind: 'temp', value: p.Thot },
          right: { kind: 'temp', value: p.Tcold },
          top: { kind: 'insulated' },
          bottom: { kind: 'insulated' },
        },
        T0: p.T0,
      }
      return { input, teFix: [{ edge: 'left', dofs: ['x', 'y'] }] }
    },
  },
  {
    id: 'chip-sink',
    name: 'Heat-generating chip',
    blurb: 'A power device dumping heat into a board: a central generation patch, the bottom edge clamped to a cold heat sink, the rest convecting to still air.',
    span: 0.2,
    build: (order, density, p) => {
      const W = 0.2
      const H = 0.12
      const mesh = rectPlateQ(order, W, H, grid(density, 24), grid(density, 14))
      const input: ThermalInput = {
        mesh,
        k: p.k,
        rhoc: p.rhoc,
        thickness: 0.01,
        gen: {
          q: p.gen,
          region: (x, y) => x > 0.35 * W && x < 0.65 * W && y > 0.55 * H,
        },
        bcs: {
          bottom: { kind: 'temp', value: p.Tcold },
          top: { kind: 'convection', h: p.h, Tinf: p.Tinf },
          left: { kind: 'convection', h: p.h, Tinf: p.Tinf },
          right: { kind: 'convection', h: p.h, Tinf: p.Tinf },
        },
        T0: p.Tinf,
      }
      return { input, teFix: [{ edge: 'bottom', dofs: ['x', 'y'] }] }
    },
  },
  {
    id: 'gen-bar',
    name: 'Bar with internal heat',
    blurb: 'A conductor carrying current: uniform volumetric generation, both ends held cold. The temperature bows into the exact parabola T_max = q‴L²/8κ. Ends pinned in x → compressive thermal stress.',
    span: 0.4,
    build: (order, density, p) => {
      const L = 0.4
      const h = 0.05
      const mesh = cantileverMeshQ(order, L, h, grid(density, 40), grid(density, 6))
      const input: ThermalInput = {
        mesh,
        k: p.k,
        rhoc: p.rhoc,
        thickness: 0.02,
        gen: { q: p.gen },
        bcs: {
          left: { kind: 'temp', value: p.Tcold },
          right: { kind: 'temp', value: p.Tcold },
          top: { kind: 'insulated' },
          bottom: { kind: 'insulated' },
        },
        T0: p.Tcold,
      }
      return {
        input,
        teFix: [
          { edge: 'left', dofs: ['x'] },
          { edge: 'right', dofs: ['x'] },
          { nodes: [0], dofs: ['y'] },
        ],
      }
    },
  },
  {
    id: 'convective-fin',
    name: 'Convective fin',
    blurb: 'A cooling fin rooted in a hot base (left), shedding heat to air along its length and tip. Temperature decays from base to tip; the hot root is restrained.',
    span: 0.3,
    build: (order, density, p) => {
      const L = 0.3
      const h = 0.04
      const mesh = cantileverMeshQ(order, L, h, grid(density, 36), grid(density, 6))
      const input: ThermalInput = {
        mesh,
        k: p.k,
        rhoc: p.rhoc,
        thickness: 0.01,
        bcs: {
          left: { kind: 'temp', value: p.Thot },
          right: { kind: 'convection', h: p.h, Tinf: p.Tinf },
          top: { kind: 'convection', h: p.h, Tinf: p.Tinf },
          bottom: { kind: 'convection', h: p.h, Tinf: p.Tinf },
        },
        T0: p.Tinf,
      }
      return { input, teFix: [{ edge: 'left', dofs: ['x', 'y'] }] }
    },
  },
  {
    id: 'heated-hole',
    name: 'Heated plate with hole',
    blurb: 'A thermal gradient across a perforated plate: hot left, cold right, both faces held straight in x. The thwarted expansion concentrates von Mises stress around the hole.',
    span: 0.2,
    build: (order, density, p) => {
      const W = 0.2
      const H = 0.2
      const mesh = plateWithHoleQ(order, W, H, 0.045, grid(density, 22), grid(density, 22))
      const input: ThermalInput = {
        mesh,
        k: p.k,
        rhoc: p.rhoc,
        thickness: 0.01,
        bcs: {
          left: { kind: 'temp', value: p.Thot },
          right: { kind: 'temp', value: p.Tcold },
          top: { kind: 'insulated' },
          bottom: { kind: 'insulated' },
        },
        T0: p.Tcold,
      }
      return {
        input,
        teFix: [
          { edge: 'left', dofs: ['x', 'y'] },
          { edge: 'right', dofs: ['x'] },
        ],
      }
    },
  },
]

export function thermalScenarioById(id: string): ThermalScenario {
  return THERMAL_SCENARIOS.find((s) => s.id === id) ?? THERMAL_SCENARIOS[0]
}
