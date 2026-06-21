/**
 * Power-free Voronoi fracture of a convex polygon.
 *
 * Given a convex boundary and a set of interior *sites*, the cell of each site
 * is the set of points closer to it than to any other site. For a convex
 * boundary every cell is itself convex and can be built by intersecting the
 * boundary with one half-plane per other site (the perpendicular bisector). The
 * cells exactly tile the boundary — their areas sum to the boundary's area and
 * their interiors are disjoint — which is what makes a Voronoi shatter mass- and
 * area-conserving by construction (asserted in the verification suite).
 *
 * This direct clip-against-every-bisector construction is O(S²·V) in the site
 * and vertex counts; for the few dozen shards a real fracture produces it is
 * both exact and instant.
 */
import { Rng } from '../random';
import { Vec2 } from '../math';
import { clipHalfPlane, pointInConvex, polygonBounds } from './clip';

/**
 * The Voronoi cell of every site, aligned one-to-one with `sites`. Coincident
 * (or near-coincident) sites would otherwise share an identical cell and double
 * the tiled area; to keep the partition exact the lowest-indexed of a coincident
 * group keeps the shared ground and the rest are handed an empty cell.
 */
export function voronoiCells(boundary: readonly Vec2[], sites: readonly Vec2[]): Vec2[][] {
  const [min, max] = polygonBounds(boundary);
  const span = Math.max(max.x - min.x, max.y - min.y, 1e-9);
  const eps2 = (span * 1e-6) * (span * 1e-6);

  const cells: Vec2[][] = [];
  for (let i = 0; i < sites.length; i++) {
    const si = sites[i];
    let cell: Vec2[] = boundary.slice();
    let dead = false;
    for (let j = 0; j < sites.length && cell.length >= 3; j++) {
      if (j === i) continue;
      const sj = sites[j];
      const n = sj.sub(si);
      if (n.lengthSq() < eps2) {
        // Coincident sites: the earlier index owns the shared cell; later ones die.
        if (j < i) { dead = true; break; }
        continue;
      }
      // Bisector: points closer to si satisfy n·p ≤ n·midpoint.
      const mid = si.add(sj).mul(0.5);
      cell = clipHalfPlane(cell, n, n.dot(mid));
    }
    cells.push(dead ? [] : cell);
  }
  return cells;
}

/** How to scatter fracture sites across a shape. */
export type SitePattern = 'uniform' | 'radial' | 'grid';

export interface SiteOptions {
  /** Roughly how many shards to make. */
  count: number;
  /** Where the impact landed (local coords) — focuses the `radial` pattern. */
  focus?: Vec2;
  /** Pattern: scattered, glass-style rings around the focus, or a jittered grid. */
  pattern?: SitePattern;
  /** Positional jitter as a fraction of the shape's size (0…1). */
  jitter?: number;
}

/**
 * Scatter `count`-ish fracture sites inside a convex `boundary`. The `radial`
 * pattern lays sites on concentric rings about the impact focus (with angular
 * jitter) — the classic spider-web glass shatter, fine near the impact and
 * coarse at the rim — while `uniform` rejection-samples the interior and `grid`
 * jitters a lattice. All sites are guaranteed to fall inside the boundary.
 */
export function scatterSites(
  boundary: readonly Vec2[],
  rng: Rng,
  opts: SiteOptions,
): Vec2[] {
  const pattern = opts.pattern ?? 'uniform';
  const count = Math.max(1, Math.floor(opts.count));
  const [min, max] = polygonBounds(boundary);
  const size = max.sub(min);
  const span = Math.max(size.x, size.y);
  const jitter = (opts.jitter ?? 0.5) * span;

  if (pattern === 'radial') {
    return radialSites(boundary, rng, count, opts.focus ?? centerOf(min, max), span, jitter);
  }
  if (pattern === 'grid') {
    return gridSites(boundary, rng, count, min, size, jitter);
  }
  return uniformSites(boundary, rng, count, min, size);
}

function centerOf(min: Vec2, max: Vec2): Vec2 {
  return min.add(max).mul(0.5);
}

/** Rejection-sample `count` points uniformly inside the boundary. */
function uniformSites(
  boundary: readonly Vec2[],
  rng: Rng,
  count: number,
  min: Vec2,
  size: Vec2,
): Vec2[] {
  const sites: Vec2[] = [];
  let guard = count * 40 + 50;
  while (sites.length < count && guard-- > 0) {
    const p = new Vec2(min.x + rng.next() * size.x, min.y + rng.next() * size.y);
    if (pointInConvex(boundary, p)) sites.push(p);
  }
  return sites.length >= 1 ? sites : [centerOf(min, min.add(size))];
}

/**
 * Glass-shatter sites: concentric rings about `focus`, the ring count and
 * per-ring density growing outward, each site nudged angularly and radially.
 * Sites that escape the boundary are clamped back by rejection.
 */
function radialSites(
  boundary: readonly Vec2[],
  rng: Rng,
  count: number,
  focus: Vec2,
  span: number,
  jitter: number,
): Vec2[] {
  const sites: Vec2[] = [pointInConvex(boundary, focus) ? focus : clampInside(boundary, focus)];
  const rings = Math.max(2, Math.round(Math.sqrt(count)));
  const maxR = span * 0.62;
  for (let ring = 1; ring <= rings && sites.length < count; ring++) {
    const frac = ring / rings;
    const radius = maxR * frac * frac; // denser near the impact
    const perRing = Math.max(3, Math.round((count / rings) * (0.6 + frac)));
    const phase = rng.next() * Math.PI * 2;
    for (let k = 0; k < perRing && sites.length < count; k++) {
      const ang = phase + (k / perRing) * Math.PI * 2 + rng.range(-0.4, 0.4) / ring;
      const r = radius + rng.range(-0.18, 0.18) * jitter;
      const p = focus.add(new Vec2(Math.cos(ang), Math.sin(ang)).mul(Math.max(r, 0)));
      if (pointInConvex(boundary, p)) sites.push(p);
    }
  }
  return sites;
}

/** A jittered lattice clipped to the boundary. */
function gridSites(
  boundary: readonly Vec2[],
  rng: Rng,
  count: number,
  min: Vec2,
  size: Vec2,
  jitter: number,
): Vec2[] {
  const aspect = size.x / Math.max(size.y, 1e-6);
  const cols = Math.max(1, Math.round(Math.sqrt(count * aspect)));
  const rows = Math.max(1, Math.round(count / cols));
  const sites: Vec2[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const base = new Vec2(
        min.x + ((c + 0.5) / cols) * size.x,
        min.y + ((r + 0.5) / rows) * size.y,
      );
      const p = base.add(new Vec2(rng.range(-1, 1), rng.range(-1, 1)).mul(jitter * 0.25));
      if (pointInConvex(boundary, p)) sites.push(p);
    }
  }
  return sites.length >= 1 ? sites : uniformSites(boundary, rng, count, min, size);
}

/** Pull a stray focus point onto the boundary's centroid-ward interior. */
function clampInside(boundary: readonly Vec2[], p: Vec2): Vec2 {
  let cx = 0;
  let cy = 0;
  for (const v of boundary) {
    cx += v.x;
    cy += v.y;
  }
  const centroid = new Vec2(cx / boundary.length, cy / boundary.length);
  return p.lerp(centroid, 0.5);
}
