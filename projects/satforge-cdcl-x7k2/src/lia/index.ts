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

export { parseLia } from './parse'
export type { ParseResult, ParseOk, ParseErr } from './parse'

export { bruteForce } from './brute'
export type { BruteResult } from './brute'

export { LIA_EXAMPLES } from './examples'
export type { LiaExample } from './examples'

export { runLiaChecks } from './selfcheck'
export type { LiaCheckReport } from './selfcheck'
