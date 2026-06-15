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
  randomKSat,
  lubySequence,
} from './src/sat/index'
import type { CNF } from './src/sat/index'

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

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
