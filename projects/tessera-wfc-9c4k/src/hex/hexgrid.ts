// The hexagonal lattice algebra — the 2D square engine's edge-code scheme (../wfc/edges.ts)
// carried onto a six-neighbour hex grid. Everything the hex engine needs to know about geometry,
// adjacency and rotation lives here, and (like the square and cubic engines) it is the single
// source of truth the compiler, solver, renderer and proof lab all read.
//
// Coordinates. Cells use **axial** hex coordinates (q, r): uniform integer neighbour steps, no
// odd/even-row parity to special-case. A finite board is the rhombus q ∈ [0,W), r ∈ [0,H), laid
// out with **pointy-top** hexes:
//
//     pixel(q, r) = ( s·√3·(q + r/2),  s·1.5·r )      // s = circumradius (centre → vertex)
//
// Directions. The six neighbours are indexed **clockwise** from due-east, so `opposite(d)` is just
// `(d + 3) % 6` and a 60°-clockwise tile rotation is a pure cyclic shift of the edge array — the
// same invariant that makes the square engine's rotation sound, one more fold of symmetry.
//
//     0 E   1 SE   2 SW   3 W   4 NW   5 NE
//
// Edges. Each tile carries six edge codes read **clockwise** around its boundary. Two hexes that
// sit face-to-face share one physical edge traced in opposite senses, so they fit iff
//
//     edge(A, d) === reverse(edge(B, opposite(d)))
//
// exactly as in the square engine. With single-character (symmetric) codes the reverse is a no-op
// and `fits` collapses to equality; multi-character codes give genuinely directional seams.

export const E = 0;
export const SE = 1;
export const SW = 2;
export const W = 3;
export const NW = 4;
export const NE = 5;

export const DIRS6 = [E, SE, SW, W, NW, NE] as const;
export type Dir6 = (typeof DIRS6)[number];

export const DIR6_NAME: Record<Dir6, string> = {
  [E]: 'E',
  [SE]: 'SE',
  [SW]: 'SW',
  [W]: 'W',
  [NW]: 'NW',
  [NE]: 'NE',
};

/** Axial (dq, dr) step toward each neighbour direction. */
export const DELTA_AX: Record<Dir6, [number, number]> = {
  [E]: [1, 0],
  [SE]: [0, 1],
  [SW]: [-1, 1],
  [W]: [-1, 0],
  [NW]: [0, -1],
  [NE]: [1, -1],
};

export function opposite6(d: Dir6): Dir6 {
  return ((d + 3) % 6) as Dir6;
}

/** Single-bit flag for a direction, for compact 6-bit direction masks. */
export function dirBit6(d: Dir6): number {
  return 1 << d;
}

export function reverseCode(code: string): string {
  return code.length < 2 ? code : code.split('').reverse().join('');
}

/** A tile's six clockwise-read edge codes, indexed by {@link Dir6}. */
export type HexEdges = [string, string, string, string, string, string];

/**
 * Rotate a tile's edge codes 60° clockwise, `k` times. A pure cyclic shift (see header): the
 * feature that was on edge `d` moves to edge `d + 1`, so `out[d] = edges[(d - 1) mod 6]`.
 */
export function rotateHexEdges(edges: HexEdges, k: number): HexEdges {
  const steps = ((k % 6) + 6) % 6;
  let e = edges;
  for (let i = 0; i < steps; i++) {
    e = [e[5], e[0], e[1], e[2], e[3], e[4]];
  }
  return e;
}

/** Does tile A (edges `a`) accept tile B (edges `b`) as its neighbour in direction `d`? */
export function fits6(a: HexEdges, b: HexEdges, d: Dir6): boolean {
  return a[d] === reverseCode(b[opposite6(d)]);
}

// ---- geometry --------------------------------------------------------------

export const SQRT3 = Math.sqrt(3);

/** Centre pixel of cell (q, r) for circumradius `s` (before any board offset). */
export function hexCenter(q: number, r: number, s: number): [number, number] {
  return [s * SQRT3 * (q + r / 2), s * 1.5 * r];
}

/** The angle (radians, screen-space clockwise from +x) from a cell centre toward neighbour `d`. */
export function dirAngle(d: Dir6): number {
  return (d * Math.PI) / 3;
}

/** The six corner offsets of a pointy-top hex of circumradius `s`, centred at the origin. */
export function hexCorners(s: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < 6; i++) {
    const a = ((2 * i + 1) * Math.PI) / 6; // 30°, 90°, … 330°
    out.push([s * Math.cos(a), s * Math.sin(a)]);
  }
  return out;
}

/** Trace a pointy-top hexagon path of circumradius `s` centred at (cx, cy) into `ctx`. */
export function hexPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number): void {
  const corners = hexCorners(s);
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const [x, y] = corners[i];
    if (i === 0) ctx.moveTo(cx + x, cy + y);
    else ctx.lineTo(cx + x, cy + y);
  }
  ctx.closePath();
}

/** Midpoint of edge `d` (the seam toward neighbour `d`) at apothem distance, centred at origin. */
export function edgeMid(d: Dir6, s: number): [number, number] {
  const apothem = (s * SQRT3) / 2;
  const a = dirAngle(d);
  return [apothem * Math.cos(a), apothem * Math.sin(a)];
}
