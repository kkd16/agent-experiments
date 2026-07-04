// Orographic precipitation. Real rain isn't uniform: prevailing winds carry moist
// air off the sea, and where that air is forced up over relief it cools, sheds its
// water on the windward slope, and descends warm and dry on the far side — the rain
// shadow that puts deserts behind mountain ranges.
//
// We model it as a single advection sweep across the mesh in wind order:
//   1. Sort all regions by their position projected onto the wind vector (upwind
//      first, downwind last) so every cell is processed after the air that feeds it.
//   2. Water cells (sea + lakes) are evaporation sources: humidity resets to 1.
//   3. Each land cell pulls humidity from its upwind neighbours, rains out a fraction
//      that grows with the upslope it forces the air over (and with cold air's lower
//      capacity), and passes the drier remainder downwind.
//
// The result feeds both rivers (rain-heavy cells spawn bigger flows) and biomes.

import type { Mesh, WorldParams } from './types'

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

/**
 * @param water 1 for cells that supply moisture (ocean + lakes), else 0.
 * @returns precipitation per region, normalised to 0..1 over the land cells.
 */
export function computePrecipitation(
  mesh: Mesh,
  params: WorldParams,
  elevation: Float64Array,
  water: Uint8Array,
  temperature: Float64Array,
): Float64Array {
  const n = mesh.numRegions
  const strength = clamp01(params.orographic)
  // Wind unit vector from the bearing (0° blows toward +x).
  const a = (params.windAngle * Math.PI) / 180
  const wx = Math.cos(a)
  const wy = Math.sin(a)

  // Process order: upwind → downwind.
  const proj = new Float64Array(n)
  const order: number[] = []
  for (let r = 0; r < mesh.numSolid; r++) {
    proj[r] = mesh.px[r] * wx + mesh.py[r] * wy
    order.push(r)
  }
  order.sort((i, j) => proj[i] - proj[j])

  const humidity = new Float64Array(n)
  const precip = new Float64Array(n)
  let maxP = 0

  for (const r of order) {
    if (water[r]) {
      humidity[r] = 1
      continue
    }
    // Gather humidity + mean elevation from upwind neighbours.
    let inSum = 0
    let inW = 0
    let elevSum = 0
    let elevW = 0
    for (const j of mesh.neighbors[r]) {
      let dx = mesh.px[r] - mesh.px[j]
      let dy = mesh.py[r] - mesh.py[j]
      const dl = Math.hypot(dx, dy) || 1
      dx /= dl
      dy /= dl
      const align = dx * wx + dy * wy // >0 ⇒ j is upwind of r
      if (align <= 0) continue
      inSum += humidity[j] * align
      inW += align
      elevSum += elevation[j] * align
      elevW += align
    }
    // No upwind neighbour (windward map edge): a little maritime baseline.
    const incoming = inW > 0 ? inSum / inW : 0.35
    const upElev = elevW > 0 ? elevSum / elevW : elevation[r]

    // Upslope forces air up ⇒ heavier rain. Cold air holds less ⇒ rains sooner.
    const upslope = Math.max(0, elevation[r] - upElev)
    const cold = 1 - temperature[r] * 0.45
    const baseFrac = 0.06 + 0.12 * cold
    const oroFrac = strength * (upslope * 9 + 0.05) * cold
    const frac = clamp01(baseFrac + oroFrac)

    const rained = incoming * frac
    precip[r] = rained
    // The descending, dried-out air carries the remainder downwind, losing a
    // little more so distant interiors trend arid.
    humidity[r] = clamp01((incoming - rained) * 0.985)
    if (rained > maxP) maxP = rained
  }

  // Normalise land precip to 0..1 for stable downstream use.
  const inv = maxP > 0 ? 1 / maxP : 0
  for (let r = 0; r < mesh.numSolid; r++) {
    if (!water[r]) precip[r] = clamp01(Math.sqrt(precip[r] * inv))
  }
  return precip
}
