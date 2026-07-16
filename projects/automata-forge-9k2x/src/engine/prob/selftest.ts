// The in-app proof harness for the probabilistic engine. The house style of this lab is a DIFFERENTIAL
// proof: compute every number several structurally-unrelated ways and assert they agree. Here that is
//   • exact rational linear-solve  vs  floating-point value iteration  vs  Monte-Carlo frequency,
//   • the graph pre-analysis (Prob0/Prob1) pinned against the exact probabilities it is supposed to bracket,
//   • the MDP value iteration pinned against a brute-force scan of every deterministic policy,
//   • a battery of KNOWN closed-form answers (the die's 1/6, craps' 244/495, ruin's i/N, a 2/7 steady state),
//   • and the algebraic laws a PCTL probability must obey (bounded ≤ unbounded, G = 1 − F¬, Pmax ≥ Pmin).
// Every check is recomputed live; nothing is a stored constant except the textbook targets themselves.

import type { DTMC, MDP, Dist, Action, Model } from './types.ts'
import type { Frac } from './frac.ts'
import { fr, fadd, feq, ftoNumber, F0, F1, fcmp } from './frac.ts'
import { validate } from './types.ts'
import {
  reachExact,
  reachFloat,
  boundedUntilExact,
  nextExact,
  expectedStepsExact,
  steadyStateExact,
  prob0,
  prob1,
} from './dtmc.ts'
import { solve, residual } from './linalg.ts'
import { optimalReachFloat, bruteForceReach, policyIterationExact, policyValueExact } from './mdp.ts'
import { estimateUntil } from './simulate.ts'
import { mulberry32 } from './simulate.ts'
import { parseModel, serializeModel } from './parser.ts'
import { PROB_EXAMPLES } from './examples.ts'
import { parsePctl, queryProb, checkState } from './pctl.ts'

export interface TestResult {
  name: string
  pass: boolean
  detail: string
}

export interface SelfTestReport {
  results: TestResult[]
  passed: number
  total: number
  ok: boolean
}

const ALLn = (n: number): boolean[] => new Array<boolean>(n).fill(true)

function propMask(m: Model, prop: string): boolean[] {
  return m.label.map((l) => l.has(prop))
}

// ---- random model generators (seeded, so the proof is reproducible) --------

function randomDist(rand: () => number, n: number, from: number): Dist {
  const k = 1 + Math.floor(rand() * 3)
  const targets = new Set<number>()
  while (targets.size < Math.min(k, n)) targets.add(Math.floor(rand() * n))
  const ts = [...targets]
  const weights = ts.map(() => 1 + Math.floor(rand() * 5))
  const total = weights.reduce((a, b) => a + b, 0)
  void from
  return ts.map((to, i) => ({ to, p: fr(weights[i], total) }))
}

function randomDTMC(seed: number, n: number): DTMC {
  const rand = mulberry32(seed)
  const goal = n - 1
  const trans: Dist[] = []
  for (let s = 0; s < n; s++) {
    if (s === goal) trans[s] = [{ to: goal, p: F1 }]
    else trans[s] = randomDist(rand, n, s)
  }
  const label: Set<string>[] = Array.from({ length: n }, () => new Set<string>())
  label[goal].add('goal')
  return {
    kind: 'dtmc',
    n,
    labels: Array.from({ length: n }, (_, i) => `s${i}`),
    init: 0,
    props: ['goal'],
    label,
    trans,
    pos: Array.from({ length: n }, () => ({ x: 0, y: 0 })),
  }
}

function randomMDP(seed: number, n: number): MDP {
  const rand = mulberry32(seed)
  const goal = n - 1
  const actions: Action[][] = []
  for (let s = 0; s < n; s++) {
    if (s === goal) {
      actions[s] = [{ name: 'stay', dist: [{ to: goal, p: F1 }] }]
      continue
    }
    const na = 1 + Math.floor(rand() * 2)
    const menu: Action[] = []
    for (let a = 0; a < na; a++) menu.push({ name: `a${a}`, dist: randomDist(rand, n, s) })
    actions[s] = menu
  }
  const label: Set<string>[] = Array.from({ length: n }, () => new Set<string>())
  label[goal].add('goal')
  return {
    kind: 'mdp',
    n,
    labels: Array.from({ length: n }, (_, i) => `s${i}`),
    init: 0,
    props: ['goal'],
    label,
    actions,
    pos: Array.from({ length: n }, () => ({ x: 0, y: 0 })),
  }
}

function maxAbsDiff(a: number[], b: number[]): number {
  let d = 0
  for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i] - b[i]))
  return d
}

