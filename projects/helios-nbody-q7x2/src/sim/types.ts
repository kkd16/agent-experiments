// Shared simulation types.

export type IntegratorId =
  | 'symplectic-euler'
  | 'velocity-verlet'
  | 'leapfrog'
  | 'yoshida4'
  | 'rk4'
  | 'euler'

export interface IntegratorInfo {
  id: IntegratorId
  label: string
  /** Force evaluations per step — the dominant cost. */
  evals: number
  /** Whether the scheme conserves energy over long runs (symplectic). */
  symplectic: boolean
  blurb: string
}

export const INTEGRATORS: IntegratorInfo[] = [
  {
    id: 'velocity-verlet',
    label: 'Velocity Verlet',
    evals: 1,
    symplectic: true,
    blurb: 'Second-order symplectic. The default — excellent energy behaviour at one force eval per step.',
  },
  {
    id: 'leapfrog',
    label: 'Leapfrog (KDK)',
    evals: 1,
    symplectic: true,
    blurb: 'Kick–drift–kick. Algebraically identical to velocity Verlet; the classic choice for gravity.',
  },
  {
    id: 'symplectic-euler',
    label: 'Symplectic Euler',
    evals: 1,
    symplectic: true,
    blurb: 'First-order symplectic. Cheap and stable, but phase error accumulates faster.',
  },
  {
    id: 'yoshida4',
    label: 'Yoshida 4 (symplectic)',
    evals: 3,
    symplectic: true,
    blurb:
      'Fourth-order AND symplectic — a symmetric triple-jump of leapfrog substeps. Holds energy flat at a far larger Δt than Verlet, for three force evals.',
  },
  {
    id: 'rk4',
    label: 'Runge–Kutta 4',
    evals: 4,
    symplectic: false,
    blurb: 'Fourth-order accurate per step but NOT symplectic — energy slowly drifts. Four force evals.',
  },
  {
    id: 'euler',
    label: 'Explicit Euler',
    evals: 1,
    symplectic: false,
    blurb: 'First-order, non-symplectic. Included to show how quickly a bad integrator gains energy.',
  },
]

export interface SimParams {
  g: number // gravitational constant
  theta: number // Barnes–Hut opening angle
  softening: number // softening length ε (not squared)
  dt: number // timestep
  integrator: IntegratorId
  collide: boolean // inelastic merging of bodies on contact
  collisionScale: number // capture-radius scale: R = collisionScale · mass^(1/3)
}

export interface Diagnostics {
  kinetic: number
  potential: number
  total: number
  /** Fractional drift of total energy from the initial value. */
  energyDrift: number
  momentumX: number
  momentumY: number
  angularMomentum: number
  /** Centre-of-mass position, used by the camera "follow" mode. */
  comX: number
  comY: number
}
