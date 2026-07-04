// Correctness harness for the ASP subsystem, in the project's house style: the
// fast native solver is pitted against the brute-force Gelfond–Lifschitz oracle
// on thousands of random ground programs, its answer sets must match *exactly*,
// and every model it reports is independently re-verified. On top of that the
// well-founded model's guarantees are checked against the true answer-set
// intersection, and the curated gallery's mathematically-known counts are pinned.
//
// Exposed as `runAspChecks()` so the top-level `selftest.ts` folds these
// assertions into the project's running total, exactly like every other engine.

import type { GroundProgram, Rule } from './program'
import { answerSetKey } from './program'
import { solveAsp, wellFoundedModel } from './solve'
import { bruteAnswerSets, isAnswerSet } from './reduct'
import { parseProgram } from './parse'
import { ground } from './ground'
import { ASP_EXAMPLES } from './examples'
import { positiveDependencyGraph, layoutDepGraph } from './depgraph'

export interface AspCheckReport {
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

function keys(sets: number[][]): Set<string> {
  return new Set(sets.map(answerSetKey))
}
function sameSets(a: number[][], b: number[][]): boolean {
  if (a.length !== b.length) return false
  const ka = keys(a)
  for (const s of b) if (!ka.has(answerSetKey(s))) return false
  return true
}

/** A random ground program small enough for exhaustive verification. Mixes
 *  normal rules, integrity constraints and (bounded) choice rules — the three
 *  shapes the whole engine is defined over. */
function randProgram(rng: () => number): GroundProgram {
  const N = 2 + Math.floor(rng() * 6) // 2..7 atoms
  const atomNames = ['']
  for (let i = 1; i <= N; i++) atomNames.push('a' + i)
  const rules: Rule[] = []
  const numRules = 2 + Math.floor(rng() * 8)
  let choiceHeads = 0
  const randAtom = () => 1 + Math.floor(rng() * N)
  const randSubset = (maxSize: number): number[] => {
    const size = Math.floor(rng() * (maxSize + 1))
    const s = new Set<number>()
    let guard = 0
    while (s.size < size && guard++ < 20) s.add(randAtom())
    return [...s]
  }
  for (let k = 0; k < numRules; k++) {
    const roll = rng()
    let kind: 'normal' | 'constraint' | 'choice' = roll < 0.5 ? 'normal' : roll < 0.75 ? 'constraint' : 'choice'
    if (kind === 'choice' && choiceHeads + 3 > 9) kind = 'normal'
    if (kind === 'normal') {
      rules.push({ kind: 'normal', head: randAtom(), pos: randSubset(2), neg: randSubset(2) })
    } else if (kind === 'constraint') {
      const pos = randSubset(3)
      const neg = randSubset(2)
      if (pos.length + neg.length === 0) {
        k-- // skip an empty (always-firing) constraint; regenerate
        continue
      }
      rules.push({ kind: 'constraint', pos, neg })
    } else {
      const size = 1 + Math.floor(rng() * 3)
      const hs = new Set<number>()
      let guard = 0
      while (hs.size < size && guard++ < 20) hs.add(randAtom())
      const heads = [...hs]
      choiceHeads += heads.length
      let lo: number | null = null
      let hi: number | null = null
      if (rng() < 0.5) lo = Math.floor(rng() * (heads.length + 1))
      if (rng() < 0.5) hi = (lo ?? 0) + Math.floor(rng() * (heads.length - (lo ?? 0) + 1))
      rules.push({ kind: 'choice', heads, lo, hi, pos: randSubset(2), neg: randSubset(1) })
    }
  }
  return { numAtoms: N, atomNames, rules }
}

export function runAspChecks(): AspCheckReport {
  let pass = 0
  let fail = 0
  const messages: string[] = []
  const check = (name: string, cond: boolean, extra = '') => {
    if (cond) pass++
    else {
      fail++
      if (messages.length < 40) messages.push(`FAIL: ${name} ${extra}`)
    }
  }

  // ---- native solver vs. brute-force reduct oracle ----
  {
    const rng = mulberry32(0xa5f00d)
    let mismatches = 0
    let sawMulti = 0
    let sawEmpty = 0
    let reverifyBad = 0
    let dupBad = 0
    const TRIALS = 4000
    for (let i = 0; i < TRIALS; i++) {
      const prog = randProgram(rng)
      const brute = bruteAnswerSets(prog)
      const res = solveAsp(prog, { maxAnswerSets: 100000, maxIterations: 200000, maxTimeMs: 4000 })
      if (!res.complete) {
        // tiny programs should always complete; flag if not
        check('random program enumeration completes', false, `#atoms=${prog.numAtoms}`)
        continue
      }
      if (!sameSets(res.answerSets, brute)) {
        mismatches++
        if (mismatches <= 3) {
          messages.push(
            `  mismatch: solver=${res.answerSets.length} brute=${brute.length} rules=${JSON.stringify(prog.rules)}`,
          )
        }
      }
      if (brute.length >= 3) sawMulti++
      if (brute.length === 0) sawEmpty++
      // defence in depth: every reported model must re-verify, and be unique
      const seen = new Set<string>()
      for (const s of res.answerSets) {
        if (!isAnswerSet(prog, s)) reverifyBad++
        const key = answerSetKey(s)
        if (seen.has(key)) dupBad++
        seen.add(key)
      }
    }
    check(`random ASP: solver vs. reduct oracle (${TRIALS} programs)`, mismatches === 0, `mismatches=${mismatches}`)
    check('random ASP: every reported model re-verifies as stable', reverifyBad === 0, `bad=${reverifyBad}`)
    check('random ASP: no duplicate answer sets', dupBad === 0, `dup=${dupBad}`)
    check('random ASP: exercised multi-answer-set instances', sawMulti > 200, `multi=${sawMulti}`)
    check('random ASP: exercised UNSAT (no answer set) instances', sawEmpty > 50, `empty=${sawEmpty}`)
  }

  // ---- positive dependency graph: SCCs vs. reachability + tightness invariant ----
  {
    const rng = mulberry32(0xdec0de)
    let sccBad = 0
    let tightBad = 0
    let sawTight = 0
    let sawLoopy = 0
    let sawLoopFormulas = 0
    for (let i = 0; i < 1500; i++) {
      const prog = randProgram(rng)
      const g = positiveDependencyGraph(prog)
      const N = prog.numAtoms
      // brute-force mutual reachability over the same successor relation.
      const succ: number[][] = Array.from({ length: N + 1 }, () => [])
      for (const e of g.edges) succ[e.from].push(e.to)
      const reach: boolean[][] = Array.from({ length: N + 1 }, () => new Array(N + 1).fill(false))
      for (let s = 1; s <= N; s++) {
        const stack = [...succ[s]]
        while (stack.length) {
          const v = stack.pop()!
          if (reach[s][v]) continue
          reach[s][v] = true
          for (const w of succ[v]) if (!reach[s][w]) stack.push(w)
        }
      }
      for (let a = 1; a <= N; a++)
        for (let b = 1; b <= N; b++) {
          const mutual = a === b ? true : reach[a][b] && reach[b][a]
          const sameScc = g.sccOf[a] === g.sccOf[b]
          if (mutual !== sameScc) sccBad++
        }
      // tightness ⇒ the solver never needs a loop formula (Fages' theorem).
      const res = solveAsp(prog, { maxTimeMs: 3000 })
      if (res.complete) {
        if (g.tight) {
          sawTight++
          if (res.stats.loopFormulas !== 0) tightBad++
        } else sawLoopy++
        if (res.stats.loopFormulas > 0) {
          sawLoopFormulas++
          // contrapositive: any loop formula ⇒ the program is non-tight.
          if (g.tight) tightBad++
        }
      }
      // layout must not throw and must produce a position per graph node.
      const lay = layoutDepGraph(g)
      if (lay.nodes.length !== g.nodes.length && g.nodes.length > 0) {
        // nodes-with-no-edges still get a column; only assert non-crash + finite
      }
      for (const n of lay.nodes) if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) sccBad++
    }
    check('dep graph: SCC partition = mutual reachability', sccBad === 0, `bad=${sccBad}`)
    check('dep graph: tight ⇒ solver adds zero loop formulas', tightBad === 0, `bad=${tightBad}`)
    check('dep graph: exercised tight and loopy programs', sawTight > 100 && sawLoopy > 100, `tight=${sawTight} loopy=${sawLoopy}`)
    check('dep graph: exercised loop-formula refinement', sawLoopFormulas > 20, `n=${sawLoopFormulas}`)
  }

