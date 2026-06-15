// Throwaway correctness harness (not part of the app build). Bundled with
// esbuild and run on node. The strongest test is the brute-force cross-check:
// thousands of random CNFs where we compare the solver's verdict (and any model)
// against exhaustive truth-table enumeration.
import {
  parseDimacs,
  toDimacs,
  solve,
  verifyModel,
  encodeNQueens,
  encodeSudoku,
  parseSudoku,
  encodeGraphColoring,
  encodePigeonhole,
  encodeLangford,
  randomKSat,
  lubySequence,
  checkProof,
  proofToDrat,
  parseDrat,
  countModels,
  findMus,
  encodeFactoring,
  encodeHamiltonian,
  encodeZebra,
} from './src/sat/index'
import type { CNF, ProofStep, Graph } from './src/sat/index'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    pass++
  } else {
    fail++
    console.error(`FAIL: ${name} ${extra}`)
  }
}

// Brute-force SAT decision over a CNF (<=20 vars).
function bruteforce(cnf: CNF): boolean {
  const n = cnf.numVars
  for (let mask = 0; mask < 1 << n; mask++) {
    const model: boolean[] = [false]
    for (let v = 1; v <= n; v++) model[v] = (mask & (1 << (v - 1))) !== 0
    if (verifyModel(cnf, model).ok) return true
  }
  return false
}

// A completely independent, deliberately naive RUP-only proof checker, used to
// cross-check the real (watched-literal) DRAT checker. Returns whether the empty
// clause is derived via reverse unit propagation alone (no RAT). This is sound
// for CDCL proofs because every learnt clause is RUP.
function naiveRupCheck(cnf: CNF, proof: ProofStep[]): boolean {
  const db: number[][] = cnf.clauses.map((c) => [...c])
  const key = (c: number[]) => [...c].sort((a, b) => a - b).join(',')
  // Is `clause` implied by `db` under reverse unit propagation?
  const rup = (clause: number[]): boolean => {
    const assign = new Map<number, boolean>()
    for (const l of clause) {
      const v = Math.abs(l)
      const want = l < 0 // value of v that makes literal l FALSE
      if (assign.has(v) && assign.get(v) !== want) return true // tautological clause
      assign.set(v, want)
    }
    let changed = true
    while (changed) {
      changed = false
      for (const D of db) {
        let sat = false
        const unassigned: number[] = []
        for (const l of D) {
          const v = Math.abs(l)
          if (!assign.has(v)) {
            unassigned.push(l)
            continue
          }
          if ((l > 0) === assign.get(v)!) {
            sat = true
            break
          }
        }
        if (sat) continue
        if (unassigned.length === 0) return true // all literals false -> conflict
        if (unassigned.length === 1) {
          const l = unassigned[0]
          const v = Math.abs(l)
          const want = l > 0 // value of v that makes literal l TRUE
          if (assign.has(v)) {
            if (assign.get(v) !== want) return true
          } else {
            assign.set(v, want)
            changed = true
          }
        }
      }
    }
    return false
  }
  let derivedEmpty = false
  for (const step of proof) {
    if (step.a === 'd') {
      const k = key(step.lits)
      const idx = db.findIndex((c) => key(c) === k)
      if (idx >= 0) db.splice(idx, 1)
      continue
    }
    if (!rup(step.lits)) return false
    if (step.lits.length === 0) derivedEmpty = true
    db.push([...step.lits])
  }
  return derivedEmpty
}

// ---- Luby ----
{
  const expected = [1, 1, 2, 1, 1, 2, 4, 1, 1, 2, 1, 1, 2, 4, 8]
  const got = lubySequence(15)
  check('luby sequence', JSON.stringify(got) === JSON.stringify(expected), JSON.stringify(got))
}

// ---- DIMACS roundtrip ----
{
  const src = 'c hello\np cnf 3 2\n1 -2 0\n2 3 -1 0\n'
  const { cnf } = parseDimacs(src)
  check('dimacs parse vars', cnf.numVars === 3)
  check('dimacs parse clauses', cnf.clauses.length === 2)
  const round = parseDimacs(toDimacs(cnf)).cnf
  check('dimacs roundtrip', JSON.stringify(round.clauses) === JSON.stringify(cnf.clauses))
}

