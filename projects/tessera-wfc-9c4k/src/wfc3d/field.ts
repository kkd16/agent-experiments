// The merged voxel field — every collapsed tile's R³ model stamped into one big lattice that the
// rasteriser turns into pixels. Rebuilt from the solver's collapsed cells whenever the scene goes
// dirty (cheap: a few hundred cells × a few hundred voxels), which keeps the renderer a pure
// function of "what has crystallised so far".

import type { VoxModel } from './voxel';

export class VoxField {
  readonly fx: number;
  readonly fy: number;
  readonly fz: number;
  readonly res: number;
  readonly data: Int32Array;
  /** Count of filled voxels — lets the renderer skip work on an empty field. */
  filled = 0;

  constructor(sx: number, sy: number, sz: number, res: number) {
    this.res = res;
    this.fx = sx * res;
    this.fy = sy * res;
    this.fz = sz * res;
    this.data = new Int32Array(this.fx * this.fy * this.fz);
  }

  clear(): void {
    this.data.fill(0);
    this.filled = 0;
  }

  at(x: number, y: number, z: number): number {
    if (x < 0 || y < 0 || z < 0 || x >= this.fx || y >= this.fy || z >= this.fz) return 0;
    return this.data[x + this.fx * (y + this.fy * z)];
  }

  /** Stamp a model into the field at grid cell (cx,cy,cz). */
  place(model: VoxModel, cx: number, cy: number, cz: number): void {
    const r = this.res;
    const ox = cx * r;
    const oy = cy * r;
    const oz = cz * r;
    const { vox } = model;
    for (let z = 0; z < r; z++)
      for (let y = 0; y < r; y++)
        for (let x = 0; x < r; x++) {
          const v = vox[x + r * (y + r * z)];
          if (v === 0) continue;
          const idx = ox + x + this.fx * (oy + y + this.fy * (oz + z));
          if (this.data[idx] === 0) this.filled++;
          this.data[idx] = v;
        }
  }
}
