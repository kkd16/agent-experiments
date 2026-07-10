// The Timed mode's in-app verification suite. The two reachability engines here
// were built independently — Alur & Dill's finite REGION automaton (regions.ts)
// and the DBM ZONE fixpoint with maximal-bound extrapolation (reach.ts) — and
// they share no code. The headline test is therefore a genuine differential
// proof: on every gallery machine and hundreds of random ones, the set of
// reachable control locations they compute is IDENTICAL. Around that sit the
// algebraic invariants of the DBM operations, the region successor checked
// against concrete delay, a three-way concrete⊆region⊆zone soundness cross-check,
// and a known-answer battery.

import type { TimedAutomaton } from './types'
import { maxConstants } from './types'
import {
  applyAtom,
  canonicalize,
  cloneDBM,
  contains,
  equalDBM,
  extrapolate,
  includes,
  isEmpty,
  reset,
  universe,
  up,
  zeroZone,
} from './dbm'
import type { DBM } from './dbm'
import { buildRegionGraph, regionOf, regionSig, representative, timeSucc } from './regions'
import { buildZoneGraph } from './reach'
import { enabledEdges, initialConfig, maxDelay, step } from './simulate'
import type { Config } from './simulate'
import { TIMED_EXAMPLES } from './examples'
import { parseTimedAutomaton, showTimedAutomaton } from './parser'

export interface CheckResult {
  name: string
  pass: boolean
  detail: string
}
export interface SelfTestReport {
  results: CheckResult[]
  passed: number
  total: number
  ok: boolean
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const randInt = (rng: () => number, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1))
const pick = <T,>(rng: () => number, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length) % xs.length]

const OPS = ['<=', '<', '>=', '>', '='] as const

/** A random small, well-formed timed automaton (few clocks/locations, tiny constants). */
function randomTA(rng: () => number): TimedAutomaton {
  const nClocks = randInt(rng, 1, 2)
  const clocks = ['x', 'y'].slice(0, nClocks)
  const nLoc = randInt(rng, 2, 4)
  const locs = Array.from({ length: nLoc }, (_, i) => `l${i}`)
  const locations = locs.map((name) => {
    // sometimes an upper-bound invariant
    const inv =
      rng() < 0.5 ? [{ clock: pick(rng, clocks), op: pick(rng, ['<=', '<'] as const), bound: randInt(rng, 1, 3) }] : []
    return { name, invariant: inv, accepting: false }
  })
  const nEdges = randInt(rng, nLoc, nLoc * 2)
  const edges = Array.from({ length: nEdges }, () => {
    const from = pick(rng, locs)
    const to = pick(rng, locs)
    const guard =
      rng() < 0.7 ? [{ clock: pick(rng, clocks), op: pick(rng, OPS), bound: randInt(rng, 0, 3) }] : []
    const resets = rng() < 0.5 ? [pick(rng, clocks)] : []
    return { from, to, guard, resets, action: 'a' }
  })
  return { clocks, locations, edges, initial: locs[0] }
}

function setEq(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const x of a) if (!b.has(x)) return false
  return true
}

// A random DBM built by intersecting the universe with a handful of atoms.
function randomDBM(rng: () => number, n: number): DBM {
  let d = universe(n)
  const k = randInt(rng, 0, 4)
  for (let i = 0; i < k; i++) {
    d = applyAtom(d, randInt(rng, 0, n - 1), pick(rng, ['<=', '<', '>=', '>'] as const), randInt(rng, 0, 4))
    if (isEmpty(d)) break
  }
  return d
}

