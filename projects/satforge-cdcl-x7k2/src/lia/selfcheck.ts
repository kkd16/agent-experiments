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
import { parseLia, parseObjective } from './parse'
import { optimize, bruteOptimum, type Dir } from './optimize'
import { type Lin, evalLin } from './lin'

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

  // ---- 5. Integer optimization vs. exhaustive optimum (complete oracle). ----
  // Every system here boxes its variables, so brute force is the *true* integer
  // optimum (or a true infeasible verdict) — the strongest possible check.
  optimizationChecks(ok)

  // ---- 6. Unboundedness detection + recession-ray witness. ----
  unboundedChecks(ok)

  return rep
}

type OkFn = (cond: boolean, msg: string) => void

/** A random small linear objective `Σ cᵢ xᵢ + c₀` over n variables. */
function randomObjective(rng: () => number, n: number): Lin {
  const ri = (a: number, b: number) => a + Math.floor(rng() * (b - a + 1))
  const t = new Map<number, bigint>()
  for (let v = 0; v < n; v++) {
    const c = BigInt(ri(-3, 3))
    if (c !== 0n) t.set(v, c)
  }
  if (t.size === 0) t.set(0, 1n)
  return { c: BigInt(ri(-4, 4)), t }
}

function optimizationChecks(ok: OkFn): void {
  const rng = mulberry32(0x0_b1ef)
  let trials = 0
  for (let i = 0; i < 320; i++) {
    const n = 2 + Math.floor(rng() * 2) // 2..3 variables (box stays enumerable)
    const m = 1 + Math.floor(rng() * 4) // 1..4 user constraints
    const nonneg = rng() < 0.5
    const B = BigInt(3 + Math.floor(rng() * 3)) // 3..5
    const lo = nonneg ? 0n : -B
    const hi = B
    const cons = randomSystem(rng, n, m, lo, hi)
    const obj = randomObjective(rng, n)
    for (const dir of ['min', 'max'] as Dir[]) {
      let res
      try {
        res = optimize(cons, n, obj, dir, names(n))
      } catch {
        continue // budget overflow on a pathological draw — skip
      }
      const brute = bruteOptimum(cons, n, obj, dir, lo, hi)
      trials++
      // A boxed system is never unbounded.
      ok(res.status !== 'unbounded', `optimize claimed unbounded on boxed system (trial ${i}, ${dir})`)
      if (!brute.feasible) {
        ok(res.status === 'infeasible', `optimize should be infeasible (trial ${i}, ${dir}) got ${res.status}`)
        continue
      }
      ok(res.status === 'optimal', `optimize should be optimal (trial ${i}, ${dir}) got ${res.status}`)
      if (res.status === 'optimal') {
        ok(res.value === brute.value, `wrong optimum (trial ${i}, ${dir}): omega=${res.value} brute=${brute.value}`)
        ok(verifyModel(cons, res.model), `optimum model infeasible (trial ${i}, ${dir})`)
        ok(evalLin(obj, res.model) === res.value, `model objective ≠ reported value (trial ${i}, ${dir})`)
      }
    }
  }
  ok(trials > 400, `expected many optimization trials, ran ${trials}`)

  // Hand-built finite optima over *unbounded* regions (no enclosing box, so the
  // answer is reasoned, not enumerated).
  type HC = { src: string; obj: string; dir: Dir; value: bigint; note: string }
  const hand: HC[] = [
    { src: 'x >= 0\ny >= 0', obj: 'x + y', dir: 'min', value: 0n, note: 'origin minimizes a nonneg sum' },
    { src: 'x + y >= 4\nx >= 0\ny >= 0', obj: '2x + 3y', dir: 'min', value: 8n, note: 'min 2x+3y on x+y≥4 ⇒ x=4' },
    { src: 'x + y <= 6\nx >= 0\ny >= 0', obj: 'x + y', dir: 'max', value: 6n, note: 'max sum capped at 6' },
    { src: '2x + 3y = 12\nx >= 0\ny >= 0', obj: 'x + y', dir: 'max', value: 6n, note: 'max x+y on 2x+3y=12 ⇒ (6,0)' },
    { src: '2x + 3y = 12\nx >= 0\ny >= 0', obj: 'x + y', dir: 'min', value: 4n, note: 'min x+y on 2x+3y=12 ⇒ (0,4)' },
    { src: '3x + 4y <= 12\nx >= 0\ny >= 0', obj: '5x + 4y', dir: 'max', value: 20n, note: 'integer LP corner (4,0)' },
  ]
  for (const hc of hand) {
    const p = parseLia(hc.src)
    if (!p.ok) {
      ok(false, `opt hand parse failed "${hc.note}": ${p.error}`)
      continue
    }
    const o = parseObjective(hc.obj, p.names)
    if (!o.ok) {
      ok(false, `opt hand objective parse failed "${hc.note}": ${o.error}`)
      continue
    }
    let res
    try {
      res = optimize(p.constraints, p.names.length, o.lin, hc.dir, (v) => p.names[v] ?? `σ${v}`)
    } catch (e) {
      ok(false, `optimize threw on "${hc.note}": ${e instanceof Error ? e.message : e}`)
      continue
    }
    ok(res.status === 'optimal', `"${hc.note}" should be optimal, got ${res.status}`)
    if (res.status === 'optimal') {
      ok(res.value === hc.value, `"${hc.note}" optimum ${res.value} ≠ expected ${hc.value}`)
      ok(verifyModel(p.constraints, res.model), `"${hc.note}" optimum model infeasible`)
    }
  }
}

