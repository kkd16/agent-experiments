// Hex Weave — a hexagonal Truchet set. Every edge is an identical connection point `c`, so *any*
// tile fits *any* neighbour: adjacency is unconstrained and the interest is purely in how each tile
// routes its six edge-midpoints into three ribbons. Three matchings (adjacent corners, skip-one,
// and straight-through) plus their rotations interlace into endless flowing knotwork.

import type { Dir6 } from '../hexgrid';
import type { HexEdges, HexPrototype, HexTileset } from '../types_hex';
import { ribbon } from './draw';

const BG = '#16121f';
const CASING = '#0a0810';
const RIBBONS = ['#e0517a', '#46c2a8', '#f2b541'];

type Pair = [Dir6, Dir6];

function weaveTile(name: string, pairs: Pair[], pull: number, weight: number): HexPrototype {
  return {
    name,
    edges: ['c', 'c', 'c', 'c', 'c', 'c'] as HexEdges,
    rotations: 6,
    weight,
    draw: (ctx, s) => {
      ctx.fillStyle = BG;
      ctx.fillRect(-s, -s, 2 * s, 2 * s);
      ctx.lineCap = 'round';
      // casings first, so the bright ribbons read as continuous bands over a dark gap
      ctx.strokeStyle = CASING;
      ctx.lineWidth = s * 0.34;
      for (const [a, b] of pairs) ribbon(ctx, a, b, s, pull);
      pairs.forEach(([a, b], i) => {
        ctx.strokeStyle = RIBBONS[i % RIBBONS.length];
        ctx.lineWidth = s * 0.22;
        ribbon(ctx, a, b, s, pull);
        ctx.strokeStyle = 'rgba(255,255,255,0.22)';
        ctx.lineWidth = s * 0.05;
        ribbon(ctx, a, b, s, pull);
      });
    },
  };
}

export const weave: HexTileset = {
  key: 'weave',
  name: 'Weave',
  blurb: 'A hexagonal Truchet — every edge is a connector so any tile meets any tile; three ways of pairing the six exits interlace into endless knotwork.',
  background: BG,
  prototypes: [
    weaveTile('corners', [[0, 1], [2, 3], [4, 5]], 0.32, 1.4),
    weaveTile('skip', [[0, 2], [1, 4], [3, 5]], 0.5, 1.1),
    weaveTile('through', [[0, 3], [1, 4], [2, 5]], 0.62, 0.7),
  ],
};