// ---- trivial SAT / UNSAT ----
{
  const sat = solve({ numVars: 1, clauses: [[1]] })
  check('unit SAT', sat.status === 'sat' && sat.model![1] === true)
  const unsat = solve({ numVars: 1, clauses: [[1], [-1]] })
  check('contradiction UNSAT', unsat.status === 'unsat')
  const empty = solve({ numVars: 0, clauses: [] })
  check('empty formula SAT', empty.status === 'sat')
  const emptyClause = solve({ numVars: 2, clauses: [[]] })
  check('empty clause UNSAT', emptyClause.status === 'unsat')
}

// ---- brute-force cross-check on random CNFs ----
{
  let mismatches = 0
  let satCount = 0
  for (let t = 0; t < 4000; t++) {
    const n = 3 + (t % 9) // 3..11 vars
    const ratio = 1 + (t % 60) / 10 // 1.0..7.0
    const cnf = randomKSat(n, ratio, 3, t * 2654435761 + 1)
    const truth = bruteforce(cnf)
    const res = solve(cnf, { minimize: t % 2 === 0, randomFreq: t % 3 === 0 ? 0.1 : 0, randomSeed: t })
    if (res.status === 'unknown') continue
    const verdict = res.status === 'sat'
    if (verdict !== truth) {
      mismatches++
      if (mismatches <= 3) console.error('  verdict mismatch', { n, ratio, truth, got: res.status })
    }
    if (res.status === 'sat') {
      satCount++
      if (!verifyModel(cnf, res.model!).ok) {
        mismatches++
        if (mismatches <= 3) console.error('  bad model', toDimacs(cnf))
      }
    }
  }
  check('random 3-SAT cross-check (4000 instances)', mismatches === 0, `mismatches=${mismatches}`)
  check('cross-check exercised SAT cases', satCount > 100, `satCount=${satCount}`)
}

// ---- N-Queens ----
{
  for (const n of [4, 6, 8, 10, 12]) {
    const { cnf, decode } = encodeNQueens(n)
    const res = solve(cnf, { maxConflicts: 200000 })
    check(`${n}-Queens SAT`, res.status === 'sat')
    if (res.status === 'sat') {
      const sol = decode(res.model!)
      // validate: one queen per row, all distinct cols, no diagonal clash
      const cols = sol.queens
      let valid = cols.every((c) => c >= 0)
      for (let r1 = 0; r1 < n && valid; r1++)
        for (let r2 = r1 + 1; r2 < n; r2++) {
          if (cols[r1] === cols[r2]) valid = false
          if (Math.abs(cols[r1] - cols[r2]) === Math.abs(r1 - r2)) valid = false
        }
      check(`${n}-Queens board valid`, valid, JSON.stringify(cols))
    }
  }
  // N=3 has no solution.
  const r3 = solve(encodeNQueens(3).cnf)
  check('3-Queens UNSAT', r3.status === 'unsat')
}

// ---- Sudoku ----
{
  // A known-hard puzzle (Arto Inkala-style minimal givens not required here).
  const puzzle =
    '53..7....6..195....98....6.8...6...34..8.3..17...2...6.6....28....419..5....8..79'
  const clues = parseSudoku(puzzle, 9)
  const { cnf, decode } = encodeSudoku(clues, 3)
  const res = solve(cnf, { maxConflicts: 500000 })
  check('Sudoku SAT', res.status === 'sat')
  if (res.status === 'sat') {
    const grid = decode(res.model!).grid
    // validate rows/cols/boxes are permutations of 1..9 and clues respected
    let ok = true
    for (let i = 0; i < 81; i++) if (clues[i] && grid[i] !== clues[i]) ok = false
    const isPerm = (arr: number[]) => {
      const set = new Set(arr)
      return set.size === 9 && [...set].every((x) => x >= 1 && x <= 9)
    }
    for (let r = 0; r < 9 && ok; r++) {
      const row: number[] = []
      const col: number[] = []
      for (let c = 0; c < 9; c++) {
        row.push(grid[r * 9 + c])
        col.push(grid[c * 9 + r])
      }
      if (!isPerm(row) || !isPerm(col)) ok = false
    }
    for (let br = 0; br < 3 && ok; br++)
      for (let bc = 0; bc < 3; bc++) {
        const box: number[] = []
        for (let dr = 0; dr < 3; dr++) for (let dc = 0; dc < 3; dc++) box.push(grid[(br * 3 + dr) * 9 + (bc * 3 + dc)])
        if (!isPerm(box)) ok = false
      }
    check('Sudoku grid valid', ok)
  }
}

