// The in-app proof harness for the Algebra mode. Everything the view asserts about a syntactic
// monoid is re-derived here and cross-checked several independent ways:
//   • the monoid axioms (closure, identity, associativity) hold on the Cayley table;
//   • the map word → element is a homomorphism, and it recognises exactly the DFA's language
//     (so the monoid faithfully models the regex);
//   • Green's relations are consistent (R, L refine J; H = R ∩ L; and D = J re-derived as the
//     join of R and L for finite monoids);
//   • aperiodicity computed from element powers agrees with H-triviality and with the stability
//     test mⁿ = mⁿ⁺¹ at n = |M| — three different code paths;
//   • the egg-box tiles the monoid exactly once;
//   • and a table of hand-checked known answers (ℤ/2, ℤ/3, semilattice, star-free) matches.

import type { Dfa, Sym } from '../types'
import { showWord } from '../types'
import { completeDfa, syntacticMonoidFromRegex, wordToElement } from './monoid'
import type { Monoid } from './monoid'
import { greenRelations, eggBoxes } from './green'
import { analyzeMonoid } from './properties'
import { classify } from './verdict'
import { ALGEBRA_EXAMPLES } from './examples'

export interface TestResult {
  name: string
  pass: boolean
  detail: string
}

/** Run a symbol-word through the complete DFA and report acceptance. */
function dfaAccepts(dfa: Dfa, word: Sym[]): boolean {
  let q = dfa.start
  for (const s of word) {
    const si = dfa.alphabet.indexOf(s)
    if (si < 0) return false
    q = dfa.trans[q][si]
    if (q < 0) return false
  }
  return dfa.accepting.has(q)
}

/** All words over the alphabet of length ≤ maxLen (deterministic enumeration). */
function words(alphabet: Sym[], maxLen: number): Sym[][] {
  let level: Sym[][] = [[]]
  const out: Sym[][] = [[]]
  for (let len = 1; len <= maxLen; len++) {
    const next: Sym[][] = []
    for (const w of level) for (const s of alphabet) next.push([...w, s])
    out.push(...next)
    level = next
  }
  return out
}

/** Re-derive aperiodicity a *second* way: mⁿ = mⁿ⁺¹ for all m at n = |M| (which always suffices). */
function aperiodicByStability(mon: Monoid): boolean {
  const N = mon.order
  for (let a = 0; a < mon.order; a++) {
    let mn = a
    for (let k = 1; k < N; k++) mn = mon.mult[mn][a] // mn = a^N
    if (mon.mult[mn][a] !== mn) return false // a^{N+1} ≠ a^N
  }
  return true
}

/** Re-derive D as the join of R and L (union-find over "share an R- or L-class"). */
function dEqualsJ(mon: Monoid, r: number[], l: number[], j: number[]): boolean {
  const m = mon.order
  const parent = Array.from({ length: m }, (_, i) => i)
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])))
  const union = (a: number, b: number) => { parent[find(a)] = find(b) }
  // First element seen with a given R/L label, so we can chain the class together.
  const firstR = new Map<number, number>()
  const firstL = new Map<number, number>()
  for (let a = 0; a < m; a++) {
    if (firstR.has(r[a])) union(a, firstR.get(r[a])!)
    else firstR.set(r[a], a)
    if (firstL.has(l[a])) union(a, firstL.get(l[a])!)
    else firstL.set(l[a], a)
  }
  // D (= join of R, L) must be exactly the J-partition.
  for (let a = 0; a < m; a++) {
    for (let b = a + 1; b < m; b++) {
      const sameD = find(a) === find(b)
      const sameJ = j[a] === j[b]
      if (sameD !== sameJ) return false
    }
  }
  return true
}

