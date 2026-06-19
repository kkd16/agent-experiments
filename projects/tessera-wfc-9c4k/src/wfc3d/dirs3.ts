// The 3D lattice algebra: six face directions on a cubic grid, their opposites, their integer
// offsets, and the permutation a 90°-clockwise rotation about the vertical (Y) axis induces on
// them. Tessera's 3D engine only ever rotates tiles about Y (the standard, and the only rotation
// that keeps "up" pointing up) — so this single permutation, plus the vertical-socket rotation
// tag in `sockets3.ts`, is the whole of the cube-group machinery the 3D solver needs.
//
// Axis convention (right-handed-ish screen space): +X east, +Y up, +Z south (toward the viewer
// in the default camera). Faces are indexed so `opposite(d) === d ^ 1` for the horizontal pairs
// and the vertical pair, which keeps the support-counter bookkeeping branch-free.

export const PX = 0; // +x  east
export const NX = 1; // -x  west
export const PZ = 2; // +z  south
export const NZ = 3; // -z  north
export const PY = 4; // +y  up   (top face)
export const NY = 5; // -y  down (bottom face)

export const DIRS3 = [PX, NX, PZ, NZ, PY, NY] as const;
export type Dir3 = (typeof DIRS3)[number];

/** The four horizontal faces (the ones a Y-rotation cycles); PY/NY are vertical. */
export const HORIZ = [PX, NX, PZ, NZ] as const;
export const VERT = [PY, NY] as const;

export const DIR3_NAME: Record<Dir3, string> = {
  [PX]: '+X',
  [NX]: '-X',
  [PZ]: '+Z',
  [NZ]: '-Z',
  [PY]: 'up',
  [NY]: 'down',
};

/** Integer (dx, dy, dz) step for each face direction. */
export const DELTA3: Record<Dir3, [number, number, number]> = {
  [PX]: [1, 0, 0],
  [NX]: [-1, 0, 0],
  [PZ]: [0, 0, 1],
  [NZ]: [0, 0, -1],
  [PY]: [0, 1, 0],
  [NY]: [0, -1, 0],
};

export function opposite3(d: Dir3): Dir3 {
  // PX(0)<->NX(1), PZ(2)<->NZ(3), PY(4)<->NY(5) — opposite is the partner in each pair.
  return (d ^ 1) as Dir3;
}

/**
 * Where each face ends up after one 90°-clockwise rotation about +Y (viewed from above, +Z
 * pointing toward the viewer). A vector rotates east→south→west→north→east, so the geometry
 * that *was* on PX is now on PZ, etc. `ROT_CW[d]` = the world face that prototype-face `d` maps
 * to. The vertical faces are fixed (only their socket's rotation tag advances).
 */
export const ROT_CW: Record<Dir3, Dir3> = {
  [PX]: PZ,
  [PZ]: NX,
  [NX]: NZ,
  [NZ]: PX,
  [PY]: PY,
  [NY]: NY,
};

/** Inverse of {@link ROT_CW}: the prototype face that supplies world-face `d` after a CW step. */
export const ROT_CW_SRC: Record<Dir3, Dir3> = {
  [PZ]: PX,
  [NX]: PZ,
  [NZ]: NX,
  [PX]: NZ,
  [PY]: PY,
  [NY]: NY,
};
