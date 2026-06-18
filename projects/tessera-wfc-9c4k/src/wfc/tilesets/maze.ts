import type { Prototype, Tileset } from '../types';
import { spokes, type Side } from './paint';

// A top-down maze: wide corridor "floors" carved through solid walls. Edge codes match the other
// connection sets ("000" = wall, "010" = a corridor opening), so the global connectivity
// constraint applies directly — "Route between pins" carves a *guaranteed-solvable* maze between
// two painted endpoints, and dead-ends/junctions self-assemble in the spaces between.
const O = '000';
const C = '010';

const FLOOR = '#fbbf24'; // warm corridor floor
const FLOOR_EDGE = 'rgba(251,191,36,0.16)'; // soft glow so corridors read as carved
const CORRIDOR_W = 22; // wide enough that the maze reads as rooms-and-halls, not thin wires

function corridor(sides: Side[]) {
  return (ctx: CanvasRenderingContext2D, size: number) => {
    // a faint rounded "carved" halo under the floor, then the floor itself
    spokes(ctx, size, sides, { color: FLOOR, width: CORRIDOR_W, hub: sides.length > 1 ? CORRIDOR_W / 2 : 0, glow: FLOOR_EDGE });
  };
}

const protos: Prototype[] = [
  // solid wall — the empty tile
  { name: 'wall', edges: [O, O, O, O], symmetry: 'X', weight: 1.25, draw: () => {} },
  // a closed pocket / dead-end (corridor that opens to just one side)
  {
    name: 'dead-end',
    edges: [C, O, O, O],
    symmetry: 'T',
    weight: 0.5,
    draw: (ctx, size) => {
      const fn = corridor(['N']);
      fn(ctx, size);
      // round off the closed end so it reads as a cul-de-sac
      ctx.fillStyle = FLOOR;
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, CORRIDOR_W / 2, 0, Math.PI * 2);
      ctx.fill();
    },
  },
  { name: 'hall', edges: [C, O, C, O], symmetry: 'I', weight: 1.0, draw: corridor(['N', 'S']) },
  { name: 'turn', edges: [C, C, O, O], symmetry: 'L', weight: 1.0, draw: corridor(['N', 'E']) },
  { name: 'junction', edges: [C, C, C, O], symmetry: 'T', weight: 0.4, draw: corridor(['N', 'E', 'S']) },
  { name: 'plaza', edges: [C, C, C, C], symmetry: 'X', weight: 0.22, draw: corridor(['N', 'E', 'S', 'W']) },
];

export const maze: Tileset = {
  key: 'maze',
  name: 'Maze',
  blurb: 'Corridors carved through walls. With "Route between pins" it grows a guaranteed-solvable maze.',
  background: '#1e293b',
  emptyEdge: '000',
  prototypes: protos,
};
