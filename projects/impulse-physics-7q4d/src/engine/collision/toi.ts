import { Body } from '../body';
import { boundingRadius, shapeRadius } from '../shapes';
import { gjkDistance } from './gjk';

export interface TOIResult {
  /** True when the two sweeps reach contact within the step. */
  hit: boolean;
  /** Sweep fraction of first contact in [0,1]. */
  t: number;
}

const MISS: TOIResult = { hit: false, t: 1 };

/**
 * Conservative-advancement time of impact between the swept poses of two bodies
 * over a single step. Each iteration measures the exact core distance with GJK,
 * then advances the sweep fraction by the most it can without the surfaces
 * possibly touching — using a rotation-aware bound on the closing speed. This
 * never skips past first contact, so a fast/thin body cannot tunnel.
 *
 * Returns the earliest fraction `t` at which the skins (cores + radii) reach
 * `tolerance` of touching, or a miss if they stay apart for the whole step.
 */
export function timeOfImpact(a: Body, b: Body, tolerance = 0.005): TOIResult {
  const total = shapeRadius(a.shape) + shapeRadius(b.shape);
  // Target *core* distance at first contact (skins just touching).
  const targetCore = total;

  // Upper bound on how far the two bodies' surfaces can close over the step:
  // relative linear travel plus each body's rotational arc at its outermost point.
  const dispA = a.worldCenter.sub(a.center0);
  const dispB = b.worldCenter.sub(b.center0);
  const dAngleA = Math.abs(a.angle - a.angle0);
  const dAngleB = Math.abs(b.angle - b.angle0);
  const rMaxA = boundingRadius(a.shape) + a.localCenter.length();
  const rMaxB = boundingRadius(b.shape) + b.localCenter.length();
  const maxClose = dispB.sub(dispA).length() + dAngleA * rMaxA + dAngleB * rMaxB;
  if (maxClose < tolerance) return MISS; // negligible relative motion

  let t = 0;
  for (let iter = 0; iter < 30; iter++) {
    const xfA = a.sweepTransform(t);
    const xfB = b.sweepTransform(t);
    const core = gjkDistance(a.shape, xfA, b.shape, xfB, 32, /* core */ true).distance;
    if (core <= targetCore + tolerance) {
      return { hit: true, t };
    }
    // Conservative advance: the core distance can shrink by at most `maxClose`
    // across the whole step, so this fraction cannot overshoot first contact.
    const advance = (core - targetCore) / maxClose;
    t += advance;
    if (t >= 1) return MISS;
  }
  // Ran out of iterations very close to contact — treat the current t as impact.
  return { hit: true, t };
}