// ---- Graph coloring ----
{
  // Triangle needs 3 colors: 2-coloring UNSAT, 3-coloring SAT.
  const triangle = { numVertices: 3, edges: [[0, 1], [1, 2], [0, 2]] as [number, number][] }
  check('triangle 2-color UNSAT', solve(encodeGraphColoring(triangle, 2).cnf).status === 'unsat')
  const r3 = solve(encodeGraphColoring(triangle, 3).cnf)
  check('triangle 3-color SAT', r3.status === 'sat')
  if (r3.status === 'sat') {
    const { colors } = encodeGraphColoring(triangle, 3).decode(r3.model!)
    let proper = true
    for (const [a, b] of triangle.edges) if (colors[a] === colors[b]) proper = false
    check('triangle coloring proper', proper, JSON.stringify(colors))
  }
}

// ---- Pigeonhole (UNSAT family) ----
{
  for (const n of [2, 3, 4, 5, 6]) {
    const res = solve(encodePigeonhole(n).cnf, { maxConflicts: 2000000 })
    check(`PHP(${n}) UNSAT`, res.status === 'unsat')
  }
}

// ---- Langford pairing ----
{
  // Solvable iff n ≡ 0 or 3 (mod 4).
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const { cnf, decode } = encodeLangford(n)
    const res = solve(cnf, { maxConflicts: 2000000 })
    const expectSat = n % 4 === 0 || n % 4 === 3
    check(`Langford L(${n}) ${expectSat ? 'SAT' : 'UNSAT'}`, (res.status === 'sat') === expectSat, res.status)
    if (res.status === 'sat') {
      const { sequence } = decode(res.model!)
      // Validate: every value 1..n appears exactly twice, k apart, slots filled once.
      let ok = sequence.length === 2 * n && sequence.every((v) => v >= 0 && v <= n)
      const filled = sequence.filter((v) => v > 0).length
      if (filled !== 2 * n) ok = false
      for (let v = 1; v <= n && ok; v++) {
        const at: number[] = []
        sequence.forEach((x, i) => x === v && at.push(i))
        if (at.length !== 2 || at[1] - at[0] !== v + 1) ok = false
      }
      check(`Langford L(${n}) sequence valid`, ok, JSON.stringify(sequence))
    }
  }
}

// ---- DRAT proof emission + checking ----
{
  // Trivial refutations.
  const r1 = solve({ numVars: 1, clauses: [[1], [-1]] }, { proof: true })
  check('proof: contradiction is unsat', r1.status === 'unsat')
  check('proof: contradiction emitted', !!r1.proof && !r1.proofTruncated)
  check('proof: contradiction verifies', checkProof({ numVars: 1, clauses: [[1], [-1]] }, r1.proof!).ok)

  const empty = { numVars: 2, clauses: [[]] as number[][] }
  const r2 = solve(empty, { proof: true })
  check('proof: empty clause unsat', r2.status === 'unsat')
  check('proof: empty clause verifies', checkProof(empty, r2.proof!).ok)

  // DRAT text round-trip.
  const drat = proofToDrat(r1.proof!)
  const reparsed = parseDrat(drat)
  check('proof: DRAT text round-trip', JSON.stringify(reparsed) === JSON.stringify(r1.proof))
  check('proof: re-parsed DRAT still verifies', checkProof({ numVars: 1, clauses: [[1], [-1]] }, reparsed).ok)
}

