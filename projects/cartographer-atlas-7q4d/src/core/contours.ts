// Iso-elevation contour lines by marching triangles over the Delaunay mesh.
//
// The elevation field is sampled at the region sites (the Delaunay vertices). For a
// contour level L, each triangle is classified by how many of its three corners sit
// above L; if the level passes through the triangle it clips exactly two edges, and
// we emit the segment joining those two crossing points. Linear interpolation along
// each edge places the crossings, so the contours are smooth and watertight.

import type { WorldMap } from './types'

export interface ContourSeg {
  x1: number
  y1: number
  x2: number
  y2: number
  /** 0..1 elevation of the line; the renderer thins high lines. */
  level: number
}

/** Default contour levels: evenly spaced bands above sea level. */
export function defaultLevels(seaLevel: number, count = 6): number[] {
  const out: number[] = []
  const span = 1 - seaLevel
  for (let i = 1; i <= count; i++) out.push(seaLevel + (span * i) / (count + 1))
  return out
}

export function computeContours(world: WorldMap, levels: number[]): ContourSeg[] {
  const { mesh, elevation, ocean } = world
  const tri = mesh.triangles
  const px = mesh.px
  const py = mesh.py
  const segs: ContourSeg[] = []
  const nTri = tri.length / 3

  for (let t = 0; t < nTri; t++) {
    const a = tri[3 * t]
    const b = tri[3 * t + 1]
    const c = tri[3 * t + 2]
    // Skip triangles that are entirely open ocean — no useful land contour there.
    if (ocean[a] && ocean[b] && ocean[c]) continue
    const ea = elevation[a]
    const eb = elevation[b]
    const ec = elevation[c]

    for (const L of levels) {
      // Interpolate a crossing on edge (p,q) if the level lies strictly between them.
      const cross: Array<[number, number]> = []
      const edge = (i: number, j: number, ei: number, ej: number): void => {
        if ((ei < L && ej >= L) || (ej < L && ei >= L)) {
          const f = (L - ei) / (ej - ei || 1e-9)
          cross.push([px[i] + (px[j] - px[i]) * f, py[i] + (py[j] - py[i]) * f])
        }
      }
      edge(a, b, ea, eb)
      edge(b, c, eb, ec)
      edge(c, a, ec, ea)
      if (cross.length === 2) {
        segs.push({ x1: cross[0][0], y1: cross[0][1], x2: cross[1][0], y2: cross[1][1], level: L })
      }
    }
  }
  return segs
}
