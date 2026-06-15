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
  encodeMaxCut,
  encodeVertexCover,
  encodeIndependentSet,
  randomWeightedMax2Sat,
  randomWeightedGraph,
  parseWcnf,
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
  MaxSatInstance,
  WeightedGraph,
  MaxCutSolution,
  VertexSubsetSolution,
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
  | 'maxcut'
  | 'vertexcover'
  | 'maxindset'
  | 'max2sat'
  | 'wcnf'

/** The optimization (MaxSAT) problem kinds, handled by the Optimize flow. */
export const MAXSAT_KINDS: ProblemKind[] = ['maxcut', 'vertexcover', 'maxindset', 'max2sat', 'wcnf']
export const isMaxSatKind = (k: ProblemKind) => MAXSAT_KINDS.includes(k)

export interface ProblemSpec {
  kind: ProblemKind
  n: number // queens size / hole count / random var count / coloring & hamiltonian vertices
  ratio: number // random-SAT clause ratio / MAX-2-SAT clause multiplier
  k: number // coloring colors
  edgeProb: number // coloring / hamiltonian / weighted-graph density
  seed: number
  sudoku: string // sudoku puzzle string
  dimacs: string // raw DIMACS text
  target: number // factoring target N
  maxWeight: number // max edge/clause weight for the weighted MaxSAT generators
  wcnf: string // raw WCNF text
  strategy: 'linear' | 'core-guided' // MaxSAT algorithm
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
  // --- MaxSAT (optimization) ---
  maxsat?: MaxSatInstance
  strategy?: 'linear' | 'core-guided'
  maxRender?: 'maxcut' | 'subset' | 'model'
  wgraph?: WeightedGraph
  totalWeight?: number // total soft weight (for "cut = total − cost" style readouts)
  costLabel?: string // human label for what the optimum cost means
  decodeMaxCut?: (m: boolean[]) => MaxCutSolution
  decodeSubset?: (m: boolean[]) => VertexSubsetSolution
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
  maxWeight: 4,
  wcnf: 'c Weighted partial MaxSAT (WCNF)\nc hard clauses use the top weight; soft clauses use their own.\np wcnf 4 6 100\n100 1 2 0\n100 -1 3 0\n3 -2 0\n5 -3 0\n4 -4 0\n2 4 1 0\n',
  strategy: 'linear',
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
      case 'maxcut': {
        const n = clampInt(spec.n, 3, 16)
        const g = randomWeightedGraph(n, clamp(spec.edgeProb, 0.1, 0.95), clampInt(spec.maxWeight, 1, 9), spec.seed | 0)
        const { instance, totalWeight, decode } = encodeMaxCut(g)
        return {
          ...maxBase(spec, instance),
          title: `Max-Cut`,
          subtitle: `Split ${n} vertices / ${g.edges.length} weighted edges to maximize the crossing weight (total ${totalWeight}).`,
          maxRender: 'maxcut',
          wgraph: g,
          totalWeight,
          costLabel: 'uncut weight',
          decodeMaxCut: decode,
        }
      }
      case 'vertexcover': {
        const n = clampInt(spec.n, 3, 16)
        const g = randomWeightedGraph(n, clamp(spec.edgeProb, 0.1, 0.95), 1, spec.seed | 0)
        const { instance, decode } = encodeVertexCover(g)
        return {
          ...maxBase(spec, instance),
          title: `Minimum Vertex Cover`,
          subtitle: `Pick the fewest vertices touching all ${g.edges.length} edges of a ${n}-vertex graph.`,
          maxRender: 'subset',
          wgraph: g,
          costLabel: 'cover size',
          decodeSubset: decode,
        }
      }
      case 'maxindset': {
        const n = clampInt(spec.n, 3, 16)
        const g = randomWeightedGraph(n, clamp(spec.edgeProb, 0.1, 0.95), 1, spec.seed | 0)
        const { instance, decode } = encodeIndependentSet(g)
        return {
          ...maxBase(spec, instance),
          title: `Maximum Independent Set`,
          subtitle: `Pick the most pairwise-nonadjacent vertices of a ${n}-vertex / ${g.edges.length}-edge graph.`,
          maxRender: 'subset',
          wgraph: g,
          totalWeight: n,
          costLabel: 'excluded vertices',
          decodeSubset: decode,
        }
      }
      case 'max2sat': {
        const n = clampInt(spec.n, 2, 18)
        const m = clampInt(n * clamp(spec.ratio, 0.5, 6), 1, 400)
        const instance = randomWeightedMax2Sat(n, m, clampInt(spec.maxWeight, 1, 9), spec.seed | 0)
        const total = instance.soft.reduce((s, c) => s + c.weight, 0)
        return {
          ...maxBase(spec, instance),
          title: `Weighted MAX-2-SAT`,
          subtitle: `${n} variables, ${m} weighted 2-clauses (total weight ${total}) — minimize the violated weight.`,
          maxRender: 'model',
          totalWeight: total,
          costLabel: 'violated weight',
        }
      }
      case 'wcnf': {
        const { instance, warnings } = parseWcnf(spec.wcnf)
        const total = instance.soft.reduce((s, c) => s + c.weight, 0)
        return {
          ...maxBase(spec, instance),
          title: 'Custom WCNF',
          subtitle: `${instance.numVars} variables · ${instance.hard.length} hard · ${instance.soft.length} soft clauses (total soft ${total}).`,
          maxRender: 'model',
          totalWeight: total,
          costLabel: 'violated weight',
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

/** Common BuiltProblem scaffolding for a MaxSAT (optimization) instance. */
function maxBase(spec: ProblemSpec, instance: MaxSatInstance): BuiltProblem {
  return {
    kind: spec.kind,
    cnf: { numVars: instance.numVars, clauses: instance.hard },
    title: '',
    subtitle: '',
    render: 'none',
    maxsat: instance,
    strategy: spec.strategy,
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x))
}
function clampInt(x: number, lo: number, hi: number): number {
  return Math.round(clamp(x, lo, hi))
}
