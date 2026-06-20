// QBF subsystem: a RAReQS abstraction-refinement solver for arbitrary prenex
// Quantified Boolean Formulas, reducing to the SatForge CDCL core, plus an
// exhaustive oracle, encoders, and a QDIMACS front-end.

export { solveQbf } from './solver'
export type { QbfResult, QbfStats, QbfOptions, QbfTraceEvent } from './solver'
export { evalQbf } from './eval'
export {
  parseQdimacs,
  toQdimacs,
  normalizeQbf,
  alternations,
  prefixString,
  QDimacsError,
} from './qdimacs'
export type { QBF, QBlock, Quant, QParseResult } from './qdimacs'
export {
  QBF_EXAMPLES,
  matchFamily,
  parityLadder,
  randomQbf,
} from './encoders'
export type { QExample, RandomQbfOptions } from './encoders'
export { runQbfChecks } from './selfcheck'
export type { QbfCheckReport } from './selfcheck'
