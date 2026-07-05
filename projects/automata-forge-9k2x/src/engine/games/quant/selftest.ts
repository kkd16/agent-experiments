// The in-app proof harness for the quantitative-games engine. Every number the Quant view reports is
// re-derived here and cross-checked against machinery it shares no logic with:
//   • value iteration (Zwick–Paterson) vs a brute-force **oracle** that enumerates strategy pairs;
//   • the **energy** fixpoint's sign vs the value's sign — two unrelated algorithms, one answer;
//   • an independent **certificate** (pin the strategies, inspect the cycles) with a teeth test;
//   • the **parity → mean-payoff reduction** measured against Zielonka's already-proven solver.
// Plus the structural laws a value must obey (shift- and scale-invariance) and the curated gallery.

import { randomWArena } from './random'
import { QUANT_EXAMPLES } from './examples'
import { meanPayoffValues } from './meanpayoff'
import { oracleValues } from './oracle'
import { solveEnergy, certifyEnergy } from './energy'
import { parityToMeanPayoff } from './reduce'
import { shiftWeights, scaleWeights } from './types'
import { ratCmp, ratEq, ratAdd, ratMul, rat, type Rational } from './rational'
import { randomArena } from '../random'
import { solveParity } from '../parity'

export interface TestResult {
  name: string
  pass: boolean
  detail: string
}

function sameRats(a: Rational[], b: Rational[]): boolean {
  return a.length === b.length && a.every((r, i) => ratEq(r, b[i]))
}

