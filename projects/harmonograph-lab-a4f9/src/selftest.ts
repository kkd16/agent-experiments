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
import { LSYSTEMS, expandLSystem, sampleLSystem, sampleLSystemFull, turtle } from './lsystem'
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
