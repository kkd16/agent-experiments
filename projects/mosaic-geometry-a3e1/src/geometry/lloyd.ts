import type { Point, Rect } from './types'
import { centroid } from './polygon'
import { voronoiCells } from './voronoi'
import { dist } from './vector'

// One step of Lloyd's relaxation: move every site to the centroid of its Voronoi
// cell. Iterating this converges to a Centroidal Voronoi Tessellation — the
// organic, evenly-spaced "soap bubble" pattern. We return both the new sites and
// the mean displacement so the UI can show convergence and stop when it stalls.

export interface LloydResult {
  sites: Point[]
  movement: number // mean distance each site moved this step
}

export function lloydStep(sites: Point[], clip: Rect): LloydResult {
  if (sites.length === 0) return { sites, movement: 0 }
  const cells = voronoiCells(sites, clip)
  const next: Point[] = sites.map((s) => ({ ...s }))
  let total = 0
  for (const cell of cells) {
    if (cell.polygon.length < 3) continue
    const c = centroid(cell.polygon)
    total += dist(sites[cell.site], c)
    next[cell.site] = c
  }
  return { sites: next, movement: total / sites.length }
}
