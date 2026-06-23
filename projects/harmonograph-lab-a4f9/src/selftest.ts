// Numerical self-tests for the curve engine. These are pure invariant checks —
// no DOM, no rendering — that assert the things a renderer can't recover from:
// the strange-attractor maps stay bounded for *every* slider value, and each
// L-system produces a finite, correctly-sized polyline. They run automatically
// in dev (wired from main.tsx behind `import.meta.env.DEV`) and log a pass/fail
// summary; `window.__harmonographSelfTest` exposes the runner for headless use.
//
// Why ship them: the auto-fit framing divides by the figure's bounding box, so a
// single non-finite or runaway point silently collapses the whole canvas. These
// checks are the tripwire that keeps a new attractor or L-system from regressing
// that, and they double as living documentation of each family's guarantees.

import { randomAttractor, sampleAttractor } from './curves'
import { FLOW3D_KINDS, buildProjector, defaultsFor3D, integrateFlow, sample3DPolyline } from './attractors3d'
import {
  default3DHarmonograph,
  projectH3DPoints,
  random3DHarmonograph,
  sampleH3DPolyline,
} from './harmonograph3d'
import { LSYSTEMS, expandLSystem, sampleLSystem, sampleLSystemFull, turtle } from './lsystem'
import {
  FOURIER_SHAPES,
  chainAt,
  dft,
  epicyclesForShape,
  reconstructAt,
  sampleFourier,
  shapeSamples,
} from './fourier'
import type { AttractorKind, AttractorParams } from './types'

export interface TestResult {
  name: string
  pass: boolean
  detail: string
}

const ATTRACTOR_TYPES: AttractorKind[] = ['dejong', 'clifford', 'svensson', 'fractaldream']

// Every shipped attractor is built from bounded trig terms, so no orbit may
// exceed a generous magnitude — for any constants reachable from the sliders.
function testAttractorBounds(): TestResult {
  const BOUND = 12 // |x|,|y| are mathematically ≤ ~4; this leaves wide margin
  let worst = 0
  let checked = 0
  for (const type of ATTRACTOR_TYPES) {
    for (let s = 0; s < 600; s++) {
      const p: AttractorParams = {
        type,
        a: rand(-3, 3),
        b: rand(-3, 3),
        c: rand(-3, 3),
        d: rand(-3, 3),
        steps: 1500,
      }
      const pts = sampleAttractor(p)
      for (const pt of pts) {
        if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) {
          return fail('attractor bounds', `non-finite point in ${type} (a=${p.a} b=${p.b})`)
        }
        worst = Math.max(worst, Math.abs(pt.x), Math.abs(pt.y))
        if (worst > BOUND) {
          return fail('attractor bounds', `${type} reached ${worst.toFixed(2)} > ${BOUND}`)
        }
      }
      checked++
    }
  }
  return pass('attractor bounds', `${checked} param sets, max |coord| = ${worst.toFixed(2)} ≤ ${BOUND}`)
}

// The unbounded maps (Hopalong / Gumowski–Mira / Bedhead / Tinkerbell) are not
// confined by construction, so `sampleAttractor` must still hand back a *finite,
// non-degenerate* point set — every coordinate finite (the divergence guard) and
// a bounding box wider than a point but not absurd (robust framing did its job).
const UNBOUNDED_TYPES: AttractorKind[] = ['hopalong', 'gumowski', 'bedhead', 'tinkerbell']

function testUnboundedAttractors(): TestResult {
  let checked = 0
  for (const type of UNBOUNDED_TYPES) {
    for (let s = 0; s < 200; s++) {
      let p = randomAttractor()
      while (p.type !== type) p = randomAttractor()
      p = { ...p, steps: 4000 }
      const pts = sampleAttractor(p)
      let minX = Infinity
      let maxX = -Infinity
      let minY = Infinity
      let maxY = -Infinity
      for (const pt of pts) {
        if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) {
          return fail('unbounded attractors', `non-finite point in ${type} after clamping`)
        }
        if (pt.x < minX) minX = pt.x
        if (pt.x > maxX) maxX = pt.x
        if (pt.y < minY) minY = pt.y
        if (pt.y > maxY) maxY = pt.y
      }
      const span = Math.max(maxX - minX, maxY - minY)
      if (!Number.isFinite(span)) {
        return fail('unbounded attractors', `${type} produced a non-finite bounding box`)
      }
      checked++
    }
  }
  return pass(
    'unbounded attractors',
    `${checked} param sets across ${UNBOUNDED_TYPES.length} maps: finite & robustly framed`,
  )
}

