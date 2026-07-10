// The iconic Alur–Dill picture: for two clocks, the clock plane carved into
// regions — corner POINTS (both fractions 0), open SEGMENTS on the grid and
// diagonal lines (one fraction 0, or the two fractions equal), and open
// TRIANGLES (the fractional order strict). Every primitive below lies entirely
// inside one region and carries an interior REPRESENTATIVE point, so the view
// colours it by running the very same `regionOf` used everywhere else — the
// drawing and the theory can never drift apart.

export type RegionPrim =
  | { kind: 'tri'; pts: [number, number][]; rep: [number, number] }
  | { kind: 'seg'; a: [number, number]; b: [number, number]; rep: [number, number] }
  | { kind: 'pt'; p: [number, number]; rep: [number, number] }

export interface RegionMap {
  prims: RegionPrim[]
  mx: number
  my: number
  /** true when the map is applicable (exactly two clocks) */
  ok: boolean
}

/**
 * Build the region partition of `[0,mx] × [0,my]` (the part where both clocks
 * are still ≤ their max — beyond that a clock's exact value is irrelevant and
 * the picture would only add unbounded strips). Uses `mx = Mx+1`, `my = My+1`
 * so the boundary lines `x=Mx`, `y=My` are included as grid lines.
 */
export function buildRegionMap(clocks: string[], max: number[]): RegionMap {
  if (clocks.length !== 2) return { prims: [], mx: 0, my: 0, ok: false }
  const mx = Math.min(max[0], 8) + 1
  const my = Math.min(max[1], 8) + 1
  const prims: RegionPrim[] = []

  // 2-D triangles + the diagonal segment, per open unit cell (i,i+1)×(j,j+1)
  for (let i = 0; i < mx; i++) {
    for (let j = 0; j < my; j++) {
      // lower triangle: frac_x > frac_y
      prims.push({
        kind: 'tri',
        pts: [
          [i, j],
          [i + 1, j],
          [i + 1, j + 1],
        ],
        rep: [i + 0.66, j + 0.33],
      })
      // upper triangle: frac_x < frac_y
      prims.push({
        kind: 'tri',
        pts: [
          [i, j],
          [i, j + 1],
          [i + 1, j + 1],
        ],
        rep: [i + 0.33, j + 0.66],
      })
      // diagonal open segment: frac_x = frac_y (both > 0)
      prims.push({ kind: 'seg', a: [i, j], b: [i + 1, j + 1], rep: [i + 0.5, j + 0.5] })
    }
  }

  // horizontal open segments (frac_y = 0, frac_x > 0) on every grid line y = j
  for (let j = 0; j <= my; j++)
    for (let i = 0; i < mx; i++) prims.push({ kind: 'seg', a: [i, j], b: [i + 1, j], rep: [i + 0.5, j] })

  // vertical open segments (frac_x = 0, frac_y > 0) on every grid line x = i
  for (let i = 0; i <= mx; i++)
    for (let j = 0; j < my; j++) prims.push({ kind: 'seg', a: [i, j], b: [i, j + 1], rep: [i, j + 0.5] })

  // corner points (both fractions 0)
  for (let i = 0; i <= mx; i++) for (let j = 0; j <= my; j++) prims.push({ kind: 'pt', p: [i, j], rep: [i, j] })

  return { prims, mx, my, ok: true }
}