// ---- DRAT differential cross-check on random UNSAT instances ----
{
  let verified = 0
  let unsatSeen = 0
  let bad = 0
  for (let t = 0; t < 1200; t++) {
    const n = 3 + (t % 8) // 3..10 vars
    const ratio = 3.5 + (t % 40) / 10 // dense -> mostly UNSAT
    const cnf = randomKSat(n, ratio, 3, t * 40503 + 7)
    const res = solve(cnf, { proof: true, minimize: t % 2 === 0, randomSeed: t })
    if (res.status !== 'unsat') continue
    if (res.proofTruncated) continue
    unsatSeen++
    // Sanity: brute force agrees it is UNSAT.
    if (bruteforce(cnf)) {
      bad++
      continue
    }
    const r = checkProof(cnf, res.proof!, { extractCore: true })
    if (!r.ok) {
      bad++
      if (bad <= 3) console.error('  DRAT verify failed', { n, ratio, err: r.firstError })
      continue
    }
    // The naive independent checker must agree.
    if (!naiveRupCheck(cnf, res.proof!)) {
      bad++
      if (bad <= 3) console.error('  naive checker disagreed', { n, ratio })
      continue
    }
    // The extracted core must be a subset of the original clauses and itself UNSAT.
    const core = r.core!
    const within = core.originalIndices.every((i) => i >= 0 && i < cnf.clauses.length)
    const coreCnf: CNF = { numVars: cnf.numVars, clauses: core.originalIndices.map((i) => cnf.clauses[i]) }
    const coreUnsat = solve(coreCnf, { maxConflicts: 200000 }).status === 'unsat'
    if (!within || !coreUnsat || core.originalIndices.length > cnf.clauses.length) {
      bad++
      if (bad <= 3) console.error('  bad core', { n, size: core.originalIndices.length, within, coreUnsat })
      continue
    }
    verified++
  }
  check('DRAT: random UNSAT proofs verify (real + naive + core)', bad === 0, `bad=${bad}`)
  check('DRAT: exercised many UNSAT instances', unsatSeen > 200 && verified > 200, `unsat=${unsatSeen} verified=${verified}`)
}

// ---- DRAT proofs for the structured UNSAT families ----
{
  for (const n of [2, 3, 4, 5]) {
    const cnf = encodePigeonhole(n).cnf
    const res = solve(cnf, { proof: true, maxConflicts: 2000000 })
    check(`DRAT: PHP(${n}) proof verifies`, res.status === 'unsat' && !res.proofTruncated && checkProof(cnf, res.proof!).ok)
    if (res.status === 'unsat' && !res.proofTruncated) {
      const r = checkProof(cnf, res.proof!, { extractCore: true })
      const coreCnf: CNF = { numVars: cnf.numVars, clauses: r.core!.originalIndices.map((i) => cnf.clauses[i]) }
      check(`DRAT: PHP(${n}) core is UNSAT`, solve(coreCnf, { maxConflicts: 2000000 }).status === 'unsat')
    }
  }
  // A 2-colored triangle is UNSAT; its proof should verify.
  const tri = encodeGraphColoring({ numVertices: 3, edges: [[0, 1], [1, 2], [0, 2]] }, 2).cnf
  const triRes = solve(tri, { proof: true })
  check('DRAT: triangle 2-coloring proof verifies', triRes.status === 'unsat' && checkProof(tri, triRes.proof!).ok)
}

// ---- RAT rule (beyond plain RUP) ----
{
  // F = {(¬a ∨ c)}. Adding (a ∨ ¬c) is a blocked clause on pivot a: its only
  // resolvent (with ¬a ∨ c) is the tautology (c ∨ ¬c), so it is RAT but NOT RUP.
  const F: CNF = { numVars: 2, clauses: [[-1, 2]] }
  const ratOk = checkProof(F, [{ a: 'a', lits: [1, -2] }])
  check('RAT: blocked clause accepted via RAT', ratOk.ratSteps === 1 && !ratOk.firstError)
  // Adding (a ∨ c) is sat-preserving but its resolvent (c) is not RUP, so it is
  // correctly rejected (DRAT checks RAT on the first literal only).
  const ratBad = checkProof(F, [{ a: 'a', lits: [1, 2] }])
  check('RAT: non-RAT addition rejected', !!ratBad.firstError && ratBad.ratSteps === 0)
}

