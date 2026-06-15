// Maps a high-level problem specification to a CNF plus the metadata each view
// needs to render the solution.
import type { CNF } from './sat'
import {
  encodeNQueens,
  encodeSudoku,
  parseSudoku,
  encodeGraphColoring,
  randomGraph,
  encodePigeonhole,
  encodeLangford,
  randomKSat,
  parseDimacs,
  encodeFactoring,
  encodeHamiltonian,
  encodeZebra,
} from './sat'
import type {
  Graph,
  NQueensSolution,
  SudokuSolution,
  ColoringSolution,
  LangfordSolution,
  FactorSolution,
  HamiltonianSolution,
  ZebraSolution,
} from './sat'

export type ProblemKind =
  | 'nqueens'
  | 'sudoku'
  | 'coloring'
  | 'hamiltonian'
  | 'factoring'
  | 'zebra'
  | 'pigeonhole'
  | 'langford'
  | 'random'
  | 'dimacs'

export interface ProblemSpec {
  kind: ProblemKind
  n: number // queens size / hole count / random var count / coloring & hamiltonian vertices
  ratio: number // random-SAT clause ratio
  k: number // coloring colors
  edgeProb: number // coloring / hamiltonian graph density
  seed: number
  sudoku: string // sudoku puzzle string
  dimacs: string // raw DIMACS text
  target: number // factoring target N
}

export interface BuiltProblem {
  kind: ProblemKind
  cnf: CNF
  title: string
  subtitle: string
  render: 'queens' | 'sudoku' | 'coloring' | 'hamiltonian' | 'factoring' | 'zebra' | 'langford' | 'model' | 'none'
  graph?: Graph
  clues?: number[]
  decodeQueens?: (m: boolean[]) => NQueensSolution
  decodeSudoku?: (m: boolean[]) => SudokuSolution
  decodeColoring?: (m: boolean[]) => ColoringSolution
  decodeLangford?: (m: boolean[]) => LangfordSolution
  decodeHamiltonian?: (m: boolean[]) => HamiltonianSolution
  decodeFactoring?: (m: boolean[]) => FactorSolution
  decodeZebra?: (m: boolean[]) => ZebraSolution
  warnings?: string[]
  error?: string
}

export const DEFAULT_SPEC: ProblemSpec = {
  kind: 'nqueens',
  n: 8,
  ratio: 4.26,
  k: 3,
  edgeProb: 0.45,
  seed: 1,
  sudoku: '53..7....6..195....98....6.8...6...34..8.3..17...2...6.6....28....419..5....8..79',
  dimacs: 'c A small satisfiable example\np cnf 4 4\n1 2 0\n-1 3 0\n-2 -3 4 0\n-4 1 0\n',
  target: 143,
}

