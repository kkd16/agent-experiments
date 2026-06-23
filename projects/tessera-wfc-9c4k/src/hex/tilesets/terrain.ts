// Hex Terrain — grass meets water with a smooth, curved coastline. Every edge is either grass `g`
// or water `w` (single-character, so a grass edge fits a grass edge and water fits water), and the
// coast prototypes carry a contiguous run of water edges drawn as a rounded inlet, so collapsed
// boards grow coherent continents and lakes with bays and headlands.

import type { HexEdges, HexPrototype, HexTileset } from '../types_hex';
import { vertex } from './draw';

const SEA = '#2b6ea3';
const SEA_DEEP = '#1d5180';
const FOAM = '#bfe3f2';
const GRASS = '#5a8f43';
const GRASS_HI = '#6fa653';
const SAND = '#d9c89a';

function paintGrass(ctx: CanvasRenderingContext2D, s: number): void {
  ctx.fillStyle = GRASS;
  ctx.fillRect(-s, -s, 2 * s, 2 * s);
  // a little tonal speckle so big grass fields aren't flat
  ctx.fillStyle = GRASS_HI;
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.6;
    const rr = s * 0.4;
    ctx.beginPath();
    ctx.arc(Math.cos(a) * rr, Math.sin(a) * rr * 0.7, s * 0.12, 0, Math.PI * 2);
    ctx.fill();
  }
}

function paintSea(ctx: CanvasRenderingContext2D, s: number): void {
  const g = ctx.createRadialGradient(0, -s * 0.2, s * 0.1, 0, 0, s * 1.2);
  g.addColorStop(0, SEA);
  g.addColorStop(1, SEA_DEEP);
  ctx.fillStyle = g;
  ctx.fillRect(-s, -s, 2 * s, 2 * s);
  ctx.strokeStyle = 'rgba(255,255,255,0.16)';
  ctx.lineWidth = s * 0.06;
  for (let i = -1; i <= 1; i++) {
    ctx.beginPath();
    ctx.moveTo(-s * 0.6, i * s * 0.45);
    ctx.quadraticCurveTo(0, i * s * 0.45 - s * 0.18, s * 0.6, i * s * 0.45);
    ctx.stroke();
  }
}

/** A coast tile: water on the contiguous edges 0 … k-1, grass elsewhere, with a curved shoreline. */
function coast(k: number, weight: number): HexPrototype {
  const edges = Array.from({ length: 6 }, (_, d) => (d < k ? 'w' : 'g')) as HexEdges;
  return {
    name: `coast${k}`,
    edges,
    rotations: 6,
    weight,
    draw: (ctx, s) => {
      paintGrass(ctx, s);
      // water-side rim corners: V5, V0, V1, … V(k-1)  (the corners bordering the water edges)
      const rim: Array<[number, number]> = [vertex(5, s)];
      for (let i = 0; i < k; i++) rim.push(vertex(i, s));
      const start = rim[0]; // V5  (land → water crossing)
      const end = rim[rim.length - 1]; // V(k-1)  (water → land crossing)
      // coastline control point: bow the chord toward the land centroid
      let lx = 0;
      let ly = 0;
      for (let d = k; d < 6; d++) {
        const a = (d * Math.PI) / 3;
        lx += Math.cos(a);
        ly += Math.sin(a);
      }
      const ll = Math.hypot(lx, ly) || 1;
      const cmx = (start[0] + end[0]) / 2 + (lx / ll) * s * 0.5;
      const cmy = (start[1] + end[1]) / 2 + (ly / ll) * s * 0.5;

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(start[0], start[1]);
      for (let i = 1; i < rim.length; i++) ctx.lineTo(rim[i][0], rim[i][1]);
      ctx.quadraticCurveTo(cmx, cmy, start[0], start[1]); // shoreline back across
      ctx.closePath();
      ctx.clip();
      paintSea(ctx, s);
      ctx.restore();

      // sand + foam along the shoreline
      ctx.lineCap = 'round';
      ctx.strokeStyle = SAND;
      ctx.lineWidth = s * 0.18;
      ctx.beginPath();
      ctx.moveTo(end[0], end[1]);
      ctx.quadraticCurveTo(cmx, cmy, start[0], start[1]);
      ctx.stroke();
      ctx.strokeStyle = FOAM;
      ctx.lineWidth = s * 0.07;
      ctx.beginPath();
      ctx.moveTo(end[0], end[1]);
      ctx.quadraticCurveTo(cmx, cmy, start[0], start[1]);
      ctx.stroke();
    },
  };
}

export const terrain: HexTileset = {
  key: 'terrain',
  name: 'Terrain',
  blurb: 'Grass and water with rounded coastlines — continents, lakes, bays and headlands grow from six-way edge agreement.',
  background: '#5a8f43',
  prototypes: [
    {
      name: 'land',
      edges: ['g', 'g', 'g', 'g', 'g', 'g'],
      rotations: 1,
      weight: 2.4,
      draw: (ctx, s) => paintGrass(ctx, s),
    },
    {
      name: 'sea',
      edges: ['w', 'w', 'w', 'w', 'w', 'w'],
      rotations: 1,
      weight: 2.4,
      draw: (ctx, s) => paintSea(ctx, s),
    },
    coast(1, 1.1),
    coast(2, 1.3),
    coast(3, 1.0),
    coast(4, 0.7),
    coast(5, 0.5),
  ],
};
