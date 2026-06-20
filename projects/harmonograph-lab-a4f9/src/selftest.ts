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

import { sampleAttractor } from './curves'
import { LSYSTEMS, expandLSystem, sampleLSystem, turtle } from './lsystem'
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
  return [testAttractorBounds(), testLSystems()]
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
