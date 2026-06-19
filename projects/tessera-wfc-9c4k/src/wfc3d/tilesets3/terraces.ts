// Terraces — a stacked voxel landscape. The trick that makes coherent terrain fall out of a
// local solver is a tiny vertical-seam vocabulary: only two vertical socket keys exist, `gnd`
// (rock-to-rock / rock-to-surface) and `sky` (surface-to-air / air-to-air). All four side faces
// share one symmetric horizontal socket, so the terrain is free to vary horizontally while the
// vertical rules force every column to read as rock → a single surface → air. The result is
// little islands, cliffs and ponds that are always geologically "sensible".

import { faces } from '../sockets3';
import type { Prototype3, Tileset3 } from '../types3';
import { hex, VoxelBuilder, type VoxModel } from '../voxel';
import { NY, PY } from '../dirs3';

const R = 6;

// vertical seam keys (rotation-invariant — terrain has no facing)
const GND = 'vgi'; // ground seam: solid below
const SKY = 'v0'; // open seam: air

function rock(): VoxModel {
  const b = new VoxelBuilder(R);
  const a = hex('#5b6472');
  const c = hex('#48505c');
  for (let z = 0; z < R; z++)
    for (let y = 0; y < R; y++)
      for (let x = 0; x < R; x++) {
        // a cheap deterministic speckle so the stone isn't a flat colour
        const n = ((x * 7 + y * 13 + z * 5) ^ (x * z + y)) & 3;
        b.set(x, y, z, n === 0 ? c : a);
      }
  return b.done();
}

function surface(top: string, body: string): VoxModel {
  const b = new VoxelBuilder(R);
  const dirt = hex(body);
  const grass = hex(top);
  b.box(0, 0, 0, R - 1, R - 2, R - 1, dirt);
  b.layer(R - 1, grass);
  return b.done();
}

function water(): VoxModel {
  const b = new VoxelBuilder(R);
  b.box(0, 0, 0, R - 1, 0, R - 1, hex('#23435f')); // bed
  b.box(0, 1, 0, R - 1, 3, R - 1, hex('#2f6f9e')); // body
  b.layer(4, hex('#4f9fcf')); // brighter surface skin (leaves the top voxel open → reads wet)
  return b.done();
}

const protos: Prototype3[] = [
  {
    name: 'rock',
    model: rock(),
    sockets: faces({ [PY]: GND, [NY]: GND }),
    rotations: 1,
    weight: 3,
  },
  {
    name: 'grass',
    model: surface('#5fae54', '#6b4f34'),
    sockets: faces({ [PY]: SKY, [NY]: GND }),
    rotations: 1,
    weight: 2,
  },
  {
    name: 'sand',
    model: surface('#d8c27a', '#c4a85f'),
    sockets: faces({ [PY]: SKY, [NY]: GND }),
    rotations: 1,
    weight: 1,
  },
  {
    name: 'water',
    model: water(),
    sockets: faces({ [PY]: SKY, [NY]: GND }),
    rotations: 1,
    weight: 1,
  },
  {
    name: 'air',
    model: new VoxelBuilder(R).done(),
    sockets: faces({ [PY]: SKY, [NY]: SKY }),
    rotations: 1,
    weight: 4,
  },
];

export const terraces: Tileset3 = {
  key: 'terraces',
  name: 'Terraces',
  blurb: 'A stacked voxel landscape — two vertical seam types force every column to read as rock, one surface, then sky.',
  background: 'linear-gradient(180deg,#0b1828,#0a1a14)',
  res: R,
  prototypes: protos,
};
