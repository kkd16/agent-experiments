import { Vec2 } from '../math';
import { SoftBody, type SoftRender } from './softbody';

/** Friendly knobs shared by every soft-body factory. */
export interface SoftCommon {
  /** Total mass, spread evenly over the particles. */
  mass?: number;
  /** Collision radius of each particle (its "thickness" against rigid shapes). */
  particleRadius?: number;
  /** 0 (floppy) … 1 (nearly rigid); mapped logarithmically to XPBD compliance. */
  stiffness?: number;
  damping?: number;
  gravityScale?: number;
  friction?: number;
  restitution?: number;
  color?: string;
}

const C_STIFF = 1e-7;
const C_SOFT = 5e-3;

/** Map a 0…1 stiffness to a compliance (m/N), log-interpolated. */
export function compliance(stiffness: number, scale = 1): number {
  const s = Math.min(Math.max(stiffness, 0), 1);
  return scale * C_STIFF * Math.pow(C_SOFT / C_STIFF, 1 - s);
}

function applyCommon(sb: SoftBody, o: SoftCommon): void {
  if (o.damping !== undefined) sb.damping = o.damping;
  if (o.gravityScale !== undefined) sb.gravityScale = o.gravityScale;
  if (o.friction !== undefined) sb.friction = o.friction;
  if (o.restitution !== undefined) sb.restitution = o.restitution;
}

// ---- Blob: a pressurised ring (jelly / water balloon) ----------------------

export interface BlobOptions extends SoftCommon {
  /** Rest-area multiplier: 1 = incompressible, >1 inflates, <1 deflates. */
  pressure?: number;
  /** Compliance scale for the area constraint (higher ⇒ squishier volume). */
  areaStiffness?: number;
}

/**
 * A closed loop of `segments` particles around `center`, held round by
 * circumference springs, soft diameters and an area-preservation constraint.
 * The area term is what gives it body: squeeze one side and it bulges out the
 * other, exactly like a balloon or a drop of jelly.
 */
export function makeBlob(
  center: Vec2,
  radius: number,
  segments: number,
  opts: BlobOptions = {},
): SoftBody {
  const n = Math.max(6, segments | 0);
  const mass = opts.mass ?? 1;
  const pr = opts.particleRadius ?? 0.08;
  const stiff = opts.stiffness ?? 0.9;
  const color = opts.color ?? '#ff79c6';
  const render: SoftRender = { kind: 'blob', color, loop: [], links: [] };
  const sb = new SoftBody(render);
  applyCommon(sb, opts);

  const m = mass / n;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const pos = center.add(new Vec2(Math.cos(a), Math.sin(a)).mul(radius));
    sb.addParticle(pos, m, pr);
    render.loop!.push(i);
  }

  const cCirc = compliance(stiff);
  for (let i = 0; i < n; i++) {
    sb.addDistance(i, (i + 1) % n, cCirc);
    render.links.push([i, (i + 1) % n]);
  }
  // Soft diameters keep the loop convex (no folding) while still allowing squish.
  const cDiag = compliance(stiff, 60);
  for (let i = 0; i < n / 2; i++) {
    sb.addDistance(i, (i + (n >> 1)) % n, cDiag);
  }

  const pressure = opts.pressure ?? 1;
  const cArea = compliance(stiff, opts.areaStiffness ?? 8);
  sb.addArea(render.loop!, cArea, pressure);
  return sb;
}

// ---- Rope: a chain of particles --------------------------------------------

export interface RopeOptions extends SoftCommon {
  pinStart?: boolean;
  pinEnd?: boolean;
}

export function makeRope(
  a: Vec2,
  b: Vec2,
  segments: number,
  opts: RopeOptions = {},
): SoftBody {
  const n = Math.max(2, segments | 0) + 1;
  const mass = opts.mass ?? 1;
  const pr = opts.particleRadius ?? 0.08;
  const stiff = opts.stiffness ?? 0.95;
  const color = opts.color ?? '#ffd166';
  const render: SoftRender = { kind: 'rope', color, links: [] };
  const sb = new SoftBody(render);
  applyCommon(sb, opts);

  const m = mass / n;
  for (let i = 0; i < n; i++) {
    const pinned = (i === 0 && opts.pinStart) || (i === n - 1 && opts.pinEnd);
    sb.addParticle(a.lerp(b, i / (n - 1)), pinned ? 0 : m, pr);
  }
  const cStruct = compliance(stiff);
  const cBend = compliance(stiff, 80);
  for (let i = 0; i < n - 1; i++) {
    sb.addDistance(i, i + 1, cStruct);
    render.links.push([i, i + 1]);
  }
  for (let i = 0; i < n - 2; i++) sb.addDistance(i, i + 2, cBend);
  return sb;
}

// ---- Grids: cloth and soft solids ------------------------------------------

export interface ClothOptions extends SoftCommon {
  /** Which particles to pin. */
  pin?: 'top' | 'corners' | 'top-corners' | 'sides' | 'none';
}

/**
 * A `nx`×`ny` particle grid filling the rectangle from `origin` (top-left, in
 * world coords with +y up so the sheet hangs downward). Structural + shear +
 * bending constraints make it behave like woven fabric; the pinned row/corners
 * hold it up.
 */
