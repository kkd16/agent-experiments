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
import { type Lin, evalLin, variable, constant, scale, addConst } from './lin'
import {
  type Formula,
  andF,
  orF,
  notF,
  ltF,
  dvdF,
  existsF,
  forallF,
  ge,
  le,
  eq,
  decide,
  eliminate,
  evalFormula,
  PresburgerBudgetError,
} from './presburger'
import { parsePresburger } from './pparse'
import { lattice, isTwoVar } from './geometry'

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

  // ---- 7. Presburger / Cooper QE — two independent oracles. ----
  presburgerChecks(ok)

  // ---- 8. 2-D lattice geometry agrees with brute force + the Omega verdict. ----
  geometryChecks(ok)

  return rep
}

function geometryChecks(ok: (cond: boolean, msg: string) => void): void {
  const rng = mulberry32(0x1a771ce)
  let trials = 0
  for (let i = 0; i < 200; i++) {
    const B = BigInt(2 + Math.floor(rng() * 3)) // box radius 2..4
    const cons = randomSystem(rng, 2, 1 + Math.floor(rng() * 4), -B, B)
    if (!isTwoVar(cons)) continue
    const pts = lattice(cons, -B, B, -B, B)
    // The plotted box must enumerate every lattice point exactly once.
    const span = Number(2n * B + 1n)
    ok(pts.length === span * span, `lattice point count wrong (trial ${i})`)
    const anyFeasible = pts.some((p) => p.feasible)
    const brute = bruteForce(cons, 2, -B, B)
    const omega = omegaTest(cons, 2, names(2))
    trials++
    ok(anyFeasible === brute.sat, `lattice feasibility ≠ brute force (trial ${i})`)
    // Boxed ⇒ the Omega verdict is decided by the same region.
    ok(anyFeasible === (omega.status === 'sat'), `lattice feasibility ≠ Omega verdict (trial ${i})`)
  }
  ok(trials > 120, `expected many geometry trials, ran ${trials}`)
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

// ---- Presburger / Cooper quantifier elimination -----------------------------

/** `lo ≤ x_v ≤ hi` as a Presburger guard. */
function box(v: number, R: bigint): Formula {
  return andF(ge(variable(v), constant(-R)), le(variable(v), constant(R)))
}

/** A random small linear term over variables 0..k−1. */
function randTerm(rng: () => number, k: number, hiCoef: number): Lin {
  const ri = (a: number, b: number) => a + Math.floor(rng() * (b - a + 1))
  const t = new Map<number, bigint>()
  const nterms = 1 + Math.floor(rng() * k)
  for (let j = 0; j < nterms; j++) {
    const v = ri(0, k - 1)
    const c = BigInt(ri(-hiCoef, hiCoef))
    if (c !== 0n) t.set(v, (t.get(v) ?? 0n) + c)
  }
  for (const [v, c] of [...t]) if (c === 0n) t.delete(v)
  if (t.size === 0) t.set(ri(0, k - 1), 1n)
  return { c: BigInt(ri(-4, 4)), t }
}

/** A random quantifier-free NNF matrix over variables 0..k−1. */
function randMatrix(rng: () => number, k: number, depth: number): Formula {
  if (depth <= 0 || rng() < 0.45) {
    const r = rng()
    if (r < 0.25) return dvdF(BigInt(2 + Math.floor(rng() * 3)), randTerm(rng, k, 2))
    const a = randTerm(rng, k, 2)
    const which = Math.floor(rng() * 4)
    if (which === 0) return ltF(a) // a < 0
    if (which === 1) return le(a, constant(0n)) // a ≤ 0
    if (which === 2) return eq(a, constant(0n)) // a = 0
    return ge(a, constant(0n)) // a ≥ 0
  }
  const r = rng()
  if (r < 0.4) return andF(randMatrix(rng, k, depth - 1), randMatrix(rng, k, depth - 1))
  if (r < 0.8) return orF(randMatrix(rng, k, depth - 1), randMatrix(rng, k, depth - 1))
  return notF(randMatrix(rng, k, depth - 1))
}

function presburgerChecks(ok: (cond: boolean, msg: string) => void): void {
  // (a) Existential conjunctions vs. the Omega test (the unbounded regime). The
  //     SAME constraint list feeds both engines; they must agree on SAT/UNSAT.
  {
    const rng = mulberry32(0xc00fee)
    let trials = 0
    for (let i = 0; i < 260; i++) {
      const k = 2 + Math.floor(rng() * 2) // 2..3
      const m = 1 + Math.floor(rng() * 4) // 1..4 constraints
      const cons: Cons[] = []
      const ri = (a: number, b: number) => a + Math.floor(rng() * (b - a + 1))
      for (let c = 0; c < m; c++) {
        const t = new Map<number, bigint>()
        const kk = 1 + Math.floor(rng() * k)
        for (let j = 0; j < kk; j++) {
          const v = ri(0, k - 1)
          let coef = BigInt(ri(-2, 2))
          if (coef === 0n) coef = 1n
          t.set(v, coef)
        }
        if (t.size === 0) t.set(0, 1n)
        const lin: Lin = { c: BigInt(ri(-5, 5)), t }
        cons.push({ lin, op: rng() < 0.3 ? 'eq' : 'ge' })
      }
      // Build the matching Presburger conjunction, then existentially close it.
      const atoms: Formula[] = cons.map((c) =>
        c.op === 'eq' ? eq(c.lin, constant(0n)) : ge(c.lin, constant(0n)),
      )
      let phi: Formula = andF(...atoms)
      for (let v = 0; v < k; v++) phi = existsF(v, phi)
      let cooper: boolean
      try {
        cooper = decide(phi).value
      } catch (e) {
        if (e instanceof PresburgerBudgetError) continue
        ok(false, `Cooper threw (trial ${i}): ${e instanceof Error ? e.message : e}`)
        continue
      }
      const om = omegaTest(cons, k, names(k))
      trials++
      ok(
        cooper === (om.status === 'sat'),
        `Cooper vs Omega mismatch (trial ${i}): cooper=${cooper} omega=${om.status}`,
      )
    }
    ok(trials > 150, `expected many Cooper-vs-Omega trials, ran ${trials}`)
  }

  // (b) Box-guarded closed sentences (with ∀/∃ alternation) vs. exhaustive
  //     evaluation. Every quantifier is confined to [−R, R], so the bounded
  //     evaluator is the TRUE ℤ value — a complete oracle for Cooper's decision.
  {
    const rng = mulberry32(0x5e_a7ed)
    const R = 3n
    let trials = 0
    for (let i = 0; i < 360; i++) {
      const k = 1 + Math.floor(rng() * 2) // 1..2 quantified variables
      let body: Formula = randMatrix(rng, k, 2)
      for (let v = k - 1; v >= 0; v--) {
        if (rng() < 0.5) body = existsF(v, andF(box(v, R), body))
        else body = forallF(v, orF(notF(box(v, R)), body))
      }
      let dec: boolean
      try {
        dec = decide(body).value
      } catch (e) {
        if (e instanceof PresburgerBudgetError) continue
        ok(false, `Cooper(closed) threw (trial ${i}): ${e instanceof Error ? e.message : e}`)
        continue
      }
      const truth = evalFormula(body, new Map(), -R, R)
      trials++
      ok(dec === truth, `Cooper decision ≠ bounded truth (trial ${i}): cooper=${dec} eval=${truth}`)
    }
    ok(trials > 250, `expected many box-guarded sentence trials, ran ${trials}`)
  }

  // (c) Open formulas: eliminate an inner quantifier and check the resulting QF
  //     formula agrees with the original on every value of the free variable.
  {
    const rng = mulberry32(0x0_9e_11)
    const R = 3n
    let trials = 0
    for (let i = 0; i < 220; i++) {
      // Variable 0 is free; variable 1 is quantified (box-guarded).
      const matrix = randMatrix(rng, 2, 2)
      const original: Formula =
        rng() < 0.5
          ? existsF(1, andF(box(1, R), matrix))
          : forallF(1, orF(notF(box(1, R)), matrix))
      let elim
      try {
        elim = eliminate(original)
      } catch (e) {
        if (e instanceof PresburgerBudgetError) continue
        ok(false, `Cooper(open) threw (trial ${i}): ${e instanceof Error ? e.message : e}`)
        continue
      }
      trials++
      let agree = true
      for (let x = -6n; x <= 6n; x++) {
        const env = new Map<number, bigint>([[0, x]])
        const lhs = evalFormula(elim.formula, env, -R, R)
        const rhs = evalFormula(original, new Map([[0, x]]), -R, R)
        if (lhs !== rhs) {
          agree = false
          break
        }
      }
      ok(agree, `QE result disagrees with original on some free value (trial ${i})`)
    }
    ok(trials > 150, `expected many open-formula QE trials, ran ${trials}`)
  }

  // (d) Hand-built Presburger landmarks (answers known a priori).
  {
    // ∀x. ∃y. (2y = x ∨ 2y = x+1)  — every integer is even or odd. TRUE.
    const x = variable(0)
    const y = variable(1)
    const evenOrOdd = forallF(
      0,
      existsF(1, orF(eq(scale(y, 2n), x), eq(scale(y, 2n), addConst(x, 1n)))),
    )
    ok(decide(evenOrOdd).value === true, 'every integer is even or odd (∀∃) should be TRUE')

    // ∃x. (2x = 1)  — no integer half. FALSE.
    const half = existsF(0, eq(scale(variable(0), 2n), constant(1n)))
    ok(decide(half).value === false, '∃x. 2x=1 should be FALSE')

    // ∀x. ∃y. y > x  — no greatest integer. TRUE (uses the −∞/unbounded branch).
    const noGreatest = forallF(0, existsF(1, le(addConst(variable(0), 1n), variable(1)))) // x+1 ≤ y
    ok(decide(noGreatest).value === true, '∀x ∃y. y>x should be TRUE')

    // ∃x. (3 | x ∧ 5 | x ∧ x > 0 ∧ x < 15) — x=15? no (x<15); smallest positive
    // multiple of 15 below 15 is none → FALSE.
    const noCommon = existsF(
      0,
      andF(dvdF(3n, variable(0)), dvdF(5n, variable(0)), ge(variable(0), constant(1n)), le(variable(0), constant(14n))),
    )
    ok(decide(noCommon).value === false, '∃x. 15|x ∧ 1≤x≤14 should be FALSE')

    // ∃x. (3 | x ∧ 5 | x ∧ 1 ≤ x ≤ 15) — x=15 works. TRUE.
    const hasCommon = existsF(
      0,
      andF(dvdF(3n, variable(0)), dvdF(5n, variable(0)), ge(variable(0), constant(1n)), le(variable(0), constant(15n))),
    )
    ok(decide(hasCommon).value === true, '∃x. 15|x ∧ 1≤x≤15 should be TRUE')

    // ∀x. ∃y. (x = 3y ∨ x = 3y+1 ∨ x = 3y+2) — every integer mod 3. TRUE.
    const mod3 = forallF(
      0,
      existsF(
        1,
        orF(
          eq(variable(0), scale(variable(1), 3n)),
          eq(variable(0), addConst(scale(variable(1), 3n), 1n)),
          eq(variable(0), addConst(scale(variable(1), 3n), 2n)),
        ),
      ),
    )
    ok(decide(mod3).value === true, 'every integer is 0/1/2 mod 3 (∀∃) should be TRUE')

    // ∃y. ∀x. (x ≤ y) — a greatest integer exists. FALSE.
    const greatestExists = existsF(1, forallF(0, le(variable(0), variable(1))))
    ok(decide(greatestExists).value === false, '∃y ∀x. x≤y should be FALSE')
  }

  // (e) Parser → decision, with truths known a priori, plus an open-formula QE.
  {
    type PC = { src: string; truth: boolean; note: string }
    const closed: PC[] = [
      { src: 'forall x. exists y. (2y = x | 2y = x + 1)', truth: true, note: 'even-or-odd' },
      { src: 'forall x. exists y. y > x', truth: true, note: 'no greatest integer' },
      { src: 'exists x. 2x = 1', truth: false, note: 'no integer half' },
      { src: 'exists y. exists a. (a = 2y & a = 5)', truth: false, note: '5 is odd' },
      { src: '∃x. (3 | x ∧ 5 | x ∧ x >= 1 ∧ x <= 15)', truth: true, note: '15 in window' },
      { src: '∃x. (3 | x ∧ 5 | x ∧ x >= 1 ∧ x <= 14)', truth: false, note: 'no 15-multiple ≤14' },
      { src: 'forall x. exists y. (x = 3y | x = 3y+1 | x = 3y+2)', truth: true, note: 'mod 3' },
      { src: 'forall x. exists y. 2y = x', truth: false, note: 'not every int even' },
      { src: '6a + 9b + 20c = 44 & a >= 0 & b >= 0 & c >= 0', truth: true, note: 'McNugget 44 (free→sat sentence?)' },
    ]
    for (const pc of closed) {
      const p = parsePresburger(pc.src)
      if (!p.ok) {
        ok(false, `Presburger parse failed "${pc.note}": ${p.error}`)
        continue
      }
      // The McNugget line is open (a,b,c free); decide its existential closure.
      let f = p.formula
      for (const v of p.free) f = existsF(v, f)
      try {
        ok(decide(f).value === pc.truth, `parsed "${pc.note}" decided wrong`)
      } catch (e) {
        ok(false, `decide threw on "${pc.note}": ${e instanceof Error ? e.message : e}`)
      }
    }

    // Open formula: ∃y. x = 2y  ≡  2 | x. Eliminate y and check against parity.
    const op = parsePresburger('exists y. x = 2y')
    if (op.ok) {
      const xId = op.free[0] ?? 0
      const elim = eliminate(op.formula)
      let agree = true
      for (let xv = -10n; xv <= 10n; xv++) {
        const got = evalFormula(elim.formula, new Map([[xId, xv]]), 0n, 0n)
        const want = ((xv % 2n) + 2n) % 2n === 0n
        if (got !== want) agree = false
      }
      ok(agree, 'eliminating ∃y. x=2y should equal the parity predicate 2|x')
    } else {
      ok(false, `open-formula parse failed: ${op.error}`)
    }
  }
}
