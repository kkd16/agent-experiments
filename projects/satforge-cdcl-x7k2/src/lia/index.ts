// LIA subsystem: a complete, exact decision procedure for quantifier-free
// linear integer arithmetic (QF_LIA) by the Omega test (Pugh 1991), promoted to
// a first-class studio. Real / dark / gray-shadow variable elimination, Euclid
// equality reduction, certificate-checked integer models, and an elimination
// trace — all cross-checked against exhaustive brute force.

export type { Lin } from './lin'
export {
  zero,
  constant,
  variable,
  evalLin,
  formatLin,
  add,
  sub,
  scale,
  negate,
  gcdBig,
} from './lin'

export { omegaTest, verifyModel, OmegaBudgetError } from './omega'
export type { Cons, OmegaResult, OmegaOptions } from './omega'

export { parseLia, parseObjective } from './parse'
export type { ParseResult, ParseOk, ParseErr, ObjectiveResult, ObjectiveOk, ObjectiveErr } from './parse'

export { optimize, objectiveValue, bruteOptimum } from './optimize'
export type { Dir, OptimizeResult, OptimizeOptions, OptStep } from './optimize'

export { bruteForce } from './brute'
export type { BruteResult } from './brute'

export {
  toNNF,
  simplify,
  eliminate,
  decide,
  evalFormula,
  formatFormula,
  freeVars,
  PresburgerBudgetError,
  T,
  F,
  andF,
  orF,
  notF,
  existsF,
  forallF,
  dvdF,
  ndvdF,
  ltF,
  lt,
  le,
  gt,
  ge,
  eq,
  ne,
} from './presburger'
export type { Formula, ElimResult } from './presburger'

export { parsePresburger } from './pparse'
export type { PParseResult, PParseOk, PParseErr } from './pparse'

export { PRESBURGER_EXAMPLES } from './pexamples'
export type { PresburgerExample } from './pexamples'

export { isTwoVar, lattice, feasiblePolygon, constraintLines } from './geometry'
export type { LatticePt, ConstraintLine } from './geometry'

export { LIA_EXAMPLES } from './examples'
export type { LiaExample } from './examples'

export { runLiaChecks } from './selfcheck'
export type { LiaCheckReport } from './selfcheck'
