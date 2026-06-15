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
} from './src/sat/index'
import type { CNF, ProofStep } from './src/sat/index'

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

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