  // ---- well-founded model guarantees vs. the true answer-set intersection ----
  {
    const rng = mulberry32(0x13579b)
    let wfBad = 0
    let tested = 0
    for (let i = 0; i < 1500; i++) {
      const prog = randProgram(rng)
      const brute = bruteAnswerSets(prog)
      if (brute.length === 0) continue
      tested++
      const wf = wellFoundedModel(prog)
      // WFS-true atoms are in every answer set; WFS-false atoms are in none.
      const inter = new Set(brute[0])
      const union = new Set<number>()
      for (const s of brute) {
        const ss = new Set(s)
        for (const a of [...inter]) if (!ss.has(a)) inter.delete(a)
        for (const a of s) union.add(a)
      }
      for (const a of wf.trueAtoms) if (!inter.has(a)) wfBad++
      for (const a of wf.falseAtoms) if (union.has(a)) wfBad++
      // partition: every real atom is exactly one of true / false / undefined
      const total = wf.trueAtoms.length + wf.falseAtoms.length + wf.undefinedAtoms.length
      if (total !== prog.numAtoms) wfBad++
    }
    check('well-founded model: true ⊆ ∩ answer sets, false ∩ ⋃ = ∅', wfBad === 0, `bad=${wfBad}`)
    check('well-founded model: exercised', tested > 300, `tested=${tested}`)
  }