export function runQuantSelfTest(): {
  results: TestResult[]
  passed: number
  total: number
  ok: boolean
} {
  const results: TestResult[] = []
  const add = (name: string, pass: boolean, detail: string) => results.push({ name, pass, detail })

  // 1. Zwick–Paterson exact values ≡ the brute-force oracle (and the oracle is internally determined:
  //    its lower max-min value equals its upper min-max value).
  {
    let checked = 0
    let bad = 0
    let determinacyBad = 0
    let firstBad = ''
    for (let seed = 1; seed <= 300; seed++) {
      const n = 3 + (seed % 4) // 3..6, small enough to brute force
      const a = randomWArena(seed * 7 + 1, { n, maxOut: 2, maxWeight: 4 })
      const oracle = oracleValues(a)
      if (!oracle) continue
      if (!sameRats(oracle.lower, oracle.upper)) {
        determinacyBad++
        continue
      }
      const zp = meanPayoffValues(a).value
      checked++
      if (!sameRats(zp, oracle.lower)) {
        bad++
        if (!firstBad) firstBad = `seed ${seed}`
      }
    }
    add(
      'value iteration ≡ brute-force oracle (exact rationals)',
      bad === 0 && determinacyBad === 0,
      determinacyBad ? `${determinacyBad} arenas were not determined` : bad === 0 ? `${checked} arenas agreed vertex-for-vertex` : firstBad,
    )
  }

  // 2. Positional determinacy, stated on its own: lower value = upper value everywhere.
  {
    let checked = 0
    let bad = 0
    for (let seed = 1; seed <= 200; seed++) {
      const n = 3 + (seed % 4)
      const a = randomWArena(seed * 13 + 5, { n, maxOut: 2, maxWeight: 3 })
      const oracle = oracleValues(a)
      if (!oracle) continue
      checked++
      if (!sameRats(oracle.lower, oracle.upper)) bad++
    }
    add('mean-payoff games are positionally determined (max-min = min-max)', bad === 0, `${checked} arenas, both orders agree`)
  }

  // 3. The energy fixpoint's threshold-0 decision matches the sign of the value.
  {
    let checked = 0
    let bad = 0
    let firstBad = ''
    for (let seed = 1; seed <= 250; seed++) {
      const n = 3 + (seed % 6) // 3..8
      const a = randomWArena(seed * 17 + 2, { n, maxOut: 2, maxWeight: 4 })
      const en = solveEnergy(a)
      const zp = meanPayoffValues(a).value
      checked++
      for (let v = 0; v < n; v++) {
        const nonNeg = ratCmp(zp[v], rat(0)) >= 0
        if (en.win0[v] !== nonNeg) {
          bad++
          if (!firstBad) firstBad = `seed ${seed} vertex ${v}`
          break
        }
      }
    }
    add('energy fixpoint (credit ≠ ⊤) ≡ value ≥ 0', bad === 0, bad === 0 ? `${checked} arenas, both solvers agree on the sign` : firstBad)
  }

  // 4. The energy certificate accepts the truth and rejects a corrupted partition.
  {
    let checked = 0
    let bad = 0
    for (let seed = 1; seed <= 200; seed++) {
      const n = 3 + (seed % 6)
      const a = randomWArena(seed * 19 + 4, { n, maxOut: 2, maxWeight: 4 })
      const en = solveEnergy(a)
      const cert = certifyEnergy(a, en)
      checked++
      if (!cert.ok) bad++
    }
    // Teeth: flipping the whole partition must be rejected.
    const a = randomWArena(9971, { n: 6, maxOut: 2, maxWeight: 3 })
    const en = solveEnergy(a)
    const flipped = { ...en, win0: en.win0.map((w) => !w) }
    const rej = certifyEnergy(a, flipped)
    add(
      'energy certificate holds on every arena and rejects a corruption',
      bad === 0 && !rej.ok,
      bad === 0 ? (rej.ok ? 'FAILED to reject a flipped partition' : `${checked} certified; corruption rejected`) : `${bad} certificates failed`,
    )
  }

  // 5. Parity → mean-payoff reduction: Even wins the parity game ⇔ ν > 0 in the reduced game, and the
  //    winner matches Zielonka's solver on the ORIGINAL parity game, vertex for vertex.
  {
    let checked = 0
    let bad = 0
    let firstBad = ''
    for (let seed = 1; seed <= 200; seed++) {
      const n = 3 + (seed % 4) // 3..6 for the brute-force oracle
      const par = randomArena(seed * 23 + 6, 'parity', { n, maxOut: 2, maxPriority: 3 })
      const mp = parityToMeanPayoff(par)
      const oracle = oracleValues(mp)
      if (!oracle) continue
      const zie = solveParity(par).winner
      checked++
      for (let v = 0; v < n; v++) {
        const mpEvenWins = ratCmp(oracle.lower[v], rat(0)) > 0
        const zieEvenWins = zie[v] === 0
        if (mpEvenWins !== zieEvenWins) {
          bad++
          if (!firstBad) firstBad = `seed ${seed} vertex ${v}`
          break
        }
      }
    }
    add('parity ≡ its mean-payoff reduction (vs Zielonka)', bad === 0, bad === 0 ? `${checked} parity games, reduction agrees with the solver` : firstBad)
  }

  // 6. Shift-invariance: adding a constant c to every weight shifts every value by exactly c.
  {
    let checked = 0
    let bad = 0
    for (let seed = 1; seed <= 150; seed++) {
      const n = 3 + (seed % 5)
      const a = randomWArena(seed * 29 + 3, { n, maxOut: 2, maxWeight: 3 })
      const c = ((seed % 7) - 3) || 2
      const base = meanPayoffValues(a).value
      const shifted = meanPayoffValues(shiftWeights(a, c)).value
      checked++
      for (let v = 0; v < n; v++) if (!ratEq(shifted[v], ratAdd(base[v], rat(c)))) { bad++; break }
    }
    add('shift-invariance: ν(w + c) = ν(w) + c', bad === 0, `${checked} arenas obey the identity`)
  }

  // 7. Scale-invariance: multiplying every weight by a positive λ scales every value by λ.
  {
    let checked = 0
    let bad = 0
    for (let seed = 1; seed <= 150; seed++) {
      const n = 3 + (seed % 5)
      const a = randomWArena(seed * 31 + 8, { n, maxOut: 2, maxWeight: 3 })
      const lambda = 1 + (seed % 3)
      const base = meanPayoffValues(a).value
      const scaled = meanPayoffValues(scaleWeights(a, lambda)).value
      checked++
      for (let v = 0; v < n; v++) if (!ratEq(scaled[v], ratMul(base[v], rat(lambda)))) { bad++; break }
    }
    add('scale-invariance: ν(λ·w) = λ·ν(w)', bad === 0, `${checked} arenas obey the identity`)
  }

  // 8. The curated gallery: each example's value iteration matches the oracle and self-certifies.
  {
    let bad = 0
    let firstBad = ''
    for (const ex of QUANT_EXAMPLES) {
      const oracle = oracleValues(ex.arena)
      const zp = meanPayoffValues(ex.arena).value
      const cert = certifyEnergy(ex.arena, solveEnergy(ex.arena))
      const ok = oracle !== null && sameRats(zp, oracle.lower) && sameRats(oracle.lower, oracle.upper) && cert.ok
      if (!ok) {
        bad++
        if (!firstBad) firstBad = ex.id
      }
    }
    add('every curated arena: value iteration ≡ oracle, and certified', bad === 0, bad === 0 ? `${QUANT_EXAMPLES.length} arenas verified` : firstBad)
  }

  const passed = results.filter((r) => r.pass).length
  return { results, passed, total: results.length, ok: passed === results.length }
}