export function makeCloth(
  origin: Vec2,
  width: number,
  height: number,
  nx: number,
  ny: number,
  opts: ClothOptions = {},
): SoftBody {
  const cols = Math.max(2, nx | 0);
  const rows = Math.max(2, ny | 0);
  const mass = opts.mass ?? 1;
  const pr = opts.particleRadius ?? 0.06;
  const stiff = opts.stiffness ?? 0.9;
  const color = opts.color ?? '#7CFFCB';
  const pin = opts.pin ?? 'top';
  const render: SoftRender = { kind: 'cloth', color, links: [], tris: [] };
  const sb = new SoftBody(render);
  applyCommon(sb, opts);

  const m = mass / (cols * rows);
  const dx = width / (cols - 1);
  const dy = height / (rows - 1);
  const idx = (ix: number, iy: number): number => iy * cols + ix;

  for (let iy = 0; iy < rows; iy++) {
    for (let ix = 0; ix < cols; ix++) {
      const pos = new Vec2(origin.x + ix * dx, origin.y - iy * dy);
      let pinned = false;
      if (pin === 'top') pinned = iy === 0;
      else if (pin === 'corners') pinned = (ix === 0 || ix === cols - 1) && iy === 0;
      else if (pin === 'top-corners') pinned = iy === 0 && (ix === 0 || ix === cols - 1);
      else if (pin === 'sides') pinned = ix === 0 || ix === cols - 1;
      sb.addParticle(pos, pinned ? 0 : m, pr);
    }
  }

  const cStruct = compliance(stiff);
  const cShear = compliance(stiff, 6);
  const cBend = compliance(stiff, 50);
  const link = (i: number, j: number, c: number, draw: boolean): void => {
    sb.addDistance(i, j, c);
    if (draw) render.links.push([i, j]);
  };

  for (let iy = 0; iy < rows; iy++) {
    for (let ix = 0; ix < cols; ix++) {
      const i = idx(ix, iy);
      if (ix < cols - 1) link(i, idx(ix + 1, iy), cStruct, true);
      if (iy < rows - 1) link(i, idx(ix, iy + 1), cStruct, true);
      if (ix < cols - 1 && iy < rows - 1) {
        link(i, idx(ix + 1, iy + 1), cShear, false);
        link(idx(ix + 1, iy), idx(ix, iy + 1), cShear, false);
        render.tris!.push([i, idx(ix + 1, iy), idx(ix + 1, iy + 1)]);
        render.tris!.push([i, idx(ix + 1, iy + 1), idx(ix, iy + 1)]);
      }
      if (ix < cols - 2) link(i, idx(ix + 2, iy), cBend, false);
      if (iy < rows - 2) link(i, idx(ix, iy + 2), cBend, false);
    }
  }
  return sb;
}

/**
 * A filled, unpinned deformable solid: the same lattice as {@link makeCloth} but
 * free to fall and squash. Rendered as a filled mesh, it dents under load and
 * springs back — a soft crate.
 */
export function makeSoftBox(
  center: Vec2,
  halfW: number,
  halfH: number,
  nx: number,
  ny: number,
  opts: SoftCommon = {},
): SoftBody {
  const cols = Math.max(2, nx | 0);
  const rows = Math.max(2, ny | 0);
  const mass = opts.mass ?? 1;
  const pr = opts.particleRadius ?? 0.08;
  const stiff = opts.stiffness ?? 0.8;
  const color = opts.color ?? '#6ea8ff';
  const render: SoftRender = { kind: 'mesh', color, links: [], tris: [] };
  const sb = new SoftBody(render);
  applyCommon(sb, opts);

  const m = mass / (cols * rows);
  const dx = (2 * halfW) / (cols - 1);
  const dy = (2 * halfH) / (rows - 1);
  const idx = (ix: number, iy: number): number => iy * cols + ix;
  for (let iy = 0; iy < rows; iy++) {
    for (let ix = 0; ix < cols; ix++) {
      sb.addParticle(new Vec2(center.x - halfW + ix * dx, center.y - halfH + iy * dy), m, pr);
    }
  }

  const cStruct = compliance(stiff);
  const cShear = compliance(stiff, 4);
  const cBend = compliance(stiff, 40);
  for (let iy = 0; iy < rows; iy++) {
    for (let ix = 0; ix < cols; ix++) {
      const i = idx(ix, iy);
      if (ix < cols - 1) {
        sb.addDistance(i, idx(ix + 1, iy), cStruct);
        render.links.push([i, idx(ix + 1, iy)]);
      }
      if (iy < rows - 1) {
        sb.addDistance(i, idx(ix, iy + 1), cStruct);
        render.links.push([i, idx(ix, iy + 1)]);
      }
      if (ix < cols - 1 && iy < rows - 1) {
        sb.addDistance(i, idx(ix + 1, iy + 1), cShear);
        sb.addDistance(idx(ix + 1, iy), idx(ix, iy + 1), cShear);
        render.tris!.push([i, idx(ix + 1, iy), idx(ix + 1, iy + 1)]);
        render.tris!.push([i, idx(ix + 1, iy + 1), idx(ix, iy + 1)]);
      }
      // Bending: skip-one links keep the lattice from buckling under load.
      if (ix < cols - 2) sb.addDistance(i, idx(ix + 2, iy), cBend);
      if (iy < rows - 2) sb.addDistance(i, idx(ix, iy + 2), cBend);
      // Per-cell area preservation gives the solid genuine "body": dent it and
      // it bulges out nearby, then springs back — incompressible rubber rather
      // than a collapsible truss. Local quads (vs one big perimeter loop) stay
      // robust even when the surface is pressed concave by a heavy load.
      if (ix < cols - 1 && iy < rows - 1) {
        sb.addArea(
          [i, idx(ix + 1, iy), idx(ix + 1, iy + 1), idx(ix, iy + 1)],
          compliance(stiff, 5),
        );
      }
    }
  }
  return sb;
}