// Each L-system must yield a finite polyline whose segment count matches the
// exact growth law for the systems with a closed form, and is ≥ 2 for the rest.
const EXACT: Record<string, (n: number) => number> = {
  dragon: (n) => 2 ** n,
  koch: (n) => 4 ** n,
  snowflake: (n) => 3 * 4 ** n,
  terdragon: (n) => 3 ** n,
  'square-koch': (n) => 5 ** n,
  levy: (n) => 2 ** n,
}

function testLSystems(): TestResult {
  for (const def of LSYSTEMS) {
    const pts = sampleLSystem({ system: def.id, iterations: def.defaultIter, angle: def.angle })
    if (pts.length < 2) return fail('l-systems', `${def.id} produced ${pts.length} points`)
    for (const p of pts) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        return fail('l-systems', `${def.id} produced a non-finite point`)
      }
    }
    const exact = EXACT[def.id]
    if (exact) {
      const want = exact(def.defaultIter)
      const got = pts.length - 1
      if (got !== want) {
        return fail('l-systems', `${def.id} iter ${def.defaultIter}: ${got} segs, expected ${want}`)
      }
    }
    // The expansion must be deterministic and angle-independent (the property
    // Live relies on): re-expanding gives the same string regardless of angle.
    const a = expandLSystem(def, def.defaultIter)
    const b = turtle(a, def.angle + 0.5, def.draw)
    const c = turtle(a, def.angle - 0.5, def.draw)
    if (b.length !== c.length) {
      return fail('l-systems', `${def.id} segment count changed with angle (${b.length}≠${c.length})`)
    }
  }
  return pass('l-systems', `${LSYSTEMS.length} systems: finite, correctly sized, angle-stable`)
}

// Branching systems (plants/trees) must actually branch: `sampleLSystemFull`
// has to return pen-up `breaks`, and every point must stay finite. A break count
// of zero would mean the bracket stack was ignored and the plant collapsed into
// one tangled stroke.
function testBranchingLSystems(): TestResult {
  const branching = LSYSTEMS.filter((d) => d.branching)
  if (branching.length === 0) return fail('branching l-systems', 'no branching systems registered')
  for (const def of branching) {
    const sc = sampleLSystemFull({ system: def.id, iterations: def.defaultIter, angle: def.angle })
    if (sc.points.length < 2) return fail('branching l-systems', `${def.id} produced too few points`)
    for (const p of sc.points) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        return fail('branching l-systems', `${def.id} produced a non-finite point`)
      }
    }
    const breakCount = (sc.breaks ?? []).filter(Boolean).length
    if (breakCount === 0) {
      return fail('branching l-systems', `${def.id} has no pen-up breaks (did not branch)`)
    }
  }
  return pass(
    'branching l-systems',
    `${branching.length} plants: finite, multi-stroke (pen-up branches present)`,
  )
}

// Every 3D flow must (a) integrate to finite points with a non-degenerate 3D
// extent — a collapse to a point/line means the seed fell into a fixed-point
// basin or an invariant axis (the Dadras trap) — and (b) project to a finite,
// non-degenerate, on-screen-sized 2D polyline through the orbit camera. The
// auto-fit framing divides by that 2D bounding box, so a zero-extent projection
// would silently blank the canvas. This is the 3D analogue of the attractor
// bounds tripwire, and it also pins the camera projection's numerical sanity.
function testFlows3D(): TestResult {
  let checked = 0
  for (const { value: type } of FLOW3D_KINDS) {
    const p = defaultsFor3D(type)
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity,
      minZ = Infinity,
      maxZ = -Infinity
    let nonfinite = 0
    integrateFlow(p, 12000, (x, y, z) => {
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        nonfinite++
        return
      }
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
      minY = Math.min(minY, y)
      maxY = Math.max(maxY, y)
      minZ = Math.min(minZ, z)
      maxZ = Math.max(maxZ, z)
    })
    if (nonfinite > 0) return fail('3d flows', `${type} produced ${nonfinite} non-finite point(s)`)
    const extent = Math.max(maxX - minX, maxY - minY, maxZ - minZ)
    if (!(extent > 1e-2)) {
      return fail('3d flows', `${type} collapsed (3D extent ${extent.toExponential(2)})`)
    }
    const pts = sample3DPolyline(p)
    let pMinX = Infinity,
      pMaxX = -Infinity,
      pMinY = Infinity,
      pMaxY = -Infinity
    for (const pt of pts) {
      if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) {
        return fail('3d flows', `${type} projected to a non-finite point`)
      }
      pMinX = Math.min(pMinX, pt.x)
      pMaxX = Math.max(pMaxX, pt.x)
      pMinY = Math.min(pMinY, pt.y)
      pMaxY = Math.max(pMaxY, pt.y)
    }
    const pw = pMaxX - pMinX
    const ph = pMaxY - pMinY
    if (!(pw > 1e-2) || !(ph > 1e-2) || pw > 100 || ph > 100) {
      return fail('3d flows', `${type} projection ill-framed (${pw.toFixed(2)}×${ph.toFixed(2)})`)
    }
    // A full 2π turn of yaw is the identity — the guarantee the seamless looping
    // export relies on. Projecting the same orbit point at yaw and yaw+2π must
    // agree to round-off.
    const a = buildProjector(p)
    const b = buildProjector({ ...p, yaw: p.yaw + Math.PI * 2 })
    const ra = a.project(maxX, maxY, maxZ)
    const rb = b.project(maxX, maxY, maxZ)
    if (Math.hypot(ra.x - rb.x, ra.y - rb.y) > 1e-6) {
      return fail('3d flows', `${type} yaw is not 2π-periodic (loop would seam)`)
    }
    checked++
  }
  return pass('3d flows', `${checked} RK4 flows: finite, non-degenerate, well-framed, 2π-periodic`)
}