export function buildProblem(spec: ProblemSpec): BuiltProblem {
  try {
    switch (spec.kind) {
      case 'nqueens': {
        const n = clampInt(spec.n, 1, 40)
        const { cnf, decode } = encodeNQueens(n)
        return {
          kind: spec.kind,
          cnf,
          title: `${n}-Queens`,
          subtitle: `Place ${n} non-attacking queens on a ${n}×${n} board.`,
          render: 'queens',
          decodeQueens: decode,
        }
      }
      case 'sudoku': {
        const clues = parseSudoku(spec.sudoku, 9)
        const { cnf, decode } = encodeSudoku(clues, 3)
        const given = clues.filter((c) => c > 0).length
        return {
          kind: spec.kind,
          cnf,
          title: 'Sudoku',
          subtitle: `Solve a 9×9 Sudoku with ${given} given clues.`,
          render: 'sudoku',
          clues,
          decodeSudoku: decode,
        }
      }
      case 'coloring': {
        const n = clampInt(spec.n, 2, 40)
        const k = clampInt(spec.k, 1, 8)
        const graph = randomGraph(n, clamp(spec.edgeProb, 0.05, 0.95), spec.seed | 0)
        const { cnf, decode } = encodeGraphColoring(graph, k)
        return {
          kind: spec.kind,
          cnf,
          title: `Graph ${k}-coloring`,
          subtitle: `Color ${n} vertices / ${graph.edges.length} edges with ${k} colors.`,
          render: 'coloring',
          graph,
          decodeColoring: decode,
        }
      }
      case 'hamiltonian': {
        const n = clampInt(spec.n, 3, 18)
        const graph = randomGraph(n, clamp(spec.edgeProb, 0.2, 0.95), spec.seed | 0)
        const { cnf, decode } = encodeHamiltonian(graph)
        return {
          kind: spec.kind,
          cnf,
          title: `Hamiltonian cycle`,
          subtitle: `Find a closed tour visiting all ${n} vertices once (${graph.edges.length} edges).`,
          render: 'hamiltonian',
          graph,
          decodeHamiltonian: decode,
        }
      }
      case 'factoring': {
        const N = clampInt(spec.target, 2, 1_000_000)
        const { cnf, decode, bits } = encodeFactoring(N)
        return {
          kind: spec.kind,
          cnf,
          title: `Factoring ${N}`,
          subtitle: `Find a·b = ${N} with a,b ≥ 2 via a ${bits}-bit multiplier circuit — UNSAT means ${N} is prime.`,
          render: 'factoring',
          decodeFactoring: decode,
        }
      }
      case 'zebra': {
        const { cnf, decode } = encodeZebra()
        return {
          kind: spec.kind,
          cnf,
          title: `Einstein's Zebra puzzle`,
          subtitle: `Five houses, 25 attributes, 15 clues — who drinks water and who owns the zebra?`,
          render: 'zebra',
          decodeZebra: decode,
        }
      }
      case 'pigeonhole': {
        const n = clampInt(spec.n, 1, 14)
        const { cnf } = encodePigeonhole(n)
        return {
          kind: spec.kind,
          cnf,
          title: `Pigeonhole PHP(${n})`,
          subtitle: `${n + 1} pigeons into ${n} holes — provably UNSAT (hard for resolution).`,
          render: 'none',
        }
      }
      case 'langford': {
        const n = clampInt(spec.n, 1, 16)
        const { cnf, decode } = encodeLangford(n)
        const solvable = n % 4 === 0 || n % 4 === 3
        return {
          kind: spec.kind,
          cnf,
          title: `Langford pairing L(${n})`,
          subtitle: `Arrange two each of 1..${n} so the two k's are k apart — ${
            solvable ? 'satisfiable' : 'provably UNSAT'
          } (solvable iff n ≡ 0 or 3 mod 4).`,
          render: 'langford',
          decodeLangford: decode,
        }
      }
      case 'random': {
        const n = clampInt(spec.n, 1, 400)
        const cnf = randomKSat(n, clamp(spec.ratio, 0.1, 10), 3, spec.seed | 0)
        return {
          kind: spec.kind,
          cnf,
          title: `Random 3-SAT`,
          subtitle: `${n} variables, ${cnf.clauses.length} clauses (α = ${spec.ratio.toFixed(2)}).`,
          render: 'model',
        }
      }
      case 'dimacs': {
        const { cnf, warnings } = parseDimacs(spec.dimacs)
        return {
          kind: spec.kind,
          cnf,
          title: 'Custom CNF',
          subtitle: `${cnf.numVars} variables, ${cnf.clauses.length} clauses from DIMACS.`,
          render: 'model',
          warnings,
        }
      }
    }
  } catch (e) {
    return {
      kind: spec.kind,
      cnf: { numVars: 0, clauses: [] },
      title: 'Error',
      subtitle: '',
      render: 'none',
      error: e instanceof Error ? e.message : String(e),
    }
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x))
}
function clampInt(x: number, lo: number, hi: number): number {
  return Math.round(clamp(x, lo, hi))
}