export function runAlgebraSelfTest(): {
  results: TestResult[]
  passed: number
  total: number
  ok: boolean
} {
  const results: TestResult[] = []
  const add = (name: string, pass: boolean, detail: string) => results.push({ name, pass, detail })

  // ---- 1. Monoid axioms on every curated example -------------------------------------------
  {
    let axiomFail = ''
    let assocFail = ''
    for (const ex of ALGEBRA_EXAMPLES) {
      const built = syntacticMonoidFromRegex(ex.regex)
      if (!built.ok || !built.monoid) { axiomFail = `${ex.name}: failed to build`; break }
      const mon = built.monoid
      if (mon.truncated) { axiomFail = `${ex.name}: exceeded size cap`; break }
      // Closure + identity.
      for (let a = 0; a < mon.order && !axiomFail; a++) {
        if (mon.mult[mon.identity][a] !== a || mon.mult[a][mon.identity] !== a)
          axiomFail = `${ex.name}: identity law fails at ${a}`
        for (let b = 0; b < mon.order; b++) {
          const p = mon.mult[a][b]
          if (p < 0 || p >= mon.order) { axiomFail = `${ex.name}: product out of range`; break }
        }
      }
      // Associativity (full triple scan — the curated monoids are small).
      if (mon.order <= 80) {
        for (let a = 0; a < mon.order && !assocFail; a++)
          for (let b = 0; b < mon.order && !assocFail; b++)
            for (let c = 0; c < mon.order && !assocFail; c++)
              if (mon.mult[mon.mult[a][b]][c] !== mon.mult[a][mon.mult[b][c]])
                assocFail = `${ex.name}: (${a}·${b})·${c} ≠ ${a}·(${b}·${c})`
      }
    }
    add('Monoid axioms — closure & identity', axiomFail === '', axiomFail || 'identity and closure hold on every Cayley table')
    add('Monoid axioms — associativity', assocFail === '', assocFail || 'associativity holds on every curated monoid')
  }

  // ---- 2. Homomorphism & language faithfulness ---------------------------------------------
  {
    let homFail = ''
    let recogFail = ''
    for (const ex of ALGEBRA_EXAMPLES) {
      const built = syntacticMonoidFromRegex(ex.regex)
      if (!built.ok || !built.monoid) continue
      const mon = built.monoid
      const alpha = mon.alphabet
      const ws = words(alpha, alpha.length >= 3 ? 4 : 6)
      for (const w of ws) {
        // Recognition: the DFA and the monoid must agree on membership.
        const eid = wordToElement(mon, w)
        if (eid < 0) continue
        const inLang = mon.elements[eid].accepting
        if (inLang !== dfaAccepts(mon.dfa, w)) {
          recogFail = `${ex.name}: monoid vs DFA disagree on “${showWord(w)}”`
          break
        }
      }
      // Homomorphism: element(uv) = element(u) · element(v) on a sample.
      const sample = words(alpha, 3)
      for (const u of sample) {
        const eu = wordToElement(mon, u)
        for (const v of sample) {
          const ev = wordToElement(mon, v)
          if (wordToElement(mon, [...u, ...v]) !== mon.mult[eu][ev]) {
            homFail = `${ex.name}: not a homomorphism on (${showWord(u)}, ${showWord(v)})`
            break
          }
        }
        if (homFail) break
      }
      if (recogFail || homFail) break
    }
    add('Syntactic morphism is a homomorphism', homFail === '', homFail || 'η(uv) = η(u)·η(v) on all sampled word pairs')
    add('Monoid recognises exactly the regex', recogFail === '', recogFail || 'monoid membership matches the DFA on every short word')
  }

  // ---- 3. Green's relations & aperiodicity cross-checks -------------------------------------
  {
    let greenFail = ''
    let apFail = ''
    let eggFail = ''
    for (const ex of ALGEBRA_EXAMPLES) {
      const built = syntacticMonoidFromRegex(ex.regex)
      if (!built.ok || !built.monoid) continue
      const mon = built.monoid
      const g = greenRelations(mon)
      const props = analyzeMonoid(mon, g)

      // R and L refine J; H = R ∩ L.
      for (let a = 0; a < mon.order && !greenFail; a++) {
        for (let b = 0; b < mon.order; b++) {
          if (g.r[a] === g.r[b] && g.j[a] !== g.j[b]) { greenFail = `${ex.name}: R does not refine J`; break }
          if (g.l[a] === g.l[b] && g.j[a] !== g.j[b]) { greenFail = `${ex.name}: L does not refine J`; break }
          const sameH = g.h[a] === g.h[b]
          const sameRL = g.r[a] === g.r[b] && g.l[a] === g.l[b]
          if (sameH !== sameRL) { greenFail = `${ex.name}: H ≠ R ∩ L`; break }
        }
      }
      if (!greenFail && !dEqualsJ(mon, g.r, g.l, g.j)) greenFail = `${ex.name}: D ≠ J`

      // Aperiodicity: powers-based vs H-triviality vs stability, all three must agree.
      const apPow = props.aperiodic
      const apH = g.hClasses.length === mon.order
      const apStab = aperiodicByStability(mon)
      if (!(apPow === apH && apH === apStab)) apFail = `${ex.name}: aperiodicity tests disagree (${apPow}/${apH}/${apStab})`
      // group ⟺ a single idempotent.
      if (!apFail && props.group !== (props.idempotents.length === 1)) apFail = `${ex.name}: group ≠ (one idempotent)`

      // Egg-box tiles the monoid exactly once.
      const boxes = eggBoxes(mon, g)
      const covered = new Set<number>()
      let doubleCount = false
      for (const box of boxes)
        for (const row of box.cells)
          for (const cell of row)
            if (cell) for (const x of cell.hClass) { if (covered.has(x)) doubleCount = true; covered.add(x) }
      if (doubleCount || covered.size !== mon.order) eggFail = `${ex.name}: egg-box covers ${covered.size}/${mon.order} elements`
      // A regular J-class must expose at least one group H-class.
      for (const box of boxes) {
        if (!box.regular) continue
        const hasGroup = box.cells.some((row) => row.some((c) => c && c.group))
        if (!hasGroup) { eggFail = `${ex.name}: regular J-class ${box.jIndex} has no group cell`; break }
      }
      if (greenFail || apFail || eggFail) break
    }
    add("Green's relations consistent (R,L ⊆ J; H = R∩L; D = J)", greenFail === '', greenFail || 'ideal structure verified on every example')
    add('Aperiodicity — 3 independent computations agree', apFail === '', apFail || 'powers = H-trivial = stability, and group ⟺ one idempotent')
    add('Egg-box tiles the monoid exactly once', eggFail === '', eggFail || 'every element sits in exactly one H-class cell')
  }

  // ---- 4. Hand-checked known answers -------------------------------------------------------
  {
    interface Known {
      regex: string
      order?: number
      aperiodic: boolean
      group?: boolean
      commutative?: boolean
      jTrivial?: boolean
      starFree: boolean
    }
    // NB: this lab's alphabet always carries the OTHER sentinel, so any language that is not
    // built over "." rejects some letter and picks up a trap = zero element. Orders reflect that.
    const known: Known[] = [
      { regex: '.*', order: 1, aperiodic: true, group: true, commutative: true, jTrivial: true, starFree: true },
      { regex: '(...)*', order: 3, aperiodic: false, group: true, commutative: true, jTrivial: false, starFree: false },
      { regex: '(a|b)*a(a|b)*', aperiodic: true, group: false, commutative: true, jTrivial: true, starFree: true },
      { regex: 'b*(ab*ab*)*', aperiodic: false, group: false, commutative: true, starFree: false },
      { regex: 'a*b*', aperiodic: true, commutative: false, starFree: true },
      { regex: '(ab)*', aperiodic: true, commutative: false, starFree: true },
    ]
    let knownFail = ''
    for (const k of known) {
      const built = syntacticMonoidFromRegex(k.regex)
      if (!built.ok || !built.monoid) { knownFail = `${k.regex}: build failed`; break }
      const mon = built.monoid
      const g = greenRelations(mon)
      const props = analyzeMonoid(mon, g)
      const verd = classify(mon, props)
      const miss: string[] = []
      if (k.order !== undefined && mon.order !== k.order) miss.push(`|M|=${mon.order}≠${k.order}`)
      if (props.aperiodic !== k.aperiodic) miss.push(`aperiodic=${props.aperiodic}`)
      if (k.group !== undefined && props.group !== k.group) miss.push(`group=${props.group}`)
      if (k.commutative !== undefined && props.commutative !== k.commutative) miss.push(`commutative=${props.commutative}`)
      if (k.jTrivial !== undefined && props.jTrivial !== k.jTrivial) miss.push(`jTrivial=${props.jTrivial}`)
      if (verd.starFree !== k.starFree) miss.push(`starFree=${verd.starFree}`)
      if (miss.length) { knownFail = `${k.regex}: ${miss.join(', ')}`; break }
    }
    add('Known monoids (ℤ/2, ℤ/3, semilattice, star-free)', knownFail === '', knownFail || 'every hand-checked classification matches')
  }

  // ---- 5. A tampered Cayley table must be rejected (the checker has teeth) ------------------
  {
    const built = syntacticMonoidFromRegex('(a|b)*a(a|b)')
    let caught = false
    if (built.ok && built.monoid && built.monoid.order >= 3) {
      const mon = built.monoid
      // Corrupt one product and confirm associativity notices.
      const orig = mon.mult[1][2]
      mon.mult[1][2] = mon.identity === orig ? (orig + 1) % mon.order : mon.identity
      let broke = false
      for (let a = 0; a < mon.order && !broke; a++)
        for (let b = 0; b < mon.order && !broke; b++)
          for (let c = 0; c < mon.order && !broke; c++)
            if (mon.mult[mon.mult[a][b]][c] !== mon.mult[a][mon.mult[b][c]]) broke = true
      mon.mult[1][2] = orig
      caught = broke
    }
    add('Negative control — corruption is detected', caught, caught ? 'a single wrong product breaks associativity, as it must' : 'FAILED to detect corruption')
  }

  // Guard: completeDfa is idempotent on already-total DFAs.
  {
    const built = syntacticMonoidFromRegex('(a|b)*')
    const mon = built.monoid!
    const again = completeDfa(mon.dfa)
    add('completeDfa is idempotent on total DFAs', again === mon.dfa || again.numStates === mon.dfa.numStates, 'no spurious trap added to a complete DFA')
  }

  const passed = results.filter((r) => r.pass).length
  return { results, passed, total: results.length, ok: passed === results.length }
}

/** Convenience for a quick REPL / console check. */
export function buildFor(regex: string): Monoid | null {
  return syntacticMonoidFromRegex(regex).monoid ?? null
}
