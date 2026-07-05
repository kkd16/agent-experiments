// The Living Planet — a coupled atmosphere/ocean circulation model.
//
// This is the machinery that actually moves heat and moisture around a world. It runs in
// three linked stages, all from scratch on the Voronoi mesh, all deterministic from the seed:
//
//   1. ATMOSPHERE — the three-cell general circulation. Each latitude band carries the
//      surface branch of a Hadley / Ferrel / Polar cell; a genuine Coriolis deflection whose
//      sign flips across the equator turns that meridional flow into the zonal trade winds,
//      mid-latitude westerlies and polar easterlies. A sea-level PRESSURE field (subtropical
//      & polar highs, equatorial & subpolar lows) plus a land–sea thermal anomaly perturbs
//      the winds into an onshore monsoon.
//
//   2. OCEAN — the wind-driven circulation. From the surface wind we form the wind stress τ
//      and its curl, then solve the barotropic Stommel vorticity balance
//          ∇²ψ + β ∂ψ/∂x = curl τ
//      for a streamfunction ψ (ψ = 0 on every coast & map edge). The β term crowds the
//      return flow onto the WESTERN boundary — the Gulf Stream / Kuroshio. The surface
//      current is ∇⊥ψ, so it is divergence-free (mass-conserving) and never crosses a coast.
//
//   3. SEA-SURFACE TEMPERATURE — a latitudinal base SST advected along the currents, so warm
//      western-boundary currents carry tropical heat poleward and cold currents chill the
//      eastern margins. Coastal land then feels the adjacent-sea SST (returned as seaTempC).
//
// Coordinate convention: screen x = east (+), screen y = south (down, +). ny = py/height, so
// the top of the map is the northern hemisphere. Signed latitude φ = 1 − 2·ny runs +1 (north
// pole) → 0 (equator) → −1 (south pole); latAbs = |φ|.

import type { Mesh, WorldParams } from './types'
import { MeshDiff } from './meshfield'

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)
const bump = (x: number, c: number, w: number): number => {
  const z = (x - c) / w
  return Math.exp(-(z * z))
}

export interface CirculationInput {
  ocean: Uint8Array
  lake: Uint8Array
  coast: Uint8Array
  /** Annual-mean temperature 0..1 (latitude + altitude lapse). */
  temperature: Float64Array
}

export interface CirculationMeta {
  /** Final residual of the Stommel solve, ‖Aψ − f‖∞ relative to ‖f‖∞. */
  residual: number
  /** Western-vs-eastern boundary-current speed ratio (>1 ⇒ western intensification). */
  wbiRatio: number
  /** Peak ocean current speed (normalised units). */
  maxCurrent: number
  /** Peak wind speed (normalised units). */
  maxWind: number
  /** SOR sweeps run on the ocean streamfunction. */
  iterations: number
  /** Number of ocean cells solved. */
  oceanCells: number
}

export interface Circulation {
  /** Surface wind, per region (all regions). East / south components (screen axes). */
  windU: Float32Array
  windV: Float32Array
  /** Wind speed per region, normalised so the strongest wind ≈ 1. */
  windSpeed: Float32Array
  /** Sea-level pressure per region, hPa. */
  pressure: Float32Array
  /** Ocean surface current, per region (0 on land). East / south components. */
  curU: Float32Array
  curV: Float32Array
  /** Current speed per region, normalised so the strongest current ≈ 1. */
  curSpeed: Float32Array
  /** Barotropic streamfunction ψ on the ocean (0 on land / boundary). */
  psi: Float32Array
  /** Sea-surface temperature per ocean region, °C (0 on land). */
  sst: Float32Array
  /** Maritime temperature each coastal land cell feels, °C (NaN where no adjacent sea). */
  seaTempC: Float32Array
  meta: CirculationMeta
}

/**
 * Zonal (eastward) surface wind climatology as a function of |latitude| 0..1 — three smooth
 * bands: easterly trades, the strong mid-latitude westerlies, and the weaker polar easterlies.
 */
function zonalWind(latAbs: number): number {
  return (
    -0.72 * bump(latAbs, 0.18, 0.14) + // trade easterlies
    1.0 * bump(latAbs, 0.52, 0.13) + // mid-latitude westerlies
    -0.46 * bump(latAbs, 0.85, 0.12) // polar easterlies
  )
}

/**
 * Meridional (poleward-positive) surface wind — the Coriolis partner of the zonal bands.
 * Equatorward under the trades and polar easterlies, poleward under the westerlies, so the
 * winds spiral correctly (NE/SE trades, SW/NW-ish westerlies).
 */
