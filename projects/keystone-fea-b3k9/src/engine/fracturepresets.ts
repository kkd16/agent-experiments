// Fracture scenario + material library for the LEFM studio.
//
// A scenario fixes the crack topology (center / edge / double-edge) and a
// starting crack-length ratio; the material supplies E, ν and a fracture
// toughness K_Ic so the studio can turn a computed K_I into an engineering
// verdict — the critical stress a given flaw can carry, and the critical flaw
// size at a given stress (K_I = K_Ic is the Griffith failure criterion).

import type { CrackKind, CrackModel } from './fracture'

export interface FractureScenario {
  id: string
  name: string
  blurb: string
  kind: CrackKind
  /** Starting crack ratio a/W. */
  alpha: number
}

export const FRACTURE_SCENARIOS: FractureScenario[] = [
  {
    id: 'center',
    name: 'Center crack (Griffith)',
    blurb: 'A through-crack of length 2a in a wide plate under remote tension — the archetypal problem. K_I → σ√(πa) as the plate grows large.',
    kind: 'center',
    alpha: 0.3,
  },
  {
    id: 'edge',
    name: 'Single edge crack (SENT)',
    blurb: 'A crack growing in from one free surface. The free edge amplifies K by the famous 1.12 factor as a/W → 0.',
    kind: 'edge',
    alpha: 0.3,
  },
  {
    id: 'double-edge',
    name: 'Double edge crack (DENT)',
    blurb: 'Symmetric cracks from both surfaces. Modeled as the reflected quarter of the specimen; the centre plane is a symmetry line.',
    kind: 'double-edge',
    alpha: 0.3,
  },
]

export function fractureScenarioById(id: string): FractureScenario {
  return FRACTURE_SCENARIOS.find((s) => s.id === id) ?? FRACTURE_SCENARIOS[0]
}

export interface FractureMaterial {
  id: string
  name: string
  E: number // Pa
  nu: number
  KIc: number // Pa·√m — plane-strain fracture toughness
  sigmaY: number // Pa — yield strength (for the LEFM small-scale-yielding check)
}

// Representative handbook values (order-of-magnitude, for teaching).
export const FRACTURE_MATERIALS: FractureMaterial[] = [
  { id: 'steel', name: 'Structural steel', E: 210e9, nu: 0.3, KIc: 50e6, sigmaY: 350e6 },
  { id: 'al', name: 'Aluminium 7075-T6', E: 71e9, nu: 0.33, KIc: 24e6, sigmaY: 500e6 },
  { id: 'ti', name: 'Titanium Ti-6Al-4V', E: 114e9, nu: 0.34, KIc: 75e6, sigmaY: 880e6 },
  { id: 'pmma', name: 'PMMA (acrylic)', E: 3.0e9, nu: 0.35, KIc: 1.2e6, sigmaY: 70e6 },
  { id: 'alumina', name: 'Alumina (ceramic)', E: 370e9, nu: 0.22, KIc: 4e6, sigmaY: 300e6 },
  { id: 'glass', name: 'Soda-lime glass', E: 70e9, nu: 0.22, KIc: 0.75e6, sigmaY: 50e6 },
]

export function fractureMaterialById(id: string): FractureMaterial {
  return FRACTURE_MATERIALS.find((m) => m.id === id) ?? FRACTURE_MATERIALS[0]
}

export interface FractureParams {
  scenarioId: string
  materialId: string
  alpha: number // a/W
  sigma: number // remote stress (Pa)
  order: 4 | 8
  refine: number
}

export const FRACTURE_DEFAULTS: FractureParams = {
  scenarioId: 'center',
  materialId: 'steel',
  alpha: 0.3,
  sigma: 100e6,
  order: 8,
  refine: 1,
}

/** Assemble a CrackModel from the studio parameters. W is normalised to 1 m. */
export function buildModel(p: FractureParams): CrackModel {
  const scenario = fractureScenarioById(p.scenarioId)
  const mat = fractureMaterialById(p.materialId)
  const W = 1
  return {
    kind: scenario.kind,
    a: p.alpha * W,
    W,
    H: 2 * W, // tall enough that the handbook (long-strip) factors apply well
    sigma: p.sigma,
    E: mat.E,
    nu: mat.nu,
    thickness: 1,
    order: p.order,
    refine: p.refine,
  }
}
