// Pipes3D — a volumetric conduit network. Every tile is a hub with arms reaching toward some
// subset of its six faces; an arm presents an open socket on that face (`p` for the four
// horizontal faces, an invariant vertical `vp` for top/bottom), a face with no arm is closed.
// Because every arm draws the *same* centred circular cross-section, two open faces that the
// solver joins line up voxel-for-voxel, so the pipe reads as one continuous run through the
// lattice. Straights, elbows, tees, a cross and caps give the solver enough vocabulary to always
// close a network off.

import { faces } from '../sockets3';
import type { Prototype3, Tileset3 } from '../types3';
import { hex, VoxelBuilder, type VoxModel } from '../voxel';
import { NX, NY, NZ, PX, PY, PZ, type Dir3 } from '../dirs3';

const R = 6;
const BODY = hex('#34a7a7');
const CORE = hex('#5fd0d0');
const CEN = 2.5; // (R-1)/2
const R2 = 3.0; // cross-section radius² (a ~3-wide round pipe)

// Is voxel (a,b) within the circular cross-section centred on the cell axis?
function inDisk(a: number, b: number): boolean {
  const da = a - CEN;
  const db = b - CEN;
  return da * da + db * db <= R2;
}

/** Carve a pipe arm from the hub out to the face in direction `d`. */
function arm(bld: VoxelBuilder, d: Dir3): void {
  for (let i = 0; i < R; i++) {
    for (let j = 0; j < R; j++) {
      if (!inDisk(i, j)) continue;
      // i,j span the plane perpendicular to the arm axis; k runs along the axis from hub to face
      if (d === PX) for (let k = 3; k < R; k++) bld.set(k, i, j, BODY);
      else if (d === NX) for (let k = 0; k <= 2; k++) bld.set(k, i, j, BODY);
      else if (d === PZ) for (let k = 3; k < R; k++) bld.set(i, j, k, BODY);
      else if (d === NZ) for (let k = 0; k <= 2; k++) bld.set(i, j, k, BODY);
      else if (d === PY) for (let k = 3; k < R; k++) bld.set(i, k, j, BODY);
      else if (d === NY) for (let k = 0; k <= 2; k++) bld.set(i, k, j, BODY);
    }
  }
}

function hub(...dirs: Dir3[]): VoxModel {
  const b = new VoxelBuilder(R);
  for (const d of dirs) arm(b, d);
  if (dirs.length) b.box(2, 2, 2, 3, 3, 3, CORE); // bright node so junctions pop
  return b.done();
}

const P = 'p'; // open horizontal socket (symmetric)
const VP = 'vpi'; // open vertical socket (invariant)

const protos: Prototype3[] = [
  { name: 'empty', model: new VoxelBuilder(R).done(), sockets: faces({}), rotations: 1, weight: 5 },
  {
    name: 'straight-h',
    model: hub(PX, NX),
    sockets: faces({ [PX]: P, [NX]: P }),
    rotations: 2,
    weight: 3,
  },
  {
    name: 'straight-v',
    model: hub(PY, NY),
    sockets: faces({ [PY]: VP, [NY]: VP }),
    rotations: 1,
    weight: 2,
  },
  {
    name: 'elbow-hh',
    model: hub(PX, PZ),
    sockets: faces({ [PX]: P, [PZ]: P }),
    rotations: 4,
    weight: 2,
  },
  {
    name: 'elbow-hv',
    model: hub(PX, PY),
    sockets: faces({ [PX]: P, [PY]: VP }),
    rotations: 4,
    weight: 2,
  },
  {
    name: 'tee-h',
    model: hub(PX, NX, PZ),
    sockets: faces({ [PX]: P, [NX]: P, [PZ]: P }),
    rotations: 4,
    weight: 1,
  },
  {
    name: 'cross-h',
    model: hub(PX, NX, PZ, NZ),
    sockets: faces({ [PX]: P, [NX]: P, [PZ]: P, [NZ]: P }),
    rotations: 1,
    weight: 1,
  },
  { name: 'cap-h', model: hub(PX), sockets: faces({ [PX]: P }), rotations: 4, weight: 1 },
  { name: 'cap-up', model: hub(PY), sockets: faces({ [PY]: VP }), rotations: 1, weight: 1 },
  { name: 'cap-down', model: hub(NY), sockets: faces({ [NY]: VP }), rotations: 1, weight: 1 },
];

export const pipes3d: Tileset3 = {
  key: 'pipes3d',
  name: 'Pipes3D',
  blurb: 'A volumetric conduit network — straights, elbows, tees and caps whose round cross-sections join seamlessly across all six faces.',
  background: 'linear-gradient(180deg,#0a1622,#0a1020)',
  res: R,
  prototypes: protos,
};
