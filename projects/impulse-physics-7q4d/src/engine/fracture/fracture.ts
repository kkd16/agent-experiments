/**
 * Rigid-body fracture: shatter a convex polygon body into Voronoi shards.
 *
 * The split is a *rigid decomposition*. Every shard inherits the parent's rigid
 * velocity field sampled at the shard's own centre of mass —
 * `vᵢ = v + ω × (cᵢ − C)` — and the parent's angular velocity. Because the
 * Voronoi cells tile the parent exactly, this reproduces the parent's motion
 * piece-for-piece: the shards' masses sum to the parent's, and (proven in the
 * suite) their linear and angular momenta sum to the parent's too. The object
 * therefore keeps moving as one until something external prises the pieces
 * apart — at which point the engine's own contact solver takes over and they
 * scatter. An optional outward `eject` impulse from the impact point adds the
 * drama of a projectile blasting through.
 */
import { Body, type BodyDef } from '../body';
import { crossSV, EPSILON, Vec2 } from '../math';
import { computeMass, Polygon, type Shape } from '../shapes';
import { Rng } from '../random';
import { polygonArea } from './clip';
import { scatterSites, voronoiCells, type SitePattern } from './voronoi';

/** Material describing how (and whether) a body shatters. */
export interface FractureMaterial {
  /**
   * Normal impulse (kg·m/s) a single contact must deliver in one step to
   * trigger an automatic shatter. `Infinity` means the body only fractures when
   * something calls {@link World.fracture} explicitly.
   */
  toughness: number;
  /** Approximate number of shards a shatter produces. */
  shards: number;
  /** Site layout: scattered, glass-style rings, or a jittered grid. */
  pattern: SitePattern;
  /** Site jitter as a fraction of the shape's size. */
  jitter: number;
  /** 0 for an intact body; each shard is one generation deeper. */
  generation: number;
  /** Shards stop auto-refracturing once they reach this generation. */
  maxGeneration: number;
  /** A body smaller than this area is too small to shatter further. */
  minArea: number;
}

export const DEFAULT_FRACTURE: FractureMaterial = {
  toughness: 12,
  shards: 14,
  pattern: 'radial',
  jitter: 0.5,
  generation: 0,
  maxGeneration: 2,
  minArea: 0.05,
};

/** Build a full material from partial overrides. */
export function fractureMaterial(opts: Partial<FractureMaterial> = {}): FractureMaterial {
  return { ...DEFAULT_FRACTURE, ...opts };
}

export interface FractureOptions {
  /** Outward impulse magnitude applied to shards from the focus point. */
  eject?: number;
  /** Override the site count for this shatter. */
  shards?: number;
  /** Override the pattern for this shatter. */
  pattern?: SitePattern;
  /** A deterministic RNG; one is created from the body id if omitted. */
  rng?: Rng;
}

/** True when `shape` is a convex polygon (the only shatterable shape). */
export function isFracturable(shape: Shape): shape is Polygon {
  return shape.kind === 'polygon';
}

/**
 * Split `parent` into Voronoi shards around the world-space `impact` point.
 * Returns the freshly-built shard bodies (not yet added to any world) — the
 * caller (`World.fracture`) is responsible for swapping them in for the parent.
 * Returns an empty array when the body can't or shouldn't shatter (non-polygon,
 * too small, or only one viable cell came back).
 */
export function fractureBody(
  parent: Body,
  impact: Vec2,
  opts: FractureOptions = {},
): Body[] {
  const shape = parent.shape;
  if (!isFracturable(shape)) return [];

  const mat = parent.fracture ?? DEFAULT_FRACTURE;
  const boundary = shape.vertices;
  const totalArea = Math.abs(polygonArea(boundary));
  if (totalArea < mat.minArea) return [];

  const rng = opts.rng ?? new Rng((parent.id * 0x9e3779b9) >>> 0);
  const focusLocal = parent.localPoint(impact);
  const sites = scatterSites(boundary, rng, {
    count: opts.shards ?? mat.shards,
    focus: focusLocal,
    pattern: opts.pattern ?? mat.pattern,
    jitter: mat.jitter,
  });
  if (sites.length < 2) return [];

  const cells = voronoiCells(boundary, sites);
  const cellEpsilon = Math.max(totalArea * 1e-4, 1e-6);

  // Inherit every material/motion property except the geometry-derived ones.
  const baseDef: BodyDef = {
    type: parent.type,
    density: parent.density,
    friction: parent.friction,
    restitution: parent.restitution,
    linearDamping: parent.linearDamping,
    angularDamping: parent.angularDamping,
    gravityScale: parent.gravityScale,
    color: parent.color,
  };
  const childMat: FractureMaterial = {
    ...mat,
    generation: mat.generation + 1,
    shards: Math.max(4, Math.round(mat.shards * 0.7)),
  };

  const shards: Body[] = [];
  for (const cell of cells) {
    if (cell.length < 3) continue;
    if (Math.abs(polygonArea(cell)) < cellEpsilon) continue;
    let poly: Polygon;
    try {
      poly = Polygon.fromVertices(cell, shape.radius);
    } catch {
      continue; // degenerate (collinear) cell — skip
    }
    const shard = new Body(poly, {
      ...baseDef,
      position: parent.transform.position,
      angle: parent.angle,
    });
    shard.fracture = childMat;
    // Rigid velocity field of the parent, sampled at this shard's centre of mass.
    const r = shard.worldCenter.sub(parent.worldCenter);
    shard.linearVelocity = parent.linearVelocity.add(
      crossSV(parent.angularVelocity, r),
    );
    shard.angularVelocity = parent.angularVelocity;
    shards.push(shard);
  }

  // A single surviving cell is just the parent again — nothing was gained.
  if (shards.length < 2) return [];

  // Optional dramatic ejection straight out of the impact point. This is an
  // external impulse (a projectile's blow), so it is intentionally *not*
  // momentum-neutral — pass `eject: 0` for a pure, conservative split.
  const eject = opts.eject ?? 0;
  if (eject > 0) {
    for (const s of shards) {
      const dir = s.worldCenter.sub(impact);
      const d = dir.length();
      if (d < EPSILON) continue;
      const falloff = 1 / (1 + d);
      const j = dir.mul((eject * falloff) / d);
      s.linearVelocity = s.linearVelocity.add(j.mul(s.invMass));
    }
  }

  return shards;
}

/** Total mass of a shape at a density — used by conservation checks. */
export function shapeMass(shape: Shape, density: number): number {
  return computeMass(shape, density).mass;
}
