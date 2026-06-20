import { Body } from '../body';
import { clamp, EPSILON, Vec2 } from '../math';
import { Particle, SoftBody } from './softbody';

/** Tunables for the soft-body substep loop. */
export interface SoftConfig {
  /** XPBD substeps per rigid step. More ⇒ stiffer, more stable, costlier. */
  substeps: number;
  /** Position-solve iterations per substep (constraints + collisions). */
  iterations: number;
  /** Resolve collisions *between* distinct soft bodies (jelly piling up). */
  interCollision: boolean;
  /** Restitution used for soft–soft contacts. */
  softRestitution: number;
}

export const DEFAULT_SOFT_CONFIG: SoftConfig = {
  substeps: 8,
  iterations: 4,
  interCollision: true,
  softRestitution: 0.0,
};

/**
 * Advance every soft body by one rigid timestep `dt`, split into
 * `config.substeps` XPBD substeps. The classic "small steps" scheme (Macklin et
 * al. 2019): many cheap substeps with a single constraint iteration beats a few
 * substeps with many iterations, for both stability and stiffness.
 *
 * Each substep runs the four PBD phases — integrate, project constraints, derive
 * velocity, collide — and resolves inter-body particle contacts so independent
 * soft bodies stack instead of merging. The rigid bodies are treated as fixed
 * colliders within a step (their poses were just integrated) and receive the
 * reaction impulses, which take effect on the following step: a standard, stable
 * one-step co-simulation coupling.
 */
export function stepSoftBodies(
  soft: SoftBody[],
  bodies: Body[],
  gravity: Vec2,
  dt: number,
  config: SoftConfig = DEFAULT_SOFT_CONFIG,
): void {
  if (soft.length === 0 || dt <= 0) return;
  const substeps = Math.max(1, config.substeps | 0);
  const iterations = Math.max(1, config.iterations | 0);
  const h = dt / substeps;

  for (let s = 0; s < substeps; s++) {
    for (const sb of soft) {
      sb.integrate(h, gravity);
      sb.resetLambdas();
    }
    // The rigid colliders don't move within a step, so each soft body's
    // candidate set is stable across the substep's iterations — gather it once.
    const candidates = soft.map((sb) => {
      const region = sb.aabb(0.1);
      return bodies.filter((b) => b.worldAABB().overlaps(region));
    });

    const inter = config.interCollision && soft.length > 1;

    // Iterated position solve: internal constraints, then collision depenetration
    // (interleaved so contact load propagates through the constraint network).
    // Keeping depenetration in the *position* solve — never as a velocity bias —
    // is what stops persistent overlaps (a packed tank of jelly) from pumping
    // energy: position corrections add no kinetic energy.
    for (let it = 0; it < iterations; it++) {
      for (const sb of soft) sb.projectConstraints(h);
      for (let i = 0; i < soft.length; i++) soft[i].collideBodiesPosition(candidates[i]);
      if (inter) solveInterPositions(soft);
    }

    for (const sb of soft) sb.updateVelocities(h);

    // Velocity pass: pure restitution + friction momentum exchange (no bias).
    if (inter) solveInterVelocities(soft, config.softRestitution);
    for (let i = 0; i < soft.length; i++) soft[i].resolveContactVelocities(candidates[i]);
  }
}

interface Tagged {
  p: Particle;
  body: number;
  idx: number;
}

/**
 * Build a uniform spatial hash over every soft particle and visit each
 * cross-body pair once (intra-body pairs are skipped — their spacing is the
 * constraints' job). `cb` receives the two particles of each candidate pair.
 */
function eachInterPair(soft: SoftBody[], cb: (a: Particle, b: Particle) => void): void {
  let maxR = 0;
  const all: Tagged[] = [];
  for (let b = 0; b < soft.length; b++) {
    for (const p of soft[b].particles) {
      all.push({ p, body: b, idx: all.length });
      if (p.radius > maxR) maxR = p.radius;
    }
  }
  if (all.length === 0) return;

  const inv = 1 / Math.max(2 * maxR, 1e-3);
  const grid = new Map<number, Tagged[]>();
  const key = (cx: number, cy: number): number => cx * 73856093 + cy * 19349663;
  for (const t of all) {
    const k = key(Math.floor(t.p.pos.x * inv), Math.floor(t.p.pos.y * inv));
    const bucket = grid.get(k);
    if (bucket) bucket.push(t);
    else grid.set(k, [t]);
  }

  for (const t of all) {
    const cx = Math.floor(t.p.pos.x * inv);
    const cy = Math.floor(t.p.pos.y * inv);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = grid.get(key(cx + dx, cy + dy));
        if (!bucket) continue;
        for (const o of bucket) {
          if (o.idx <= t.idx || o.body === t.body) continue;
          cb(t.p, o.p);
        }
      }
    }
  }
}

/**
 * Position pass: push overlapping cross-body particles apart, split by inverse
 * mass and clamped per iteration. So two jellies stack instead of merging —
 * resolved in position space, adding no spurious energy.
 */
function solveInterPositions(soft: SoftBody[]): void {
  const maxCorr = 0.2;
  eachInterPair(soft, (a, b) => {
    const w = a.invMass + b.invMass;
    if (w === 0) return;
    const d = b.pos.sub(a.pos);
    const len = d.length();
    const minDist = a.radius + b.radius;
    if (len >= minDist || len < EPSILON) return;
    const n = d.mul(1 / len);
    const corr = Math.min(minDist - len, maxCorr);
    a.pos = a.pos.sub(n.mul((corr * a.invMass) / w));
    b.pos = b.pos.add(n.mul((corr * b.invMass) / w));
  });
}

/**
 * Velocity pass: a symmetric (momentum-conserving) restitution + friction
 * impulse for each overlapping cross-body pair. No positional bias — overlap is
 * the position pass's job — so packed soft bodies settle instead of buzzing.
 */
function solveInterVelocities(soft: SoftBody[], restitution: number): void {
  eachInterPair(soft, (a, b) => {
    const w = a.invMass + b.invMass;
    if (w === 0) return;
    const d = b.pos.sub(a.pos);
    const len = d.length();
    if (len >= a.radius + b.radius || len < EPSILON) return;
    const n = d.mul(1 / len);
    const vRel = b.vel.sub(a.vel);
    const vn = vRel.dot(n);
    if (vn >= 0) return;

    const jn = (-(1 + restitution) * vn) / w;
    a.vel = a.vel.sub(n.mul(jn * a.invMass));
    b.vel = b.vel.add(n.mul(jn * b.invMass));

    const t = vRel.sub(n.mul(vn));
    const tlen = t.length();
    if (tlen > EPSILON) {
      const td = t.mul(1 / tlen);
      const jt = clamp(-tlen / w, -0.4 * jn, 0.4 * jn);
      a.vel = a.vel.sub(td.mul(jt * a.invMass));
      b.vel = b.vel.add(td.mul(jt * b.invMass));
    }
  });
}