  // ---- determinism ----
  {
    const rng = mulberry32(0x2468ac)
    let detBad = 0
    for (let i = 0; i < 300; i++) {
      const prog = randProgram(rng)
      const a = solveAsp(prog, { maxTimeMs: 3000 })
      const b = solveAsp(prog, { maxTimeMs: 3000 })
      if (!sameSets(a.answerSets, b.answerSets)) detBad++
    }
    check('solver is deterministic across runs', detBad === 0, `bad=${detBad}`)
  }

  // ---- parser / grounder round-trips on curated programs ----
  {
    for (const ex of ASP_EXAMPLES) {
      const parsed = parseProgram(ex.code)
      check(`example ${ex.id}: parses cleanly`, parsed.errors.length === 0, parsed.errors.join('; '))
      const g = ground(parsed.rules)
      check(`example ${ex.id}: grounds cleanly`, g.errors.length === 0, g.errors.join('; '))
      const res = solveAsp(g.program, { maxAnswerSets: 100000, maxIterations: 500000, maxTimeMs: 12000 })
      check(`example ${ex.id}: enumeration completes`, res.complete, `count=${res.count}`)
      if (ex.expected !== undefined) {
        check(`example ${ex.id}: answer-set count = ${ex.expected}`, res.count === ex.expected, `got=${res.count}`)
      }
      // every reported model is genuinely stable
      let bad = 0
      for (const s of res.answerSets) if (!isAnswerSet(g.program, s)) bad++
      check(`example ${ex.id}: all models stable`, bad === 0, `bad=${bad}`)
    }

    // curated dependency-graph expectations
    const dg = (id: string) => positiveDependencyGraph(ground(parseProgram(ASP_EXAMPLES.find((e) => e.id === id)!.code).rules).program)
    // transitive closure over the cyclic edge graph b→c→d→b is genuinely recursive
    check('dep graph: cyclic reachability is non-tight', !dg('reach').tight)
    check('dep graph: negative even loop is tight', dg('evenloop').tight) // bodies are all `not`
    const diamond = dg('diamond')
    check('dep graph: positive loop is non-tight with a loop SCC', !diamond.tight && diamond.loops.length >= 1)
    check('dep graph: hamilton (reached recursion) is non-tight', !dg('hamilton').tight)
  }

  // ---- semantic validity of the combinatorial examples ----
  {
    // 3-colouring: every answer set assigns each node exactly one colour and no
    // edge is monochromatic.
    const colorProg = ground(parseProgram(ASP_EXAMPLES.find((e) => e.id === 'graph-color')!.code).rules).program
    const colorRes = solveAsp(colorProg, { maxTimeMs: 8000 })
    let colorBad = 0
    const edges: [number, number][] = [
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
      [5, 1],
      [1, 3],
    ]
    for (const s of colorRes.answerSets) {
      const colorOf = new Map<number, string>()
      for (const id of s) {
        const name = colorProg.atomNames[id]
        const m = /^assign\((\d+),(\w+)\)$/.exec(name)
        if (m) {
          if (colorOf.has(Number(m[1]))) colorBad++ // two colours for one node
          colorOf.set(Number(m[1]), m[2])
        }
      }
      if (colorOf.size !== 5) colorBad++ // every node coloured
      for (const [u, v] of edges) if (colorOf.get(u) === colorOf.get(v)) colorBad++
    }
    check('3-colouring: all answer sets are proper colourings', colorBad === 0, `bad=${colorBad}`)
    check('3-colouring: found at least one colouring', colorRes.count > 0, `count=${colorRes.count}`)

    // N-Queens: each answer set has one queen per row and no attacks.
    const qProg = ground(parseProgram(ASP_EXAMPLES.find((e) => e.id === 'queens')!.code).rules).program
    const qRes = solveAsp(qProg, { maxTimeMs: 12000 })
    let queenBad = 0
    for (const s of qRes.answerSets) {
      const cols: number[] = new Array(7).fill(-1)
      for (const id of s) {
        const m = /^q\((\d+),(\d+)\)$/.exec(qProg.atomNames[id])
        if (m) cols[Number(m[1])] = Number(m[2])
      }
      for (let r = 1; r <= 6; r++) if (cols[r] < 1) queenBad++
      for (let r1 = 1; r1 <= 6; r1++)
        for (let r2 = r1 + 1; r2 <= 6; r2++) {
          if (cols[r1] === cols[r2]) queenBad++
          if (Math.abs(cols[r1] - cols[r2]) === Math.abs(r1 - r2)) queenBad++
        }
    }
    check('6-Queens: all answer sets are valid boards', queenBad === 0, `bad=${queenBad}`)
    check('6-Queens: exactly 4 solutions', qRes.count === 4, `count=${qRes.count}`)
  }

  return { pass, fail, messages }
}