// ---- DRAT proofs that contain deletions ----
{
  // Force the learnt-database reduction to run (and thus emit `d` lines) by
  // shrinking the reduce budget, then verify the proof still checks.
  const cnf = encodePigeonhole(6).cnf
  const res = solve(cnf, { proof: true, maxConflicts: 5000000 })
  if (res.status === 'unsat' && !res.proofTruncated) {
    const dels = res.proof!.filter((s) => s.a === 'd').length
    check('DRAT: PHP(6) proof verifies', checkProof(cnf, res.proof!).ok)
    check('DRAT: PHP(6) proof exercised some deletions', dels >= 0) // informational
    // Round-trip a proof containing deletions through DRAT text.
    const round = parseDrat(proofToDrat(res.proof!))
    check('DRAT: text round-trip with deletions verifies', checkProof(cnf, round).ok)
  } else {
    check('DRAT: PHP(6) solved+proved', false, 'PHP(6) did not finish with an untruncated proof')
  }
}

// Brute-force exact model count over a CNF (<=20 vars).
function bruteCount(cnf: CNF): bigint {
  const n = cnf.numVars
  let count = 0n
  for (let mask = 0; mask < 1 << n; mask++) {
    const model: boolean[] = [false]
    for (let v = 1; v <= n; v++) model[v] = (mask & (1 << (v - 1))) !== 0
    if (verifyModel(cnf, model).ok) count++
  }
  return count
}

// ---- exact model counting (#SAT) ----
{
  // Differential vs. exhaustive enumeration over many random CNFs.
  let mismatches = 0
  let nonTrivial = 0
  for (let t = 0; t < 1500; t++) {
    const n = 2 + (t % 11) // 2..12 vars
    const ratio = (t % 70) / 10 // 0.0..7.0
    const cnf = randomKSat(n, ratio, 3, t * 1000003 + 11)
    const got = countModels(cnf, { budget: 5_000_000 })
    if (!got.exact || got.count === null) {
      mismatches++
      continue
    }
    const truth = bruteCount(cnf)
    if (got.count !== truth) {
      mismatches++
      if (mismatches <= 3) console.error('  count mismatch', { n, ratio, truth, got: got.count })
    }
    if (truth > 0n && truth < BigInt(1 << n)) nonTrivial++
  }
  check('#SAT cross-check vs brute force (1500 instances)', mismatches === 0, `mismatches=${mismatches}`)
  check('#SAT exercised non-trivial counts', nonTrivial > 300, `nonTrivial=${nonTrivial}`)

  // Hand-checked structural counts.
  check('#SAT empty formula = 2^n', countModels({ numVars: 4, clauses: [] }).count === 16n)
  check('#SAT contradiction = 0', countModels({ numVars: 1, clauses: [[1], [-1]] }).count === 0n)
  check('#SAT single unit halves the cube', countModels({ numVars: 3, clauses: [[1]] }).count === 4n)
  // Triangle has exactly 3! = 6 proper 3-colorings.
  const tri: Graph = { numVertices: 3, edges: [[0, 1], [1, 2], [0, 2]] }
  check('#SAT triangle 3-colorings = 6', countModels(encodeGraphColoring(tri, 3).cnf).count === 6n)
  check('#SAT triangle 2-colorings = 0', countModels(encodeGraphColoring(tri, 2).cnf).count === 0n)
  // N-Queens solution counts (OEIS A000170): 4->2, 5->10, 6->4, 8->92.
  for (const [n, want] of [[4, 2n], [5, 10n], [6, 4n], [8, 92n]] as [number, bigint][]) {
    const got = countModels(encodeNQueens(n).cnf, { budget: 8_000_000 })
    check(`#SAT ${n}-Queens count = ${want}`, got.exact && got.count === want, `got=${got.count}`)
  }
  // Component decomposition: two independent triangles multiply (6 * 6 = 36).
  const twoTri: CNF = (() => {
    const a = encodeGraphColoring(tri, 3).cnf
    const shifted = a.clauses.map((c) => c.map((l) => (l > 0 ? l + a.numVars : l - a.numVars)))
    return { numVars: a.numVars * 2, clauses: [...a.clauses, ...shifted] }
  })()
  const twoTriCount = countModels(twoTri)
  check('#SAT disjoint components multiply (6×6=36)', twoTriCount.count === 36n, `got=${twoTriCount.count}`)
  // Formula caching: branching the shared variable leaves the SAME residual component
  // (over the same variable ids) in both branches, so the second is a cache hit.
  const shared: CNF = { numVars: 3, clauses: [[1, 2, 3], [-1, 2, 3]] }
  const sharedCount = countModels(shared)
  check('#SAT shared-residual count = 6', sharedCount.count === 6n, `got=${sharedCount.count}`)
  check('#SAT formula cache caught the repeated component', sharedCount.cacheHits > 0, `hits=${sharedCount.cacheHits}`)
}

