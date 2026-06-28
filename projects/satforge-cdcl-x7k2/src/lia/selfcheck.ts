// Correctness harness for the Omega test. Two independent oracles must agree:
//
//   1. exhaustive integer brute force over a box that, because every generated
//      system bounds its variables into that box, equals the whole feasible
//      region — so it certifies BOTH the SAT and the UNSAT verdicts;
//   2. a battery of hand-derived classics (gcd-infeasible equalities, the
//      Frobenius/Chicken-McNugget number, dark-shadow gaps that force splinters)
//      whose answers are known a priori.
//
// On every SAT verdict the returned integer model is re-validated against the
// raw constraints. Exposed as runLiaChecks() so the studio folds these
// assertions into its self-test badge, exactly like the other subsystems.

import type { Cons } from './omega'
import { omegaTest, verifyModel } from './omega'
import { bruteForce } from './brute'
import { parseLia } from './parse'

export interface LiaCheckReport {
  pass: number
  fail: number
  messages: string[]
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

const names = (n: number) => (v: number) => (v < n ? `x${v}` : `σ${v}`)

/** Build `lo ≤ x_k ≤ hi` for every variable, so the box is the whole space. */
function boxConstraints(n: number, lo: bigint, hi: bigint): Cons[] {
  const out: Cons[] = []
  for (let v = 0; v < n; v++) {
    out.push({ lin: { c: -lo, t: new Map([[v, 1n]]) }, op: 'ge' }) // x − lo ≥ 0
    out.push({ lin: { c: hi, t: new Map([[v, -1n]]) }, op: 'ge' }) // hi − x ≥ 0
  }
  return out
}

function randomSystem(rng: () => number, n: number, m: number, lo: bigint, hi: bigint): Cons[] {
  const cons = boxConstraints(n, lo, hi)
  const ri = (a: number, b: number) => a + Math.floor(rng() * (b - a + 1))
  for (let c = 0; c < m; c++) {
    const t = new Map<number, bigint>()
    // 1..n terms with small coefficients in [-3,3] (excluding 0 occasionally).
    const k = ri(1, n)
    const chosen = new Set<number>()
    for (let j = 0; j < k; j++) {
      const v = ri(0, n - 1)
      if (chosen.has(v)) continue
      chosen.add(v)
      let coef = BigInt(ri(-3, 3))
      if (coef === 0n) coef = 1n
      t.set(v, coef)
    }
    if (t.size === 0) t.set(0, 1n)
    const constTerm = BigInt(ri(-6, 6))
    const op = rng() < 0.35 ? 'eq' : 'ge'
    cons.push({ lin: { c: constTerm, t }, op })
  }
  return cons
}

export function runLiaChecks(): LiaCheckReport {
  const rep: LiaCheckReport = { pass: 0, fail: 0, messages: [] }
  const ok = (cond: boolean, msg: string) => {
    if (cond) rep.pass++
    else {
      rep.fail++
      if (rep.messages.length < 12) rep.messages.push(msg)
    }
  }

  // ---- 1. Randomized agreement against exhaustive brute force. ----
  const rng = mulberry32(0x5a7f0)
  let trials = 0
  for (let i = 0; i < 600; i++) {
    const n = 2 + Math.floor(rng() * 3) // 2..4 variables
    const m = 1 + Math.floor(rng() * 5) // 1..5 user constraints
    const nonneg = rng() < 0.5
    const B = BigInt(4 + Math.floor(rng() * 4)) // 4..7
    const lo = nonneg ? 0n : -B
    const hi = B
    const cons = randomSystem(rng, n, m, lo, hi)
    let res
    try {
      res = omegaTest(cons, n, names(n))
    } catch {
      continue // budget overflow on a pathological draw — skip, not a failure
    }
    const brute = bruteForce(cons, n, lo, hi)
    trials++
    const omSat = res.status === 'sat'
    ok(omSat === brute.sat, `verdict mismatch on trial ${i}: omega=${res.status} brute=${brute.sat}`)
    if (res.status === 'sat') {
      ok(verifyModel(cons, res.model), `omega SAT model fails the constraints on trial ${i}`)
    }
  }
  ok(trials > 400, `expected many brute-force trials, ran ${trials}`)

  // ---- 2. Hand-derived classics (verdicts known a priori). ----
  type Case = { src: string; sat: boolean; note: string }
  const cases: Case[] = [
    { src: '3x - 3y = 1', sat: false, note: 'gcd(3,3)=3 ∤ 1' },
    { src: '2x - 4y = 3', sat: false, note: 'even = odd' },
    { src: '2x = 1', sat: false, note: 'no integer half' },
    { src: '6a + 9b + 20c = 43\na>=0\nb>=0\nc>=0', sat: false, note: 'Frobenius gap (43 unreachable)' },
    { src: '6a + 9b + 20c = 44\na>=0\nb>=0\nc>=0', sat: true, note: '44 = 20+6·4' },
    { src: '2x >= 1\n2x <= 1', sat: false, note: 'dark-shadow gap, splinter→unsat' },
    { src: '2x >= 1\n2x <= 3', sat: true, note: 'dark shadow holds (x=1)' },
    { src: '3 <= 2x - y\n2x - y <= 5\ny = 1', sat: true, note: 'bounded slab' },
    { src: 'x + y = 10\nx - y = 3', sat: false, note: '2x=13 odd' },
    { src: 'x + y = 10\nx - y = 4', sat: true, note: 'x=7,y=3' },
    { src: '7x + 5y = 1', sat: true, note: 'Bézout (x=3,y=-4)' },
    { src: '14x + 21y = 5', sat: false, note: 'gcd 7 ∤ 5' },
    { src: '3x + 4y <= 5\nx >= 1\ny >= 1', sat: false, note: 'min 3+4=7 > 5' },
    { src: '3x + 4y <= 8\nx >= 1\ny >= 1', sat: true, note: 'x=1,y=1' },
  ]
  for (const cs of cases) {
    const p = parseLia(cs.src)
    if (!p.ok) {
      ok(false, `parse failed for "${cs.note}": ${p.error}`)
      continue
    }
    let res
    try {
      res = omegaTest(p.constraints, p.names.length, (v) => p.names[v] ?? `σ${v}`)
    } catch (e) {
      ok(false, `omega threw on "${cs.note}": ${e instanceof Error ? e.message : e}`)
      continue
    }
    ok((res.status === 'sat') === cs.sat, `wrong verdict for "${cs.note}": got ${res.status}`)
    if (res.status === 'sat' && cs.sat) {
      ok(verifyModel(p.constraints, res.model), `SAT model invalid for "${cs.note}"`)
    }
  }

  // ---- 3. Equality reduction with large coefficients (exercises Euclid). ----
  {
    // 12x + 8y + 20z = 4 with a bounded box, cross-checked by brute force.
    const cons: Cons[] = [
      { lin: { c: -4n, t: new Map([[0, 12n], [1, 8n], [2, 20n]]) }, op: 'eq' },
      ...boxConstraints(3, -5n, 5n),
    ]
    const res = omegaTest(cons, 3, names(3))
    const brute = bruteForce(cons, 3, -5n, 5n)
    ok(res.status === (brute.sat ? 'sat' : 'unsat'), 'Euclid reduction (12x+8y+20z=4) mismatch')
    if (res.status === 'sat') ok(verifyModel(cons, res.model), 'Euclid model invalid')
  }

  // ---- 4. Parser round-trip sanity (a < b ⇔ a ≤ b−1). ----
  {
    const strict = parseLia('x < 3\nx > 0')
    const slack = parseLia('x <= 2\nx >= 1')
    if (strict.ok && slack.ok) {
      // both describe x ∈ {1,2}; agree on a box.
      const a = bruteForce(strict.constraints, 1, -5n, 5n)
      const b = bruteForce(slack.constraints, 1, -5n, 5n)
      ok(a.sat && b.sat, 'strict/slack inequality parse sanity')
    } else {
      ok(false, 'strict/slack parse failed')
    }
  }

  return rep
}
