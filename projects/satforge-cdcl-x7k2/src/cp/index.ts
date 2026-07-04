// CP subsystem: a from-scratch finite-domain constraint-programming solver —
// domains + a propagation-fixpoint engine, a library of propagators (linear,
// ≠, element, table, and all-different at three filtering strengths including
// Régin's domain-consistent GAC), backtracking search with dom/wdeg + restarts,
// branch-and-bound optimisation, a declarative modelling layer, a gallery of
// classic models, and a differential self-test. Promoted to a first-class
// studio — the "other" way to solve the combinatorial problems the SAT/SMT
// engines tackle, cross-checked against them and against brute force.

export type { Domain } from './domain.ts'
export * as Dom from './domain.ts'

export { Store } from './store.ts'
export type { Propagator } from './store.ts'

export {
  allDifferent,
  element,
  linearLe,
  notEqual,
  table,
  floordiv,
  ceildiv,
} from './propagators.ts'
export type { AllDiffLevel } from './propagators.ts'

export { Model } from './model.ts'
export type { Op } from './model.ts'

export {
  search,
  searchStore,
  buildStore,
  optimize,
  countSolutions,
} from './search.ts'
export type {
  SearchOptions,
  SearchResult,
  SearchStats,
  SearchMode,
  VarHeuristic,
  ValHeuristic,
  TraceEvent,
  OptSense,
  OptimizeResult,
} from './search.ts'

export { CP_EXAMPLES, langfordLayout } from './examples.ts'
export type { CpExample, Built, RenderSpec, ParamSpec } from './examples.ts'

export { runCpChecks } from './selfcheck.ts'
export type { CpCheckReport } from './selfcheck.ts'
