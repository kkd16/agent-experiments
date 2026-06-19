// A tiny voxel-model representation and the operations the 3D engine needs on it.
//
// A model is an R×R×R block of coloured voxels (R = the tile resolution). Each voxel is a packed
// 32-bit value: 0 means empty, anything else is `(1<<24) | (r<<16) | (g<<8) | b` — the high bit
// marks "filled" so a legitimately black voxel is still distinguishable from air. Tiles are
// authored with the small builder below, then expanded into rotated variants by the compiler;
// the renderer reads the merged field of all collapsed tiles' voxels.

export type VoxModel = {
  res: number;
  /** Length res³, indexed `x + res*(y + res*z)`. 0 = empty. */
  vox: Int32Array;
};

export const FILLED = 1 << 24;

export function packColor(r: number, g: number, b: number): number {
  return FILLED | ((r & 255) << 16) | ((g & 255) << 8) | (b & 255);
}

export function unpack(v: number): [number, number, number] {
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** Parse a `#rrggbb` (or `#rgb`) hex colour into a packed voxel value. */
export function hex(s: string): number {
  let h = s.replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  return packColor((n >> 16) & 255, (n >> 8) & 255, n & 255);
}

/** A fluent authoring helper: carve boxes/planes into an R³ model with packed colours. */
export class VoxelBuilder {
  readonly res: number;
  readonly vox: Int32Array;
  constructor(res: number) {
    this.res = res;
    this.vox = new Int32Array(res * res * res);
  }
  idx(x: number, y: number, z: number): number {
    return x + this.res * (y + this.res * z);
  }
  set(x: number, y: number, z: number, color: number): this {
    const r = this.res;
    if (x < 0 || y < 0 || z < 0 || x >= r || y >= r || z >= r) return this;
    this.vox[this.idx(x, y, z)] = color;
    return this;
  }
  /** Fill the inclusive box [x0..x1]×[y0..y1]×[z0..z1] with a colour. */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color: number): this {
    for (let z = z0; z <= z1; z++)
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.set(x, y, z, color);
    return this;
  }
  /** A full Y-layer (a floor/ceiling slab) at height `y`. */
  layer(y: number, color: number): this {
    const r = this.res;
    return this.box(0, y, 0, r - 1, y, r - 1, color);
  }
  done(): VoxModel {
    return { res: this.res, vox: this.vox };
  }
}

/** Rotate a model 90° clockwise about +Y, `k` times. Geometry only — sockets rotate separately. */
export function rotateY(m: VoxModel, k: number): VoxModel {
  const steps = ((k % 4) + 4) % 4;
  let cur = m;
  for (let s = 0; s < steps; s++) {
    const r = cur.res;
    const out = new Int32Array(r * r * r);
    for (let z = 0; z < r; z++)
      for (let y = 0; y < r; y++)
        for (let x = 0; x < r; x++) {
          const v = cur.vox[x + r * (y + r * z)];
          if (v === 0) continue;
          // (x,z) -> (R-1-z, x): east edge swings to the south edge (matches ROT_CW: PX→PZ).
          const nx = r - 1 - z;
          const nz = x;
          out[nx + r * (y + r * nz)] = v;
        }
    cur = { res: r, vox: out };
  }
  return cur;
}

/** A stable key for deduping identical rotated geometry. */
export function modelKey(m: VoxModel): string {
  // join is fine — models are tiny (≤ a few hundred voxels) and this runs once at compile time.
  return m.res + ':' + m.vox.join(',');
}

/** Average colour of the filled voxels (for superposition ghosting); falls back to mid-grey. */
export function averageColor(m: VoxModel): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < m.vox.length; i++) {
    const v = m.vox[i];
    if (v === 0) continue;
    r += (v >> 16) & 255;
    g += (v >> 8) & 255;
    b += v & 255;
    n++;
  }
  if (n === 0) return [90, 100, 120];
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}
