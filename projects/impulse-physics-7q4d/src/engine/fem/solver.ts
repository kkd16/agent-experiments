import { Body } from '../body';
import { Vec2 } from '../math';
import { FemBody } from './fembody';

/** Tunables for the FEM subsystem's per-step linear solve. */
export interface FemConfig {
  /** Max conjugate-gradient iterations per body per step. */
  cgIterations: number;
  /** Relative residual tolerance to stop CG early. */
  cgTolerance: number;
}

export const DEFAULT_FEM_CONFIG: FemConfig = {
  cgIterations: 80,
  cgTolerance: 1e-7,
};

/**
 * Advance every finite-element body by one rigid timestep `dt`. Each body runs its
 * own implicit backward-Euler step against the freshly-integrated rigid poses and
 * feeds reaction impulses back into the rigid world — the same one-step
 * co-simulation coupling the soft bodies use, so FEM solids, XPBD soft bodies and
 * SPH fluid can all share a scene.
 */
export function stepFemBodies(
  fem: FemBody[],
  bodies: Body[],
  gravity: Vec2,
  dt: number,
  config: FemConfig = DEFAULT_FEM_CONFIG,
): void {
  if (fem.length === 0 || dt <= 0) return;
  for (const fb of fem) fb.step(bodies, gravity, dt, config.cgIterations, config.cgTolerance);
}
