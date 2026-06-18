// The socket / edge-code algebra that lets procedurally-drawn tiles connect correctly,
// including under rotation.
//
// Convention: a tile's four edges are read CLOCKWISE around its boundary:
//   N (top)    left  -> right
//   E (right)  top   -> bottom
//   S (bottom) right -> left
//   W (left)   bottom-> top
//
// Two tiles A and B are adjacent when B sits in direction `d` from A. Their touching edges are
// the SAME physical segment traced in opposite directions, so they fit iff
//
//     edge(A, d) === reverse(edge(B, opposite(d)))
//
// Rotating a tile 90° clockwise is then just a cyclic shift of its edge array — no per-edge
// reversal needed — because every edge is read clockwise. That single invariant is what makes
// the whole rotation/adjacency machinery correct.

/** Direction indices. The order matters: opposite(d) === (d + 2) % 4. */
export const N = 0;
export const E = 1;
export const S = 2;
export const W = 3;
export const DIRS = [N, E, S, W] as const;
export type Dir = (typeof DIRS)[number];

/** (dx, dy) offset for each direction, with +y pointing down (screen space). */
export const DELTA: Record<Dir, [number, number]> = {
  [N]: [0, -1],
  [E]: [1, 0],
  [S]: [0, 1],
  [W]: [-1, 0],
};

export const DIR_NAME: Record<Dir, string> = { [N]: 'N', [E]: 'E', [S]: 'S', [W]: 'W' };

export function opposite(d: Dir): Dir {
  return ((d + 2) % 4) as Dir;
}

export function reverseCode(code: string): string {
  return code.split('').reverse().join('');
}

/** Edge codes for a tile, in [N, E, S, W] order. */
export type Edges = [string, string, string, string];

/** Rotate a tile's edge codes 90° clockwise, k times. Pure cyclic shift (see header note). */
export function rotateEdges(edges: Edges, k: number): Edges {
  const steps = ((k % 4) + 4) % 4;
  let e = edges;
  for (let i = 0; i < steps; i++) {
    // 90° CW: old W -> N, old N -> E, old E -> S, old S -> W
    e = [e[W], e[N], e[E], e[S]];
  }
  return e;
}

/** Does tile A (edges `a`) accept tile B (edges `b`) as its neighbour in direction `d`? */
export function fits(a: Edges, b: Edges, d: Dir): boolean {
  return a[d] === reverseCode(b[opposite(d)]);
}