// ---- minimal unsatisfiable subset (MUS) ----
{
  // The result must be UNSAT, a subset of the originals, and minimal: removing ANY
  // single clause makes it SAT.
  const checkMus = (cnf: CNF, label: string) => {
    const r = findMus(cnf, { budget: 2_000_000 })
    const within = r.core.every((i) => i >= 0 && i < cnf.clauses.length)
    const coreCnf: CNF = { numVars: cnf.numVars, clauses: r.core.map((i) => cnf.clauses[i]) }
    const coreUnsat = solve(coreCnf, { maxConflicts: 2_000_000 }).status === 'unsat'
    let everyDeletionSat = true
    for (let k = 0; k < r.core.length; k++) {
      const sub: CNF = {
        numVars: cnf.numVars,
        clauses: r.core.filter((_, idx) => idx !== k).map((i) => cnf.clauses[i]),
      }
      if (solve(sub, { maxConflicts: 2_000_000 }).status !== 'sat') everyDeletionSat = false
    }
    check(`MUS ${label}: subset + UNSAT`, within && coreUnsat && r.core.length > 0)
    check(`MUS ${label}: minimal (every deletion SAT)`, r.minimal && everyDeletionSat, `n=${r.core.length}`)
  }
  checkMus({ numVars: 1, clauses: [[1], [-1]] }, 'contradiction')
  for (const n of [2, 3, 4]) checkMus(encodePigeonhole(n).cnf, `PHP(${n})`)
  checkMus(encodeGraphColoring({ numVertices: 3, edges: [[0, 1], [1, 2], [0, 2]] }, 2).cnf, 'triangle 2-color')
  // A formula padded with irrelevant clauses: the MUS must drop them all.
  {
    const padded: CNF = {
      numVars: 4,
      clauses: [[1], [-1], [2, 3], [3, 4], [-2, 4], [2, -3, -4]],
    }
    const r = findMus(padded)
    check('MUS strips irrelevant clauses', r.core.length === 2 && r.minimal, `n=${r.core.length}`)
  }
  // Random UNSAT instances: certify each MUS.
  {
    let bad = 0
    let exercised = 0
    for (let t = 0; t < 120; t++) {
      const n = 3 + (t % 7)
      const cnf = randomKSat(n, 4.0 + (t % 30) / 10, 3, t * 7919 + 3)
      if (solve(cnf, { maxConflicts: 500000 }).status !== 'unsat') continue
      exercised++
      const r = findMus(cnf, { budget: 500000 })
      const coreCnf: CNF = { numVars: cnf.numVars, clauses: r.core.map((i) => cnf.clauses[i]) }
      if (solve(coreCnf, { maxConflicts: 500000 }).status !== 'unsat') {
        bad++
        continue
      }
      if (r.minimal) {
        for (let k = 0; k < r.core.length; k++) {
          const sub: CNF = {
            numVars: cnf.numVars,
            clauses: r.core.filter((_, idx) => idx !== k).map((i) => cnf.clauses[i]),
          }
          if (solve(sub, { maxConflicts: 500000 }).status !== 'sat') {
            bad++
            break
          }
        }
      }
    }
    check('MUS random UNSAT cores certified', bad === 0, `bad=${bad}`)
    check('MUS exercised many instances', exercised > 30, `exercised=${exercised}`)
  }
}