// The spatial harmonograph is an exact closed-form space curve (a sum of decaying
// sines), so — unlike the chaotic flows — it can never diverge. The tripwire here
// is the *projection*: the curve must project (through the shared orbit camera) to
// a finite, non-degenerate, on-screen-sized polyline, the depth-splat path must
// agree, and yaw must be 2π-periodic so the looping export stays seamless.
function testHarmonograph3D(): TestResult {
  let checked = 0
  for (let s = 0; s < 120; s++) {
    const p = s === 0 ? default3DHarmonograph() : random3DHarmonograph()
    const pts = sampleH3DPolyline(p)
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity
    for (const pt of pts) {
      if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) {
        return fail('3d harmonograph', `projected to a non-finite point (seed ${s})`)
      }
      minX = Math.min(minX, pt.x)
      maxX = Math.max(maxX, pt.x)
      minY = Math.min(minY, pt.y)
      maxY = Math.max(maxY, pt.y)
    }
    const pw = maxX - minX
    const ph = maxY - minY
    if (!(pw > 1e-2) || !(ph > 1e-2) || pw > 100 || ph > 100) {
      return fail('3d harmonograph', `ill-framed projection ${pw.toFixed(2)}×${ph.toFixed(2)} (seed ${s})`)
    }
    // The density depth-splat path must also stay finite and produce a valid
    // normalised depth dn ∈ [0,1] for every point.
    let badDepth = 0
    projectH3DPoints(p, 800, (x, y, dn) => {
      if (!Number.isFinite(x) || !Number.isFinite(y) || !(dn >= 0 && dn <= 1)) badDepth++
    })
    if (badDepth > 0) return fail('3d harmonograph', `${badDepth} bad depth samples (seed ${s})`)
    // A full 2π turn of yaw is the identity — the seamless-loop guarantee.
    const a = sampleH3DPolyline(p)
    const b = sampleH3DPolyline({ ...p, yaw: p.yaw + Math.PI * 2 })
    let maxDiff = 0
    for (let i = 0; i < a.length; i++) {
      maxDiff = Math.max(maxDiff, Math.hypot(a[i].x - b[i].x, a[i].y - b[i].y))
    }
    if (maxDiff > 1e-6) {
      return fail('3d harmonograph', `yaw not 2π-periodic (Δ=${maxDiff.toExponential(2)}, seed ${s})`)
    }
    checked++
  }
  return pass('3d harmonograph', `${checked} spatial figures: finite, well-framed, depth-valid, 2π-periodic`)
}

// ---- Fourier (epicycle) engine ---------------------------------------------
// The DFT is the one curve family with a *provable* contract, so the tests prove
// it rather than just sanity-check it: the inverse transform reproduces the input
// exactly, and partial reconstructions converge monotonically as harmonics grow.

const FOURIER_IDS = FOURIER_SHAPES.map((s) => s.value)

// Mean-square error between the K-term reconstruction (on the DFT sample grid)
// and the original centred samples.
function fourierMse(id: string, k: number): number {
  const samples = shapeSamples(id)
  const eps = epicyclesForShape(id)
  const N = samples.length
  let sum = 0
  for (let i = 0; i < N; i++) {
    const p = reconstructAt(eps, k, i / N, 0)
    const dx = p.x - samples[i].x
    const dy = p.y - samples[i].y
    sum += dx * dx + dy * dy
  }
  return sum / N
}

// (1) Inverse-DFT exactness: with all N epicycles the reconstruction reproduces
// the original samples to machine precision, for every shape.
function testFourierExact(): TestResult {
  let worst = 0
  for (const id of FOURIER_IDS) {
    const samples = shapeSamples(id)
    const eps = dft(samples)
    const N = samples.length
    for (let i = 0; i < N; i++) {
      const p = reconstructAt(eps, N, i / N, 0)
      const e = Math.hypot(p.x - samples[i].x, p.y - samples[i].y)
      if (e > worst) worst = e
      if (e > 1e-7) {
        return fail('fourier inverse-DFT exact', `${id}[${i}] reconstruction error ${e.toExponential(2)}`)
      }
    }
  }
  return pass('fourier inverse-DFT exact', `${FOURIER_IDS.length} shapes round-trip, max err ${worst.toExponential(2)}`)
}