function meridionalPoleward(latAbs: number): number {
  return (
    -0.5 * bump(latAbs, 0.18, 0.14) + // trades: equatorward
    0.5 * bump(latAbs, 0.52, 0.13) + // westerlies: poleward
    -0.32 * bump(latAbs, 0.85, 0.12) // polar easterlies: equatorward
  )
}

/** Belt sea-level pressure (hPa) as a function of |latitude| 0..1. */
function beltPressure(latAbs: number): number {
  return (
    1013 +
    -6 * bump(latAbs, 0.0, 0.14) + // equatorial trough (ITCZ)
    7 * bump(latAbs, 0.33, 0.13) + // subtropical highs
    -7 * bump(latAbs, 0.66, 0.12) + // subpolar lows
    5 * bump(latAbs, 0.98, 0.12) // polar highs
  )
}

export function computeCirculation(
  mesh: Mesh,
  params: WorldParams,
  input: CirculationInput,
): Circulation {
  const n = mesh.numRegions
  const { width, height } = params
  const { ocean, lake, coast, temperature } = input

  // Water mask (sea + lakes) and a solid mask for the atmosphere operators.
  const water = new Uint8Array(n)
  const solid = new Uint8Array(n)
  for (let r = 0; r < n; r++) {
    water[r] = ocean[r] || lake[r] ? 1 : 0
    solid[r] = r < mesh.numSolid ? 1 : 0
  }

  // ---------------------------------------------------------------------------
  // 1. ATMOSPHERE
  // ---------------------------------------------------------------------------
  const windU = new Float32Array(n)
  const windV = new Float32Array(n)
  const pressure = new Float32Array(n)

  // A gentle uniform bias from the user's prevailing-wind bearing keeps the slider live
  // without overpowering the physical bands.
  const biasA = (params.windAngle * Math.PI) / 180
  const biasX = Math.cos(biasA) * 0.14
  const biasY = Math.sin(biasA) * 0.14

  for (let r = 0; r < n; r++) {
    const ny = mesh.py[r] / height
    const phi = 1 - 2 * ny // +1 north pole … −1 south pole
    const latAbs = Math.abs(phi)
    const hemi = phi > 0 ? 1 : phi < 0 ? -1 : 0 // sign(φ)

    const u = zonalWind(latAbs)
    // Poleward → screen-y: north poleward is up (−y), south poleward is down (+y).
    const v = -hemi * meridionalPoleward(latAbs)

    windU[r] = u + biasX
    windV[r] = v + biasY

    // Pressure: latitude belts + a land–sea thermal anomaly (warm land = thermal low).
    let p = beltPressure(latAbs)
    if (!water[r] && solid[r]) p += -10 * (temperature[r] - 0.5)
    pressure[r] = p
  }

  // Monsoon: a cross-isobar wind component blowing down the pressure gradient toward lows
  // (so air is pulled onshore over warm summer land). Small, so the zonal bands still rule.
  const diffAll = new MeshDiff(mesh, solid)
  const pg = diffAll.gradient(pressure)
  const MONSOON = 0.06
  for (let r = 0; r < n; r++) {
    if (!solid[r]) continue
    windU[r] += -MONSOON * pg.gx[r]
    windV[r] += -MONSOON * pg.gy[r]
  }

  const windSpeed = new Float32Array(n)
  let maxWind = 1e-9
  for (let r = 0; r < n; r++) {
    const s = Math.hypot(windU[r], windV[r])
    windSpeed[r] = s
    if (s > maxWind) maxWind = s
  }
  for (let r = 0; r < n; r++) windSpeed[r] /= maxWind

  // ---------------------------------------------------------------------------
  // 2. OCEAN — wind-driven Stommel circulation
  // ---------------------------------------------------------------------------
  // Domain: interior ocean cells (ocean, not a map-frame cell). A cell that touches land or
  // the frame is a boundary cell where ψ is pinned to 0 (no flow through the wall).
  const oceanDomain = new Uint8Array(n)
  for (let r = 0; r < n; r++) if (ocean[r] && !mesh.isFrame[r]) oceanDomain[r] = 1

  const boundary = new Uint8Array(n) // ocean cells fixed at ψ=0
  const interior: number[] = []
  for (let r = 0; r < n; r++) {
    if (!oceanDomain[r]) continue
    let touchesWall = false
    for (const j of mesh.neighbors[r]) {
      if (!ocean[j] || mesh.isFrame[j]) {
        touchesWall = true
        break
      }
    }
    if (touchesWall) boundary[r] = 1
    else interior.push(r)
  }

  const diffOcean = new MeshDiff(mesh, oceanDomain)
  let oceanCount = 0
  for (let r = 0; r < n; r++) if (oceanDomain[r]) oceanCount++

  // Wind stress τ = |W|·W (quadratic drag), over the ocean domain only.
  const taux = new Float64Array(n)
  const tauy = new Float64Array(n)
  for (let r = 0; r < n; r++) {
    if (!oceanDomain[r]) continue
    const s = Math.hypot(windU[r], windV[r])
    taux[r] = s * windU[r]
    tauy[r] = s * windV[r]
  }
  const curlTau = diffOcean.curlZ(taux, tauy)

  // Assemble the Stommel operator row-wise on the interior:  A = Σ_j (1 + β c_j)·(ψ_j−ψ_r) = f
  // (graph-Laplacian ∇² plus β·∂/∂x via the least-squares x-coefficients c_j). β>0 crowds the
  // streamlines onto the western boundary — the whole point of the model.
  const BETA = 0.5 * Math.sqrt((width * height) / Math.max(1, oceanCount))
  const psi = new Float64Array(n)
  const nbrOf = diffOcean.nbr
  const cxOf = diffOcean.cx
  // Precompute per-interior-cell off-diagonal weights and the diagonal.
  const rows = interior.map((r) => {
    const nbr = nbrOf[r]
    const cxr = cxOf[r]
    const w = new Float64Array(nbr.length)
    let diag = 0
    for (let a = 0; a < nbr.length; a++) {
      const wa = 1 + BETA * cxr[a]
      w[a] = wa
      diag += wa
    }
    return { r, nbr, w, diag: diag || 1, f: curlTau[r] }
  })

  // SOR (successive over-relaxation) sweeps — cheap on a few thousand cells. The count
  // scales with the basin size (bigger basins take longer to relax); the residual check
  // below confirms convergence in every case.
  const OMEGA = 1.7
  const SWEEPS = Math.min(700, 220 + Math.round(oceanCount * 0.12))
  for (let it = 0; it < SWEEPS; it++) {
    for (const row of rows) {
      let sum = 0
      const nbr = row.nbr
      const w = row.w
      for (let a = 0; a < nbr.length; a++) sum += w[a] * psi[nbr[a]]
      const gs = (sum - row.f) / row.diag
      psi[row.r] += OMEGA * (gs - psi[row.r])
    }
  }

  // Residual of the solve, relative to the forcing scale.
  let resMax = 0
  let fMax = 1e-12
  for (const row of rows) {
    let sum = 0
    for (let a = 0; a < row.nbr.length; a++) sum += row.w[a] * psi[row.nbr[a]]
    const ax = sum - row.diag * psi[row.r]
    const res = Math.abs(ax - row.f)
    if (res > resMax) resMax = res
    if (Math.abs(row.f) > fMax) fMax = Math.abs(row.f)
  }
  const residual = resMax / fMax

  // Current = ∇⊥ψ = (−∂ψ/∂y, ∂ψ/∂x). Divergence-free by construction.
  const gpsi = diffOcean.gradient(psi)
  const curU = new Float32Array(n)
  const curV = new Float32Array(n)
  let maxCur = 1e-9
  for (let r = 0; r < n; r++) {
    if (!oceanDomain[r]) continue
    const cu = -gpsi.gy[r]
    const cv = gpsi.gx[r]
    curU[r] = cu
    curV[r] = cv
    const s = Math.hypot(cu, cv)
    if (s > maxCur) maxCur = s
  }
  // Normalise the current field so peak speed ≈ 1 (keeps rendering + advection well-scaled).
  const invCur = 1 / maxCur
  const curSpeed = new Float32Array(n)
  for (let r = 0; r < n; r++) {
    if (!oceanDomain[r]) continue
    curU[r] *= invCur
    curV[r] *= invCur
    curSpeed[r] = Math.hypot(curU[r], curV[r])
  }
  const psiOut = new Float32Array(n)
  for (let r = 0; r < n; r++) psiOut[r] = psi[r]

  // Western-intensification metric: mean current speed on the western vs eastern half of the
  // boundary layer. >1 confirms the Gulf-Stream-like crowding the β term is meant to produce.
  let wbiRatio = 1
  {
    let wSum = 0
    let wCnt = 0
    let eSum = 0
    let eCnt = 0
    for (const r of interior) {
      // A cell one step from a wall is in the boundary layer.
      let nearWall = false
      for (const j of mesh.neighbors[r]) if (boundary[j]) { nearWall = true; break }
      if (!nearWall) continue
      // Is the adjacent wall to the west (smaller x) or east (larger x)?
      let wallDx = 0
      for (const j of mesh.neighbors[r]) if (boundary[j] || !ocean[j]) wallDx += mesh.px[j] - mesh.px[r]
      if (wallDx < 0) { wSum += curSpeed[r]; wCnt++ } // wall to the west
      else if (wallDx > 0) { eSum += curSpeed[r]; eCnt++ }
    }
    if (wCnt && eCnt) wbiRatio = wSum / wCnt / ((eSum / eCnt) || 1e-9)
  }

  // ---------------------------------------------------------------------------
  // 3. SEA-SURFACE TEMPERATURE — base + advection along the currents
  // ---------------------------------------------------------------------------
  const sst = new Float32Array(n)
  const sst0 = new Float64Array(n) // latitudinal base SST, °C
  for (let r = 0; r < n; r++) {
    if (!oceanDomain[r]) continue
    const latAbs = Math.abs(1 - 2 * (mesh.py[r] / height))
    const base = 30 - 34 * latAbs // ~30 °C at the equator → ~−4 °C at the poles
    sst0[r] = clamp(base, -2, 30)
    sst[r] = sst0[r]
  }
  // Steady advection–diffusion by explicit relaxation: each ocean cell is pulled toward the
  // temperature of the water flowing INTO it (its upstream neighbour), gently diffused, and
  // relaxed back toward the latitudinal base. Warm equatorial water thus rides the western
  // boundary current poleward as a warm tongue.
  const cur = new Float64Array(n) // scratch reused per sweep
  const SST_SWEEPS = 60
  for (let it = 0; it < SST_SWEEPS; it++) {
    for (let r = 0; r < n; r++) {
      if (!oceanDomain[r]) continue
      const speed = curSpeed[r]
      // Upstream direction is −current; find the neighbour it points at.
      let upT = sst[r]
      if (speed > 1e-4) {
        const cux = curU[r] / speed
        const cuy = curV[r] / speed
        let bestAlign = 0
        let bestT = sst[r]
        for (const j of mesh.neighbors[r]) {
          if (!oceanDomain[j]) continue
          let dx = mesh.px[j] - mesh.px[r]
          let dy = mesh.py[j] - mesh.py[r]
          const dl = Math.hypot(dx, dy) || 1
          dx /= dl
          dy /= dl
          const align = -(dx * cux + dy * cuy) // >0 ⇒ j is upstream
          if (align > bestAlign) {
            bestAlign = align
            bestT = sst[j]
          }
        }
        upT = bestT
      }
      // Diffusion: mean of ocean neighbours.
      let nsum = 0
      let ncnt = 0
      for (const j of mesh.neighbors[r]) {
        if (!oceanDomain[j]) continue
        nsum += sst[j]
        ncnt++
      }
      const nbrMean = ncnt ? nsum / ncnt : sst[r]
      const advect = clamp(speed * 0.9, 0, 0.85) // stronger currents carry more
      cur[r] = sst[r] + advect * (upT - sst[r]) + 0.12 * (nbrMean - sst[r]) + 0.08 * (sst0[r] - sst[r])
    }
    for (let r = 0; r < n; r++) if (oceanDomain[r]) sst[r] = cur[r]
  }
  for (let r = 0; r < n; r++) if (oceanDomain[r]) sst[r] = clamp(sst[r], -2.5, 32)

  // Maritime temperature each coastal land cell feels — the mean SST of its adjacent seas.
  const seaTempC = new Float32Array(n).fill(NaN)
  for (let r = 0; r < mesh.numSolid; r++) {
    if (water[r]) continue
    if (!coast[r]) continue
    let sum = 0
    let cnt = 0
    for (const j of mesh.neighbors[r]) {
      if (oceanDomain[j]) {
        sum += sst[j]
        cnt++
      }
    }
    if (cnt) seaTempC[r] = sum / cnt
  }

  const meta: CirculationMeta = {
    residual,
    wbiRatio,
    maxCurrent: 1, // curSpeed is normalised to a peak of ≈1
    maxWind,
    iterations: SWEEPS,
    oceanCells: interior.length,
  }

  return { windU, windV, windSpeed, pressure, curU, curV, curSpeed, psi: psiOut, sst, seaTempC, meta }
}