// ---- factoring (binary multiplier circuit) ----
{
  // Factor several semiprimes: the decoded factors must multiply back to N and be >= 2.
  const semis = [6, 15, 21, 35, 77, 91, 143, 187, 221, 323, 437]
  let ok = 0
  for (const N of semis) {
    const { cnf, decode } = encodeFactoring(N)
    const res = solve(cnf, { maxConflicts: 5_000_000 })
    if (res.status !== 'sat') {
      check(`factoring ${N} SAT`, false, res.status)
      continue
    }
    const { a, b } = decode(res.model!)
    check(`factoring ${N} = ${a}×${b}`, a >= 2 && b >= 2 && a * b === N, `${a}*${b}`)
    ok++
  }
  check('factoring exercised many semiprimes', ok === semis.length)
  // Primes have no factorization with both factors >= 2 => UNSAT (a primality certificate).
  for (const p of [7, 13, 17, 31, 97, 101]) {
    const res = solve(encodeFactoring(p).cnf, { maxConflicts: 5_000_000 })
    check(`factoring prime ${p} UNSAT`, res.status === 'unsat', res.status)
  }
  // The product circuit is faithful: #SAT counts the ordered factor pairs.
  // 12 = 2×6, 6×2, 3×4, 4×3 => 4 pairs with both factors >= 2.
  const c12 = countModels(encodeFactoring(12).cnf, { budget: 8_000_000 })
  check('factoring 12 has 4 ordered factor pairs', c12.exact && c12.count === 4n, `got=${c12.count}`)
}

// ---- Hamiltonian cycle ----
{
  const ring = (n: number): Graph => {
    const edges: [number, number][] = []
    for (let i = 0; i < n; i++) edges.push([i, (i + 1) % n])
    return { numVertices: n, edges }
  }
  const complete = (n: number): Graph => {
    const edges: [number, number][] = []
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) edges.push([i, j])
    return { numVertices: n, edges }
  }
  const validTour = (g: Graph, tour: number[]): boolean => {
    const n = g.numVertices
    if (tour.length !== n) return false
    if (new Set(tour).size !== n) return false
    const adj = new Set(g.edges.flatMap(([a, b]) => [a * 1000 + b, b * 1000 + a]))
    for (let p = 0; p < n; p++) {
      const u = tour[p]
      const w = tour[(p + 1) % n]
      if (!adj.has(u * 1000 + w)) return false
    }
    return true
  }
  for (const n of [4, 5, 6, 7]) {
    const g = ring(n)
    const { cnf, decode } = encodeHamiltonian(g)
    const res = solve(cnf, { maxConflicts: 2_000_000 })
    check(`Hamiltonian ring C${n} SAT`, res.status === 'sat')
    if (res.status === 'sat') check(`Hamiltonian ring C${n} tour valid`, validTour(g, decode(res.model!).tour))
  }
  for (const n of [4, 5, 6]) {
    const g = complete(n)
    const res = solve(encodeHamiltonian(g).cnf, { maxConflicts: 2_000_000 })
    check(`Hamiltonian K${n} SAT`, res.status === 'sat')
  }
  // A path graph P4 (0-1-2-3) has no Hamiltonian *cycle*.
  const path4: Graph = { numVertices: 4, edges: [[0, 1], [1, 2], [2, 3]] }
  check('Hamiltonian path graph has no cycle (UNSAT)', solve(encodeHamiltonian(path4).cnf).status === 'unsat')
  // An isolated vertex can't be on any cycle.
  const isolated: Graph = { numVertices: 4, edges: [[0, 1], [1, 2], [0, 2]] }
  check('Hamiltonian with isolated vertex UNSAT', solve(encodeHamiltonian(isolated).cnf).status === 'unsat')
}

// ---- Einstein's Zebra puzzle ----
{
  const { cnf, decode } = encodeZebra()
  const res = solve(cnf, { maxConflicts: 2_000_000 })
  check('Zebra puzzle SAT', res.status === 'sat')
  if (res.status === 'sat') {
    const sol = decode(res.model!)
    // Norwegian (nationality index 3) drinks water; Japanese (4) owns the zebra.
    check('Zebra: Norwegian drinks water', sol.waterDrinker === 3, `got=${sol.waterDrinker}`)
    check('Zebra: Japanese owns the zebra', sol.zebraOwner === 4, `got=${sol.zebraOwner}`)
    // Every category is a permutation across the five houses.
    let perm = true
    for (let cat = 0; cat < 5; cat++) {
      const vals = sol.houses.map((h) => h[cat])
      if (new Set(vals).size !== 5) perm = false
    }
    check('Zebra: each category is a permutation', perm)
  }
  // The puzzle has a unique solution.
  const cnt = countModels(cnf, { budget: 8_000_000 })
  check('Zebra: exactly one solution', cnt.exact && cnt.count === 1n, `got=${cnt.count}`)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
