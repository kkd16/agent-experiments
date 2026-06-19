// Castle — ruined stone towers. Horizontal placement is left completely free (every side face is
// the symmetric empty socket), so the towers stand apart in open air; the look comes entirely
// from the vertical-seam rules: `S` (stone-on-stone) lets blocks stack into masses, `O` (open
// sky) sits only above a crenellated cap or more sky. So every column is stone … stone … a
// battlement/spire … sky — a little skyline of keeps and turrets that's always structurally sane.

import { faces } from '../sockets3';
import type { Prototype3, Tileset3 } from '../types3';
import { hex, VoxelBuilder, type VoxModel } from '../voxel';
import { NY, PY } from '../dirs3';

const R = 6;
const STONE = hex('#8a8f99');
const STONE2 = hex('#767c86');
const MORTAR = hex('#6a707a');
const ROOF = hex('#a85a48');

const S = 'vsi'; // solid vertical seam (stone continues)
const O = 'v0'; // open vertical seam (sky)

function speckle(b: VoxelBuilder, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
  for (let z = z0; z <= z1; z++)
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const n = ((x * 7 + y * 11 + z * 5) ^ (x + z * 3)) & 3;
        b.set(x, y, z, n === 0 ? STONE2 : STONE);
      }
}

function solid(): VoxModel {
  const b = new VoxelBuilder(R);
  speckle(b, 0, 0, 0, R - 1, R - 1, R - 1);
  return b.done();
}

function window(): VoxModel {
  const b = new VoxelBuilder(R);
  speckle(b, 0, 0, 0, R - 1, R - 1, R - 1);
  // carve an arched slit straight through the Z axis (rotations face it elsewhere)
  for (let z = 0; z < R; z++) {
    b.set(2, 1, z, 0).set(3, 1, z, 0);
    b.set(2, 2, z, 0).set(3, 2, z, 0);
    b.set(2, 3, z, 0).set(3, 3, z, 0);
  }
  return b.done();
}

function battlement(): VoxModel {
  const b = new VoxelBuilder(R);
  speckle(b, 0, 0, 0, R - 1, R - 2, R - 1); // solid body
  b.box(0, R - 2, 0, R - 1, R - 2, R - 1, MORTAR); // a course line under the merlons
  // merlons: blocks around the top edge with gaps (crenellation)
  for (let x = 0; x < R; x++)
    for (let z = 0; z < R; z++) {
      const edge = x === 0 || z === 0 || x === R - 1 || z === R - 1;
      if (edge && (x + z) % 2 === 0) b.set(x, R - 1, z, STONE);
    }
  return b.done();
}

function spire(): VoxModel {
  const b = new VoxelBuilder(R);
  // a stepped pyramid roof, shrinking square per layer
  for (let y = 0; y < R; y++) {
    const inset = Math.floor((y * (R / 2)) / R);
    b.box(inset, y, inset, R - 1 - inset, y, R - 1 - inset, y >= 1 ? ROOF : MORTAR);
  }
  return b.done();
}

const protos: Prototype3[] = [
  { name: 'stone', model: solid(), sockets: faces({ [PY]: S, [NY]: S }), rotations: 1, weight: 3 },
  { name: 'window', model: window(), sockets: faces({ [PY]: S, [NY]: S }), rotations: 4, weight: 1 },
  { name: 'battlement', model: battlement(), sockets: faces({ [PY]: O, [NY]: S }), rotations: 1, weight: 2 },
  { name: 'spire', model: spire(), sockets: faces({ [PY]: O, [NY]: S }), rotations: 1, weight: 1 },
  { name: 'air', model: new VoxelBuilder(R).done(), sockets: faces({ [PY]: O, [NY]: O }), rotations: 1, weight: 5 },
];

export const castle: Tileset3 = {
  key: 'castle',
  name: 'Castle',
  blurb: 'Free-standing crenellated towers — vertical seam rules stack stone into keeps capped by battlements and spires.',
  background: 'linear-gradient(180deg,#101622,#0c0f1a)',
  res: R,
  prototypes: protos,
};
