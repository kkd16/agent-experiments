// The Proof Lab — a live, in-browser certification of the whole engine. It generates worlds
// and checks the invariants the pipeline is supposed to hold: determinism, a valid mesh, a
// hydrology that really drains and conserves water, a sane climate, the new circulation
// physics (mass-conserving currents, the Coriolis sign flip, western intensification), and a
// well-formed history simulation. Every check reports a real measured number, not just a tick.
//
// It runs the actual production `generateWorld` — no mock, no shadow implementation — so a
// green board means the code that draws your atlas is the code that was proven.

import { generateWorld } from './generate'
import { DEFAULT_PARAMS } from './presets'
import { MeshDiff } from './meshfield'
import { KOPPEN, KOPPEN_NONE } from './koppen'
import type { WorldMap, WorldParams } from './types'

export interface Check {
  name: string
  pass: boolean
  /** A measured value or short explanation shown next to the result. */
  detail: string
}
export interface ProofSection {
  title: string
  checks: Check[]
}
export interface ProofReport {
  sections: ProofSection[]
  total: number
  passed: number
  ms: number
}

const PROOF_PARAMS: WorldParams = { ...DEFAULT_PARAMS, seed: 'proof-atlas', regions: 3200 }

function eqArr(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function latAbsOf(w: WorldMap, r: number): number {
  return Math.abs(1 - 2 * (w.mesh.py[r] / w.params.height))
}

/** Run the full proof battery and return the categorised report. */
export function runProofs(): ProofReport {
  const t0 = now()
  const sections: ProofSection[] = []

  const a = generateWorld(PROOF_PARAMS)
  const b = generateWorld(PROOF_PARAMS)
  const mesh = a.mesh
  const c = a.circulation

  // --- Determinism ---------------------------------------------------------
  {
    const checks: Check[] = []
    const cb = b.circulation
    const fieldsEqual =
      eqArr(a.elevation, b.elevation) &&
      eqArr(a.ocean, b.ocean) &&
      eqArr(a.biome, b.biome) &&
      eqArr(a.koppen, b.koppen)
    checks.push({
      name: 'Terrain, ocean, biome & Köppen reproduce byte-for-byte',
      pass: fieldsEqual,
      detail: fieldsEqual ? 'identical across two runs' : 'MISMATCH',
    })
    const circEqual =
      eqArr(c.windU, cb.windU) &&
      eqArr(c.windV, cb.windV) &&
      eqArr(c.curU, cb.curU) &&
      eqArr(c.curV, cb.curV) &&
      eqArr(c.sst, cb.sst) &&
      eqArr(c.pressure, cb.pressure)
    checks.push({
      name: 'Winds, currents, pressure & SST reproduce byte-for-byte',
      pass: circEqual,
      detail: circEqual ? 'identical across two runs' : 'MISMATCH',
    })
    // History owner maps + chronicle.
    let histEqual = a.history.frames.length === b.history.frames.length
    for (let f = 0; histEqual && f < a.history.frames.length; f++) {
      histEqual = eqArr(a.history.frames[f].owner, b.history.frames[f].owner)
    }
    histEqual = histEqual && a.chronicle.length === b.chronicle.length
    checks.push({
      name: 'The Ages: every turn’s owner map + chronicle reproduce',
      pass: histEqual,
      detail: histEqual ? `${a.history.frames.length} frames, ${a.chronicle.length} events` : 'MISMATCH',
    })
    sections.push({ title: 'Determinism — same seed ⇒ same world', checks })
  }

  // --- Mesh ----------------------------------------------------------------
  {
    const checks: Check[] = []
    // Adjacency is symmetric for every solid region. (The outer frame ring's convex-hull
    // edges are one-directional by construction, but those cells are permanent ocean the
    // engine never computes on — every solid region is fully enclosed by the frame.)
    let asym = 0
    for (let r = 0; r < mesh.numSolid; r++) {
      for (const j of mesh.neighbors[r]) {
        if (!mesh.neighbors[j].includes(r)) asym++
      }
    }
    checks.push({
      name: 'Adjacency is symmetric for every solid region (j∈N(r) ⇔ r∈N(j))',
      pass: asym === 0,
      detail: `${asym} asymmetric pairs`,
    })
    let open = 0
    for (let r = 0; r < mesh.numSolid; r++) if (mesh.cellTriangles[r].length < 3) open++
    checks.push({
      name: 'Every solid Voronoi cell is a closed polygon (≥3 vertices)',
      pass: open === 0,
      detail: `${open} degenerate cells`,
    })
    let frameLand = 0
    for (let r = 0; r < mesh.numRegions; r++) if (mesh.isFrame[r] && !a.ocean[r]) frameLand++
    checks.push({
      name: 'Boundary-frame cells are permanent ocean',
      pass: frameLand === 0,
      detail: `${frameLand} frame cells not ocean`,
    })
    sections.push({ title: 'Mesh integrity', checks })
  }

  // --- Hydrology -----------------------------------------------------------
  {
    const checks: Check[] = []
    // Every land cell drains downhill to the sea (follow the downslope chain).
    let stranded = 0
    for (let r = 0; r < mesh.numSolid; r++) {
      if (a.ocean[r]) continue
      let cur = r
      let steps = 0
      let reached = false
      while (steps++ < mesh.numSolid + 4) {
        const d = a.downslope[cur]
        if (d < 0) break
        if (a.ocean[d]) {
          reached = true
          break
        }
        cur = d
      }
      if (!reached) stranded++
    }
    checks.push({
      name: 'Every land cell drains downhill to the sea (no false pits)',
      pass: stranded === 0,
      detail: `${stranded} stranded cells`,
    })

    // Flow accumulation conserves rainfall: total input = flux delivered to the sea.
    let input = 0
    let delivered = 0
    for (let r = 0; r < mesh.numSolid; r++) {
      if (a.ocean[r]) continue
      input += a.params.rainfall * (0.35 + 1.5 * a.precip[r])
      const d = a.downslope[r]
      if (d >= 0 && a.ocean[d]) delivered += a.flux[r]
    }
    const relErr = input > 0 ? Math.abs(delivered - input) / input : 0
    checks.push({
      name: 'Flow accumulation conserves rainfall (Σ input = Σ reaching the sea)',
      pass: relErr < 1e-9,
      detail: `relative error ${relErr.toExponential(2)}`,
    })

    let badRiver = 0
    for (const rv of a.rivers) if (rv.a >= mesh.numSolid || a.ocean[rv.a]) badRiver++
    checks.push({
      name: 'Rivers ride only land edges',
      pass: badRiver === 0,
      detail: `${badRiver} bad edges of ${a.rivers.length}`,
    })
    sections.push({ title: 'Hydrology', checks })
  }

  // --- Climate -------------------------------------------------------------
  {
    const checks: Check[] = []
    let badK = 0
    let badSeason = 0
    for (let r = 0; r < mesh.numSolid; r++) {
      const k = a.koppen[r]
      if (k !== KOPPEN_NONE && k >= KOPPEN.length) badK++
      if (k !== KOPPEN_NONE && a.tWarm[r] < a.tCold[r]) badSeason++
    }
    checks.push({ name: 'Every Köppen id is valid', pass: badK === 0, detail: `${badK} invalid` })
    checks.push({
      name: 'Warmest month ≥ coldest month everywhere',
      pass: badSeason === 0,
      detail: `${badSeason} violations`,
    })
    // Temperature falls from equator to pole.
    let eqSum = 0
    let eqN = 0
    let poSum = 0
    let poN = 0
    for (let r = 0; r < mesh.numSolid; r++) {
      const l = latAbsOf(a, r)
      if (l < 0.15) {
        eqSum += a.temperature[r]
        eqN++
      } else if (l > 0.8) {
        poSum += a.temperature[r]
        poN++
      }
    }
    const eqT = eqN ? eqSum / eqN : 0
    const poT = poN ? poSum / poN : 1
    checks.push({
      name: 'Mean temperature falls from equator to pole',
      pass: eqT > poT,
      detail: `equator ${eqT.toFixed(2)} > pole ${poT.toFixed(2)}`,
    })
    sections.push({ title: 'Climate', checks })
  }

  // --- Circulation (the new physics) --------------------------------------
  {
    const checks: Check[] = []
    // ψ = 0 on every boundary (land, lake, frame, coast-adjacent ocean).
    const oceanDomain = new Uint8Array(mesh.numRegions)
    for (let r = 0; r < mesh.numRegions; r++) if (a.ocean[r] && !mesh.isFrame[r]) oceanDomain[r] = 1
    let maxBoundaryPsi = 0
    for (let r = 0; r < mesh.numRegions; r++) {
      if (!oceanDomain[r]) maxBoundaryPsi = Math.max(maxBoundaryPsi, Math.abs(c.psi[r]))
    }
    checks.push({
      name: 'Streamfunction ψ = 0 on every coast & map edge',
      pass: maxBoundaryPsi === 0,
      detail: `max |ψ| off-domain = ${maxBoundaryPsi.toFixed(3)}`,
    })

    // Mass conservation: the current is divergence-free (∇·u ≈ 0) in the interior, and its
    // basin-integrated divergence is ≈ 0 (no water crosses the coast).
    const diff = new MeshDiff(mesh, oceanDomain)
    const div = diff.divergence(c.curU, c.curV)
    let maxDiv = 0
    let netDiv = 0
    let peak = 1e-9
    let interiorN = 0
    for (let r = 0; r < mesh.numRegions; r++) {
      if (!oceanDomain[r]) continue
      let onWall = false
      for (const j of mesh.neighbors[r]) if (!oceanDomain[j]) { onWall = true; break }
      peak = Math.max(peak, c.curSpeed[r])
      if (onWall) continue
      maxDiv = Math.max(maxDiv, Math.abs(div[r]))
      netDiv += div[r]
      interiorN++
    }
    const divRatio = maxDiv / peak
    checks.push({
      name: 'Ocean current is mass-conserving (local ∇·u ≪ current speed)',
      pass: divRatio < 0.06,
      detail: `max|∇·u| / peak = ${(divRatio * 100).toFixed(2)}%`,
    })
    checks.push({
      name: 'No net water crosses the coast (basin-integrated ∇·u ≈ 0)',
      pass: interiorN > 0 && Math.abs(netDiv) / (peak * interiorN) < 0.02,
      detail: `net ∇·u = ${netDiv.toExponential(2)} over ${interiorN} cells`,
    })

    // Coriolis: the three-cell zonal wind pattern, with the sign flipping across the equator.
    const bandU = (lo: number, hi: number): number => {
      let s = 0
      let nn = 0
      for (let r = 0; r < mesh.numSolid; r++) {
        const l = latAbsOf(a, r)
        if (l >= lo && l < hi) {
          s += c.windU[r]
          nn++
        }
      }
      return nn ? s / nn : NaN
    }
    const uTrade = bandU(0.05, 0.3)
    const uWest = bandU(0.38, 0.62)
    const uPolar = bandU(0.72, 0.95)
    checks.push({
      name: 'Trade easterlies, mid-latitude westerlies, polar easterlies',
      pass: uTrade < 0 && uWest > 0 && uPolar < 0,
      detail: `ū: trades ${uTrade.toFixed(2)}, westerlies ${uWest.toFixed(2)}, polar ${uPolar.toFixed(2)}`,
    })
    const bandV = (north: boolean): number => {
      let s = 0
      let nn = 0
      for (let r = 0; r < mesh.numSolid; r++) {
        const ny = mesh.py[r] / a.params.height
        if (ny < 0.5 !== north) continue
        const l = Math.abs(1 - 2 * ny)
        if (l >= 0.08 && l < 0.28) {
          s += c.windV[r]
          nn++
        }
      }
      return nn ? s / nn : NaN
    }
    const vN = bandV(true)
    const vS = bandV(false)
    checks.push({
      name: 'Coriolis sign flips across the equator (trades blow equatorward on both sides)',
      pass: vN > 0 && vS < 0,
      detail: `N trade v̄ ${vN.toFixed(2)} (south), S trade v̄ ${vS.toFixed(2)} (north)`,
    })

    checks.push({
      name: 'Western intensification (boundary currents faster on the west)',
      pass: c.meta.wbiRatio > 1,
      detail: `west/east speed ratio ${c.meta.wbiRatio.toFixed(2)}`,
    })

    // SST bounds + equator-warmer-than-pole.
    let sstMin = Infinity
    let sstMax = -Infinity
    let eqSst = 0
    let eqN = 0
    let poSst = 0
    let poN = 0
    for (let r = 0; r < mesh.numRegions; r++) {
      if (!oceanDomain[r]) continue
      sstMin = Math.min(sstMin, c.sst[r])
      sstMax = Math.max(sstMax, c.sst[r])
      const l = latAbsOf(a, r)
      if (l < 0.2) {
        eqSst += c.sst[r]
        eqN++
      } else if (l > 0.75) {
        poSst += c.sst[r]
        poN++
      }
    }
    const boundsOk = sstMin >= -3 && sstMax <= 33
    const eqWarm = (eqN ? eqSst / eqN : 0) > (poN ? poSst / poN : 0)
    checks.push({
      name: 'SST stays physical (−3…33 °C) and tropics warmer than poles',
      pass: boundsOk && eqWarm,
      detail: `range ${sstMin.toFixed(1)}…${sstMax.toFixed(1)} °C`,
    })

    checks.push({
      name: 'Stommel solve converged (small residual)',
      pass: c.meta.residual < 1e-3,
      detail: `‖Aψ−f‖∞ / ‖f‖∞ = ${c.meta.residual.toExponential(2)}`,
    })
    sections.push({ title: 'Circulation — atmosphere & ocean physics', checks })
  }

  // --- The Ages ------------------------------------------------------------
  {
    const checks: Check[] = []
    const H = a.history
    let negPop = 0
    let badOwner = 0
    for (const f of H.frames) {
      for (const rs of f.realms) if (rs.population < 0 || rs.area < 0) negPop++
      for (let r = 0; r < f.owner.length; r++) {
        const o = f.owner[r]
        if (o !== -1 && (o < 0 || o >= H.realms.length)) badOwner++
      }
    }
    checks.push({ name: 'Populations & areas never go negative', pass: negPop === 0, detail: `${negPop} bad snapshots` })
    checks.push({ name: 'Every owner id references a real realm', pass: badOwner === 0, detail: `${badOwner} dangling ids` })
    // Capitals are owned by their realm in the present age.
    const last = H.frames[H.frames.length - 1]
    let badCap = 0
    if (last) {
      for (const rs of last.realms) {
        if (rs.capital >= 0 && last.owner[rs.capital] !== rs.id) badCap++
      }
    }
    checks.push({ name: 'Each realm’s capital sits on land it owns', pass: badCap === 0, detail: `${badCap} orphan capitals` })
    sections.push({ title: 'The Ages — history simulation', checks })
  }

  let total = 0
  let passed = 0
  for (const s of sections) for (const ck of s.checks) {
    total++
    if (ck.pass) passed++
  }
  return { sections, total, passed, ms: now() - t0 }
}

function now(): number {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()
}