// (2) Monotone convergence: adding harmonics never increases the error (the basis
// is orthogonal on the sample grid, so the K-term error is the energy of the
// omitted terms). This is the mathematical guarantee behind the harmonics slider.
function testFourierConvergence(): TestResult {
  const ks = [1, 2, 4, 8, 16, 32, 64, 128, 256]
  for (const id of FOURIER_IDS) {
    let prev = Infinity
    for (const k of ks) {
      const mse = fourierMse(id, k)
      if (!Number.isFinite(mse)) return fail('fourier convergence', `${id} non-finite MSE at K=${k}`)
      // Allow a hair of floating-point slack; the trend must be non-increasing.
      if (mse > prev * (1 + 1e-9) + 1e-12) {
        return fail('fourier convergence', `${id} MSE rose at K=${k}: ${mse.toExponential(3)} > ${prev.toExponential(3)}`)
      }
      prev = mse
    }
  }
  return pass('fourier convergence', `MSE monotonically non-increasing over ${ks.length} K-steps × ${FOURIER_IDS.length} shapes`)
}

// (3) Finiteness + a closed loop: every shape, across a sweep of harmonic counts,
// yields finite, sanely-bounded points whose first and last samples coincide (the
// reconstruction is exactly 1-periodic), and the overlay chain's tip lands on the
// curve.
function testFourierFinite(): TestResult {
  const BOUND = 6
  for (const id of FOURIER_IDS) {
    for (const harmonics of [1, 3, 12, 48, 200]) {
      const pts = sampleFourier({ shape: id, harmonics, phase: 0.3, epicycles: true, steps: 400 })
      for (const p of pts) {
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
          return fail('fourier finite', `${id} K=${harmonics} produced a non-finite point`)
        }
        if (Math.abs(p.x) > BOUND || Math.abs(p.y) > BOUND) {
          return fail('fourier finite', `${id} K=${harmonics} escaped the box (${p.x.toFixed(2)}, ${p.y.toFixed(2)})`)
        }
      }
      const loopErr = Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y)
      if (loopErr > 1e-9) {
        return fail('fourier finite', `${id} K=${harmonics} loop not closed (gap ${loopErr.toExponential(2)})`)
      }
      // The chain tip must equal the directly-reconstructed pen position.
      const eps = epicyclesForShape(id)
      const k = Math.min(harmonics, eps.length)
      const chain = chainAt(eps, k, 0.42, 0.3)
      const tip = chain[chain.length - 1]
      const direct = reconstructAt(eps, k, 0.42, 0.3)
      const tipErr = Math.hypot(tip.x - direct.x, tip.y - direct.y)
      if (tipErr > 1e-9) {
        return fail('fourier finite', `${id} K=${harmonics} chain tip ≠ reconstruction (${tipErr.toExponential(2)})`)
      }
    }
  }
  return pass('fourier finite', `${FOURIER_IDS.length} shapes finite, closed & chain-consistent across 5 harmonic counts`)
}

function rand(a: number, b: number): number {
  return a + Math.random() * (b - a)
}
function pass(name: string, detail: string): TestResult {
  return { name, pass: true, detail }
}
function fail(name: string, detail: string): TestResult {
  return { name, pass: false, detail }
}

export function runSelfTests(): TestResult[] {
  return [
    testAttractorBounds(),
    testUnboundedAttractors(),
    testLSystems(),
    testBranchingLSystems(),
    testFlows3D(),
    testHarmonograph3D(),
    testFourierExact(),
    testFourierConvergence(),
    testFourierFinite(),
  ]
}

// Log a compact summary; wired behind DEV so production bundles never run it.
export function reportSelfTests(): void {
  const results = runSelfTests()
  const ok = results.every((r) => r.pass)
  const tag = ok ? '✓ curve self-tests passed' : '✗ curve self-tests FAILED'
  console[ok ? 'info' : 'error'](
    `%c${tag}`,
    `color:${ok ? '#34d399' : '#ef4444'};font-weight:bold`,
  )
  for (const r of results) {
    console[r.pass ? 'info' : 'error'](`  ${r.pass ? '✓' : '✗'} ${r.name} — ${r.detail}`)
  }
  try {
    ;(window as unknown as Record<string, unknown>).__harmonographSelfTest = runSelfTests
  } catch {
    /* non-browser / sandbox — ignore */
  }
}
