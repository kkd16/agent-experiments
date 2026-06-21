// The curated roster of tilesets the infinite engine offers.
//
// Two conditions make a set "boundless-safe":
//   1. it has a ground tile (a variant adjacency-compatible with itself in all four directions),
//      which keeps every seam / chunk solve satisfiable, and
//   2. a chunk solved against an arbitrary pinned border practically never contradicts — i.e. the
//      tileset is permissive enough that its open edges can always terminate inside a chunk.
//
// (1) is structural and checked by `InfiniteWorld.hasGround`. (2) is empirical and verified by the
// Infinite Proof Lab (infinite/tests_inf.ts), which solves thousands of chunks per set and asserts
// the fallback count is exactly zero. `cables` passes (1) but fails (2) — its wires have no caps, so
// a random seam strands a wire that cannot be completed inside the chunk — so it is intentionally
// omitted. This roster is the set proven to grow an everywhere-valid infinite plane.

export const INFINITE_TILESET_KEYS = ['terrain', 'knots', 'circuit', 'truchet', 'rails', 'maze'] as const;

export type InfiniteTilesetKey = (typeof INFINITE_TILESET_KEYS)[number];

export function isInfiniteKey(key: string): key is InfiniteTilesetKey {
  return (INFINITE_TILESET_KEYS as readonly string[]).includes(key);
}