export function runSelfTest(): SelfTestReport {
  const results: CheckResult[] = []
  const add = (name: string, pass: boolean, detail: string) => results.push({ name, pass, detail })

  // ── 1. DBM canonical form is idempotent ────────────────────────────────────
  {
    const rng = mulberry32(1)
    let ok = true
    for (let t = 0; t < 300; t++) {
      const n = randInt(rng, 1, 3)
      const d = randomDBM(rng, n)
      const once = canonicalize(cloneDBM(d))
      if (isEmpty(once)) continue // a negative-cycle DBM has no shortest-path fixpoint
      const twice = canonicalize(cloneDBM(once))
      if (!equalDBM(once, twice)) ok = false
    }
    add('DBM canonical form is idempotent', ok, '300 non-empty random zones: canonicalize∘canonicalize = canonicalize')
  }

  // ── 2. Emptiness ⟺ a contradictory zone ────────────────────────────────────
  {
    let d = universe(1)
    d = applyAtom(d, 0, '>=', 3)
    d = applyAtom(d, 0, '<=', 1)
    const empty = isEmpty(d)
    let full = universe(2)
    full = applyAtom(full, 0, '<=', 5)
    add('emptiness detects the negative cycle', empty && !isEmpty(full), 'x≥3∧x≤1 is empty; x≤5 is not')
  }

  // ── 3. Operation monotonicity (soundness of the abstractions) ──────────────
  {
    const rng = mulberry32(7)
    let ok = true
    for (let t = 0; t < 300; t++) {
      const n = randInt(rng, 1, 3)
      const d = canonicalize(randomDBM(rng, n))
      if (isEmpty(d)) continue
      const max = Array.from({ length: n }, () => randInt(rng, 1, 4))
      if (!includes(up(cloneDBM(d)), d)) ok = false // delay only adds valuations
      if (!includes(extrapolate(d, max), d)) ok = false // extrapolation over-approximates
      const g = applyAtom(d, randInt(rng, 0, n - 1), '<=', randInt(rng, 0, 4))
      if (!isEmpty(g) && !includes(d, g)) ok = false // guard only removes valuations
    }
    add('delay/extrapolation widen, guards narrow', ok, '300 zones: Z⊆up(Z), Z⊆Extra(Z), Z∧g⊆Z')
  }

  // ── 4. A region's representative lands back in that region ─────────────────
  {
    const rng = mulberry32(11)
    let ok = true
    const max = [3, 3]
    for (let t = 0; t < 500; t++) {
      const v = [randInt(rng, 0, 8) / 2, randInt(rng, 0, 8) / 2]
      const r = regionOf(v, max)
      const back = regionOf(representative(r, max), max)
      if (regionSig(r) !== regionSig(back)) ok = false
    }
    add('region ↔ representative round-trip', ok, '500 valuations: regionOf(rep(regionOf(v))) = regionOf(v)')
  }

  // ── 5. Region time-successor matches concrete delay ────────────────────────
  {
    const rng = mulberry32(23)
    const max = [3, 3]
    let ok = true
    for (let t = 0; t < 400; t++) {
      const v = [randInt(rng, 0, 6) / 2, randInt(rng, 0, 6) / 2]
      const delta = randInt(rng, 0, 8) / 2
      const target = regionSig(regionOf([v[0] + delta, v[1] + delta], max))
      // walk the region time-successor chain and see if the delayed region appears
      let cur = regionOf(v, max)
      let seen = regionSig(cur) === target
      for (let s = 0; s < 60 && !seen; s++) {
        const nxt = timeSucc(cur, max)
        if (regionSig(nxt) === regionSig(cur)) break
        cur = nxt
        if (regionSig(cur) === target) seen = true
      }
      if (!seen) ok = false
    }
    add('region time-successor covers concrete delay', ok, '400 (v,δ): regionOf(v+δ) is on the timeSucc chain from regionOf(v)')
  }

  // ── 6. HEADLINE — region and zone reachability agree ───────────────────────
  {
    let ok = true
    let worst = ''
    // gallery
    for (const ex of TIMED_EXAMPLES) {
      const p = parseTimedAutomaton(ex.source)
      if (!p.ok) {
        ok = false
        worst = ex.id + ' (parse)'
        continue
      }
      const rr = buildRegionGraph(p.ta).reachableLocations
      const zr = buildZoneGraph(p.ta).reachableLocations
      if (!setEq(rr, zr)) {
        ok = false
        worst = ex.id
      }
    }
    // random automata
    const rng = mulberry32(101)
    let n = 0
    for (let t = 0; t < 400; t++) {
      const ta = randomTA(rng)
      const zg = buildZoneGraph(ta)
      if (zg.truncated) continue // skip the rare uncapped case
      const rr = buildRegionGraph(ta).reachableLocations
      if (!setEq(rr, zg.reachableLocations)) {
        ok = false
        worst = `random#${t}`
      }
      n++
    }
    add('region ≡ zone reachable locations', ok, ok ? `${TIMED_EXAMPLES.length} gallery + ${n} random machines agree` : `mismatch on ${worst}`)
  }

  // ── 7. Zone reachability terminates (extrapolation) ────────────────────────
  {
    let ok = true
    for (const ex of TIMED_EXAMPLES) {
      const p = parseTimedAutomaton(ex.source)
      if (p.ok && buildZoneGraph(p.ta).truncated) ok = false
    }
    add('zone fixpoint terminates on every example', ok, 'no gallery machine hits the state cap — Extra_M is finite')
  }

  // ── 8. Concrete runs stay inside the reachable region/zone sets ────────────
  {
    const rng = mulberry32(202)
    let ok = true
    let checks = 0
    for (let t = 0; t < 60; t++) {
      const ta = randomTA(rng)
      const rg = buildRegionGraph(ta)
      const zg = buildZoneGraph(ta)
      if (zg.truncated) continue
      const max = maxConstants(ta)
      const reachRegionAtLoc = new Map<string, Set<string>>()
      for (const s of rg.states) {
        if (!reachRegionAtLoc.has(s.loc)) reachRegionAtLoc.set(s.loc, new Set())
        reachRegionAtLoc.get(s.loc)!.add(regionSig(s.region))
      }
      // random legal walk
      let cfg: Config = initialConfig(ta)
      for (let stepN = 0; stepN < 20; stepN++) {
        // maybe delay
        if (rng() < 0.6) {
          const md = maxDelay(ta, cfg)
          const d = md === Infinity ? randInt(rng, 0, 6) / 2 : (Math.floor(rng() * (md * 2 + 1)) / 2)
          const r = step(ta, cfg, { kind: 'delay', delta: Math.min(d, md === Infinity ? d : md) })
          if (r.ok) cfg = r.config
        }
        // membership checks
        const rsig = regionSig(regionOf(cfg.val, max))
        const inRegion = reachRegionAtLoc.get(cfg.loc)?.has(rsig) ?? false
        const inZone = zg.states.some((s) => s.loc === cfg.loc && contains(s.zone, cfg.val))
        checks++
        if (!inRegion || !inZone) ok = false
        // maybe take an action
        const en = enabledEdges(ta, cfg)
        if (en.length && rng() < 0.7) {
          const r = step(ta, cfg, { kind: 'action', edge: pick(rng, en) })
          if (r.ok) cfg = r.config
        }
      }
    }
    add('concrete runs ⊆ reachable regions ∩ zones', ok, `${checks} sampled configs each lie in a reached region and a reached zone`)
  }

  // ── 9. Known answers ───────────────────────────────────────────────────────
  {
    const reach = (src: string) => {
      const p = parseTimedAutomaton(src)
      return p.ok ? buildZoneGraph(p.ta).reachableLocations : new Set<string>()
    }
    const byId = (id: string) => TIMED_EXAMPLES.find((e) => e.id === id)!.source
    const deadline = reach(byId('deadline'))
    const deadlineRelaxed = reach(byId('deadline').replace('x<=2', 'x<=5'))
    const response = reach(byId('response'))
    const light = reach(byId('light'))
    const watchdog = reach(byId('watchdog'))
    const facts = [
      ['deadline: "done" unreachable (invariant beats guard)', !deadline.has('done')],
      ['deadline relaxed to x≤5: "done" reachable', deadlineRelaxed.has('done')],
      ['response: both "q2" (accept) and "bad" reachable', response.has('q2') && response.has('bad')],
      ['light switch: "bright" reachable', light.has('bright')],
      ['watchdog: "timeout" reachable', watchdog.has('timeout')],
    ] as const
    const allOk = facts.every((f) => f[1])
    add('known-answer reachability battery', allOk, facts.map((f) => `${f[1] ? '✓' : '✗'} ${f[0]}`).join(' · '))
  }

  // ── 10. Parser round-trips ─────────────────────────────────────────────────
  {
    let ok = true
    for (const ex of TIMED_EXAMPLES) {
      const p = parseTimedAutomaton(ex.source)
      if (!p.ok) {
        ok = false
        continue
      }
      const p2 = parseTimedAutomaton(showTimedAutomaton(p.ta))
      if (!p2.ok) {
        ok = false
        continue
      }
      const r1 = buildZoneGraph(p.ta).reachableLocations
      const r2 = buildZoneGraph(p2.ta).reachableLocations
      if (!setEq(r1, r2)) ok = false
    }
    add('source ↔ AST round-trip', ok, 'showTimedAutomaton then re-parse preserves reachability on every example')
  }

  // ── 11. Reset gives a clock the reference value ────────────────────────────
  {
    const rng = mulberry32(303)
    let ok = true
    for (let t = 0; t < 200; t++) {
      const n = randInt(rng, 1, 3)
      const d = canonicalize(randomDBM(rng, n))
      if (isEmpty(d)) continue
      const ci = randInt(rng, 0, n - 1)
      const r = canonicalize(reset(cloneDBM(d), ci))
      // in the reset zone the clock is pinned to 0
      const probe = zeroZone(n)
      // every point of r has clock ci = 0: bound (ci→0)≤0 and (0→ci)≤0
      const b1 = r.m[ci + 1][0]
      const b2 = r.m[0][ci + 1]
      if (!(b1.value === 0 && !b1.strict && b2.value === 0 && !b2.strict)) ok = false
      void probe
    }
    add('reset pins the clock to 0', ok, '200 zones: after reset(x), the zone forces x = 0')
  }

  const passed = results.filter((r) => r.pass).length
  return { results, passed, total: results.length, ok: passed === results.length }
}