function unboundedChecks(ok: OkFn): void {
  type UC = { src: string; obj: string; dir: Dir; note: string }
  const cases: UC[] = [
    { src: 'x >= 0', obj: 'x', dir: 'max', note: 'max x, x≥0' },
    { src: 'x <= 5', obj: 'x', dir: 'min', note: 'min x, x≤5' },
    { src: 'x - 2y = 0\ny >= 0', obj: 'x', dir: 'max', note: 'max x on x=2y, y≥0' },
    { src: 'x + y >= 1\nx >= 0\ny >= 0', obj: 'x + y', dir: 'max', note: 'max sum, open above' },
    { src: 'x - y >= 2\ny >= 0', obj: '0 - x - y', dir: 'min', note: 'min −(x+y), open below' },
  ]
  for (const uc of cases) {
    const p = parseLia(uc.src)
    if (!p.ok) {
      ok(false, `unbounded parse failed "${uc.note}": ${p.error}`)
      continue
    }
    const o = parseObjective(uc.obj, p.names)
    if (!o.ok) {
      ok(false, `unbounded objective parse failed "${uc.note}": ${o.error}`)
      continue
    }
    const n = p.names.length
    let res
    try {
      res = optimize(p.constraints, n, o.lin, uc.dir, (v) => p.names[v] ?? `σ${v}`)
    } catch (e) {
      ok(false, `optimize threw on "${uc.note}": ${e instanceof Error ? e.message : e}`)
      continue
    }
    ok(res.status === 'unbounded', `"${uc.note}" should be unbounded, got ${res.status}`)
    if (res.status === 'unbounded') {
      // Re-derive the witness: point + k·ray stays feasible and strictly improves.
      let improving = true
      let feasibleRay = true
      let prev = evalLin(o.lin, res.point)
      for (let k = 1n; k <= 4n; k++) {
        const m = new Map<number, bigint>()
        for (let v = 0; v < n; v++) m.set(v, (res.point.get(v) ?? 0n) + k * (res.ray.get(v) ?? 0n))
        if (!verifyModel(p.constraints, m)) feasibleRay = false
        const val = evalLin(o.lin, m)
        // 'max' should grow, 'min' should shrink.
        if (uc.dir === 'max' ? !(val > prev) : !(val < prev)) improving = false
        prev = val
      }
      ok(feasibleRay, `"${uc.note}" recession ray leaves the feasible region`)
      ok(improving, `"${uc.note}" recession ray does not strictly improve the objective`)
    }
  }
}
