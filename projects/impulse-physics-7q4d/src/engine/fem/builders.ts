import { Vec2 } from '../math';
import { DEFAULT_FEM_MATERIAL, FemBody, type FemMaterial } from './fembody';

/** Options shared by every FEM builder. */
export interface FemOptions {
  /** Partial material overrides (Young's modulus, Poisson ratio, density, damping). */
  material?: Partial<FemMaterial>;
  color?: string;
  /** Colour each triangle by its von-Mises stress instead of a flat fill. */
  stressHeatmap?: boolean;
  /** Collision disc radius per node. */
  nodeRadius?: number;
}

function resolveMaterial(o?: Partial<FemMaterial>): FemMaterial {
  return { ...DEFAULT_FEM_MATERIAL, ...(o ?? {}) };
}

/**
 * A structured rectangular mesh spanning [x0, x0+length] × [y0−height/2, y0+height/2],
 * divided into `nx`×`ny` cells, each split into two triangles with an alternating
 * ("union-jack") diagonal so the discretisation has no directional bias. This is the
 * workhorse for the cantilever-beam benchmark.
 *
 * The optional `pin` callback receives each node's rest position; return `true` to
 * clamp it (a Dirichlet boundary). `makeFemBeam` is laid out so node 0 is the
 * bottom-left corner and indices increase x-fastest.
 */
export function makeFemBeam(
  origin: Vec2,
  length: number,
  height: number,
  nx: number,
  ny: number,
  opts: FemOptions & { pin?: (rest: Vec2) => boolean } = {},
): FemBody {
  const material = resolveMaterial(opts.material);
  const cols = nx + 1;
  const rows = ny + 1;
  const dx = length / nx;
  const dy = height / ny;
  const x0 = origin.x;
  const y0 = origin.y - height / 2;

  const rest = new Float64Array(cols * rows * 2);
  const id = (ix: number, iy: number): number => iy * cols + ix;
  for (let iy = 0; iy < rows; iy++) {
    for (let ix = 0; ix < cols; ix++) {
      const k = id(ix, iy);
      rest[2 * k] = x0 + ix * dx;
      rest[2 * k + 1] = y0 + iy * dy;
    }
  }

  const body = new FemBody(rest, material, {
    color: opts.color ?? '#6ea8ff',
    stressHeatmap: opts.stressHeatmap ?? false,
  });
  if (opts.nodeRadius) body.nodeRadius = opts.nodeRadius;

  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const a = id(ix, iy);
      const b = id(ix + 1, iy);
      const c = id(ix + 1, iy + 1);
      const d = id(ix, iy + 1);
      // Alternate the split diagonal so the mesh is symmetric on average.
      if ((ix + iy) % 2 === 0) {
        body.addElement(a, b, c);
        body.addElement(a, c, d);
      } else {
        body.addElement(a, b, d);
        body.addElement(b, c, d);
      }
    }
  }

  body.finalize();
  if (opts.pin) {
    for (let i = 0; i < body.nodeCount; i++) {
      if (opts.pin(new Vec2(rest[2 * i], rest[2 * i + 1]))) body.pin(i);
    }
  }
  return body;
}

/**
 * A solid deformable box centred at `center`, `halfW`×`halfH`, meshed `nx`×`ny`.
 * Optionally pin its top edge (to hang it) or any node via `pin`.
 */
export function makeFemBox(
  center: Vec2,
  halfW: number,
  halfH: number,
  nx: number,
  ny: number,
  opts: FemOptions & { pin?: (rest: Vec2) => boolean } = {},
): FemBody {
  return makeFemBeam(
    new Vec2(center.x - halfW, center.y),
    halfW * 2,
    halfH * 2,
    nx,
    ny,
    opts,
  );
}

/**
 * A solid deformable disc: a centre node ringed by `rings` concentric layers of
 * `seg` nodes each, triangulated outward. Produces a clean, isotropic circular
 * mesh for jelly drops.
 */
export function makeFemDisk(
  center: Vec2,
  radius: number,
  rings: number,
  seg: number,
  opts: FemOptions = {},
): FemBody {
  const material = resolveMaterial(opts.material);
  const coords: number[] = [center.x, center.y];
  // Ring nodes.
  for (let r = 1; r <= rings; r++) {
    const rr = (radius * r) / rings;
    for (let s = 0; s < seg; s++) {
      const ang = (s / seg) * Math.PI * 2;
      coords.push(center.x + Math.cos(ang) * rr, center.y + Math.sin(ang) * rr);
    }
  }
  const rest = new Float64Array(coords);
  const body = new FemBody(rest, material, {
    color: opts.color ?? '#7CFFCB',
    stressHeatmap: opts.stressHeatmap ?? false,
  });
  if (opts.nodeRadius) body.nodeRadius = opts.nodeRadius;

  // Index of ring r (1-based), segment s.
  const ring = (r: number, s: number): number => 1 + (r - 1) * seg + ((s % seg) + seg) % seg;

  // Innermost ring fans from the centre.
  for (let s = 0; s < seg; s++) {
    body.addElement(0, ring(1, s), ring(1, s + 1));
  }
  // Outer rings: quads between consecutive rings, split into two triangles.
  for (let r = 1; r < rings; r++) {
    for (let s = 0; s < seg; s++) {
      const a = ring(r, s);
      const b = ring(r, s + 1);
      const c = ring(r + 1, s + 1);
      const d = ring(r + 1, s);
      body.addElement(a, b, c);
      body.addElement(a, c, d);
    }
  }

  body.finalize();
  return body;
}
