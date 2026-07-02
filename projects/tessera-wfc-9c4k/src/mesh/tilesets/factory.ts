// A compact builder for connection-style mesh tilesets. Every set here shares the same skeleton —
// a two-tone ground, then one or more coloured lanes joining the open edges — so a set is just a
// palette, a lane-style function keyed by socket character, and a short list of canonical tiles
// (the compiler expands their rotations). This is why the mesh engine can ship a family of visually
// distinct tilesets in a few dozen lines each.

import { mix, type MeshProto, type MeshTileset, type Palette, type Sym } from '../meshtypes';
import { drawLane, lanesBySocket, paintGround } from './paint';

// The lane style a set hands the shared painter (mirrors the structural `Lane` in paint.ts).
export type Lane = { color: [number, number, number]; width: number; casing?: [number, number, number]; dash?: [number, number, number]; dashWidth?: number };

export type ProtoSpec = {
  name: string;
  sockets: [string, string, string, string];
  symmetry: Sym;
  weight?: number;
};

export type ConnectionSpec = {
  key: string;
  name: string;
  blurb: string;
  background: string;
  palette: Palette;
  laneFor: (code: string, pal: Palette) => Lane;
  protos: ProtoSpec[];
};

export function makeConnectionSet(spec: ConnectionSpec): MeshTileset {
  const paint: MeshProto['paint'] = (ctx, g, sockets, pal) => {
    paintGround(ctx, g, pal);
    for (const [code, slots] of lanesBySocket(sockets, '.')) drawLane(ctx, g, slots, spec.laneFor(code, pal));
  };
  const prototypes: MeshProto[] = spec.protos.map((p) => {
    const open = p.sockets.filter((s) => s !== '.').length;
    const code = p.sockets.find((s) => s !== '.');
    const laneColor = code ? spec.laneFor(code, spec.palette).color : spec.palette.bg;
    const tint = open === 0 ? spec.palette.bg : mix(spec.palette.bg, laneColor, Math.min(0.85, 0.28 + 0.12 * open));
    return { name: p.name, sockets: p.sockets, symmetry: p.symmetry, weight: p.weight, tint, paint };
  });
  return {
    key: spec.key,
    name: spec.name,
    blurb: spec.blurb,
    background: spec.background,
    palette: spec.palette,
    emptyEdge: '.',
    prototypes,
  };
}