export function runProbSelfTest(): SelfTestReport {
  const results: TestResult[] = []
  const add = (name: string, pass: boolean, detail: string) => results.push({ name, pass, detail })

  // 1. Exact rational reachability ≡ floating-point value iteration (the headline).
  {
    let worst = 0
    let checked = 0
    for (let seed = 1; seed <= 250; seed++) {
      const n = 4 + (seed % 5)
      const m = randomDTMC(seed * 13 + 1, n)
      const goal = propMask(m, 'goal')
      const ex = reachExact(m, goal).map(ftoNumber)
      const fl = reachFloat(m, goal).value
      worst = Math.max(worst, maxAbsDiff(ex, fl))
      checked++
    }
    add('exact linear-solve ≡ value iteration', worst < 1e-6, `${checked} random DTMCs, max |exact − VI| = ${worst.toExponential(2)}`)
  }

  // 2. Monte-Carlo frequency ≈ exact probability (law of large numbers).
  {
    let worst = 0
    const details: string[] = []
    for (const seed of [3, 17, 42, 91]) {
      const m = randomDTMC(seed * 7 + 5, 6)
      const goal = propMask(m, 'goal')
      const exact = ftoNumber(reachExact(m, goal)[m.init])
      const est = estimateUntil(m, ALLn(m.n), goal, seed * 101 + 1, 40000)
      worst = Math.max(worst, Math.abs(est.estimate - exact))
    }
    void details
    add('Monte-Carlo ≈ exact (40k samples)', worst < 0.03, `max |empirical − exact| = ${worst.toFixed(4)} (< 0.03)`)
  }

  // 3. Prob0 / Prob1 graph analysis brackets the exact probabilities.
  {
    let bad = 0
    let checked = 0
    for (let seed = 1; seed <= 150; seed++) {
      const m = randomDTMC(seed * 29 + 3, 5 + (seed % 4))
      const goal = propMask(m, 'goal')
      const ex = reachExact(m, goal)
      const p0 = prob0(m, ALLn(m.n), goal)
      const p1 = prob1(m, ALLn(m.n), goal)
      for (let s = 0; s < m.n; s++) {
        const isZero = ex[s].n === 0n
        const isOne = ex[s].n === ex[s].d
        if (isZero !== p0[s] || isOne !== p1[s]) bad++
        checked++
      }
    }
    add('Prob0 ⇔ (p=0) and Prob1 ⇔ (p=1)', bad === 0, `${checked} states, ${bad} mismatches`)
  }

  // 4. The exact linear solver returns a true solution (zero residual) — random systems.
  {
    let bad = 0
    for (let seed = 1; seed <= 60; seed++) {
      const rand = mulberry32(seed * 5 + 2)
      const n = 2 + (seed % 5)
      const A: Frac[][] = Array.from({ length: n }, () => Array.from({ length: n }, () => fr(Math.floor(rand() * 11) - 5, 1 + Math.floor(rand() * 6))))
      // make it diagonally dominant so it's non-singular
      for (let i = 0; i < n; i++) A[i][i] = fr(10 + Math.floor(rand() * 5), 1)
      const b: Frac[] = Array.from({ length: n }, () => fr(Math.floor(rand() * 11) - 5, 1 + Math.floor(rand() * 4)))
      const x = solve(A, b)
      if (!x) {
        bad++
        continue
      }
      const r = residual(A, x, b)
      if (r.some((v) => v.n !== 0n)) bad++
    }
    add('rational Gauss–Jordan: exact zero residual', bad === 0, `60 random systems, ${bad} non-zero residuals`)
  }

  // 5. Known answers — the die.
  {
    const m = mustModel('dice')
    const six = propMask(m, 'six')
    const done = propMask(m, 'done')
    const p6 = reachExact(m as DTMC, six)[m.init]
    const es = expectedStepsExact(m as DTMC, done)[m.init]
    const faceOk = feq(p6, fr(1, 6))
    const stepsOk = es !== null && feq(es, fr(11, 3))
    add('Knuth–Yao die: P(six)=1/6, E[flips]=11/3', faceOk && stepsOk, `P(six)=${fracStr(p6)}, E=${es ? fracStr(es) : '∞'}`)
  }

  // 6. Known answers — craps.
  {
    const m = mustModel('craps') as DTMC
    const win = reachExact(m, propMask(m, 'win'))[m.init]
    const lose = reachExact(m, propMask(m, 'lose'))[m.init]
    const sumOne = feq(fadd(win, lose), F1)
    add('Craps: P(win)=244/495', feq(win, fr(244, 495)) && sumOne, `P(win)=${fracStr(win)}, P(lose)=${fracStr(lose)}`)
  }

  // 7. Known answers — gambler's ruin i/N and steady-state 2/7.
  {
    const m = mustModel('ruin') as DTMC
    const target = propMask(m, 'target')
    const ex = reachExact(m, target)
    const at = (name: string) => ex[m.labels.indexOf(name)]
    // from gi the probability of reaching the target g6 is exactly i/6.
    let ok = true
    for (let i = 0; i <= 6; i++) if (!feq(at(`g${i}`), fr(i, 6))) ok = false
    add("Gambler's ruin: P(reach N from i) = i/N", ok, `g1=${fracStr(at('g1'))}, g3=${fracStr(at('g3'))}, g5=${fracStr(at('g5'))}`)

    const w = mustModel('weather') as DTMC
    const rain = steadyStateExact(w, propMask(w, 'rain'))[w.init]
    add('Weather: steady-state P(rain) = 2/7', feq(rain, fr(2, 7)), `S=[rain] = ${fracStr(rain)}`)
  }

  // 8. Bounded reachability is monotone in k and converges up to the unbounded value.
  {
    const m = mustModel('retry') as DTMC
    const ok = propMask(m, 'ok')
    const unb = reachExact(m, ok)[m.init]
    let mono = true
    let prev = F0
    for (let k = 0; k <= 8; k++) {
      const v = boundedUntilExact(m, ALLn(m.n), ok, k)[m.init]
      if (fcmp(v, prev) < 0) mono = false
      if (fcmp(v, unb) > 0) mono = false
      prev = v
    }
    const k1 = boundedUntilExact(m, ALLn(m.n), ok, 1)[m.init]
    const k3 = boundedUntilExact(m, ALLn(m.n), ok, 3)[m.init]
    add('bounded Pr(F≤k) monotone ↑ and ≤ Pr(F)', mono && feq(k1, fr(9, 10)) && feq(k3, fr(999, 1000)), `F≤1=${fracStr(k1)}, F≤3=${fracStr(k3)}, F=${fracStr(unb)}`)
  }

  // 9. The "next" identity: for ¬ψ states, Pr(F≤1 ψ) = Pr(X ψ).
  {
    let bad = 0
    for (let seed = 1; seed <= 80; seed++) {
      const m = randomDTMC(seed * 37 + 9, 5 + (seed % 4))
      const goal = propMask(m, 'goal')
      const nx = nextExact(m, goal)
      const b1 = boundedUntilExact(m, ALLn(m.n), goal, 1)
      for (let s = 0; s < m.n; s++) if (!goal[s] && !feq(nx[s], b1[s])) bad++
    }
    add('Pr(F≤1 ψ) = Pr(X ψ) on ¬ψ states', bad === 0, `80 random DTMCs, ${bad} mismatches`)
  }

  // 10. G φ = 1 − F ¬φ (via the PCTL evaluator) on the gallery.
  {
    let worst = 0
    for (const ex of PROB_EXAMPLES) {
      const m = mustModel(ex.id)
      if (m.kind !== 'dtmc') continue
      const prop = m.props[0]
      if (!prop) continue
      const g = queryProb(m, parsePctl(`P=? [ G ${prop} ]`))
      const f = queryProb(m, parsePctl(`P=? [ F !${prop} ]`))
      for (let s = 0; s < m.n; s++) worst = Math.max(worst, Math.abs(g.approx[s] - (1 - f.approx[s])))
    }
    add('duality: Pr(G φ) = 1 − Pr(F ¬φ)', worst < 1e-9, `max deviation ${worst.toExponential(2)}`)
  }

  // 11. MDP value iteration ≡ brute-force policy oracle (max and min), exactly.
  {
    let bad = 0
    let checked = 0
    for (let seed = 1; seed <= 120; seed++) {
      const m = randomMDP(seed * 17 + 4, 3 + (seed % 3))
      const goal = propMask(m, 'goal')
      for (const opt of ['max', 'min'] as const) {
        const bf = bruteForceReach(m, goal, opt)
        if (!bf) continue
        const vi = optimalReachFloat(m, goal, opt)
        if (Math.abs(vi.value[m.init] - ftoNumber(bf.value[m.init])) > 1e-6) bad++
        checked++
      }
    }
    add('MDP value iteration ≡ brute-force policy oracle', bad === 0, `${checked} (MDP, opt) pairs, ${bad} disagreements`)
  }

  // 12. MDP exact policy iteration ≡ brute-force oracle (rational equality), float VI agrees, Pmax ≥ Pmin.
  {
    let piBad = 0
    let viBad = 0
    let orderBad = 0
    let checked = 0
    for (let seed = 1; seed <= 120; seed++) {
      const m = randomMDP(seed * 23 + 6, 3 + (seed % 3))
      const goal = propMask(m, 'goal')
      const all = ALLn(m.n)
      for (const opt of ['max', 'min'] as const) {
        const bf = bruteForceReach(m, goal, opt)
        if (!bf) continue
        const pi = policyIterationExact(m, all, goal, opt)
        const vi = optimalReachFloat(m, goal, opt)
        if (!feq(pi.value[m.init], bf.value[m.init])) piBad++
        if (Math.abs(vi.value[m.init] - ftoNumber(pi.value[m.init])) > 1e-6) viBad++
        checked++
      }
      const mx = policyIterationExact(m, all, goal, 'max')
      const mn = policyIterationExact(m, all, goal, 'min')
      for (let s = 0; s < m.n; s++) if (fcmp(mx.value[s], mn.value[s]) < 0) orderBad++
    }
    add('MDP exact policy iteration ≡ oracle; VI agrees; Pmax ≥ Pmin', piBad === 0 && viBad === 0 && orderBad === 0, `${checked} (MDP,opt): PI≠oracle ${piBad}, VI≠PI ${viBad}, order ${orderBad}`)
  }

  // 13. MDP known answers — corridor and gambler.
  {
    const c = mustModel('corridor') as MDP
    const cg = propMask(c, 'goal')
    const cmax = optimalReachFloat(c, cg, 'max').value[c.init]
    const cmin = optimalReachFloat(c, cg, 'min').value[c.init]
    const corridorOk = Math.abs(cmax - 0.343) < 1e-6 && cmin < 1e-9

    const g = mustModel('gambler') as MDP
    const gg = propMask(g, 'rich')
    const gmaxVI = optimalReachFloat(g, gg, 'max')
    const gmaxCert = policyValueExact(g, gmaxVI.policy, ALLn(g.n), gg)[g.init]
    const gamblerOk = feq(gmaxCert, fr(4, 25))
    add('MDP known: corridor Pmax=0.343/Pmin=0, gambler Pmax=4/25', corridorOk && gamblerOk, `corridor max=${cmax.toFixed(3)} min=${cmin.toFixed(3)}, gambler Pmax=${fracStr(gmaxCert)}`)
  }

  // 14. Every gallery model is well-formed and round-trips through the textual serializer.
  {
    let bad = 0
    const notes: string[] = []
    for (const ex of PROB_EXAMPLES) {
      const m = mustModel(ex.id)
      if (validate(m).length) {
        bad++
        notes.push(`${ex.id} invalid`)
        continue
      }
      const re = parseModel(serializeModel(m))
      if (!re.model || re.errors.length) {
        bad++
        notes.push(`${ex.id} reparse`)
        continue
      }
      // reach probabilities must survive the round trip
      const p0 = probeReach(m)
      const p1 = probeReach(re.model)
      if (Math.abs(p0 - p1) > 1e-9) {
        bad++
        notes.push(`${ex.id} prob drift`)
      }
    }
    add('gallery: valid + textual round-trip preserves probabilities', bad === 0, bad ? notes.join(', ') : `${PROB_EXAMPLES.length} models round-trip exactly`)
  }

  // 15. PCTL comparison duality: ¬(P<p[ψ]) sat-set = P>=p[ψ] sat-set.
  {
    let bad = 0
    for (const ex of PROB_EXAMPLES) {
      const m = mustModel(ex.id)
      if (m.kind !== 'dtmc') continue
      const prop = m.props[0]
      const lt = checkState(m, parsePctl(`P<1/2 [ F ${prop} ]`))
      const ge = checkState(m, parsePctl(`P>=1/2 [ F ${prop} ]`))
      for (let s = 0; s < m.n; s++) if (lt[s] === ge[s]) bad++
    }
    add('PCTL: ¬(P<p) ≡ P≥p as satisfaction sets', bad === 0, `${bad} states where the two overlapped`)
  }

  const passed = results.filter((r) => r.pass).length
  return { results, passed, total: results.length, ok: passed === results.length }
}

// ---- helpers ---------------------------------------------------------------

function mustModel(id: string): Model {
  const ex = PROB_EXAMPLES.find((e) => e.id === id)
  if (!ex) throw new Error(`missing example ${id}`)
  const { model } = parseModel(ex.source)
  if (!model) throw new Error(`example ${id} failed to parse`)
  return model
}

function probeReach(m: Model): number {
  const prop = m.props[0]
  if (!prop) return 0
  const goal = m.label.map((l) => l.has(prop))
  if (m.kind === 'dtmc') return ftoNumber(reachExact(m, goal)[m.init])
  return optimalReachFloat(m, goal, 'max').value[m.init]
}

function fracStr(f: Frac): string {
  return f.d === 1n ? f.n.toString() : `${f.n}/${f.d}`
}
