// Public surface of the QF_BV (bit-vector) subsystem: eager bit-blasting onto the
// CDCL core, with a BigInt reference semantics for cross-checking.
export { parseBv, BvSyntaxError } from './parse'
export { solveBv } from './solve'
export type { BvResult, BvVarValue, BvSolveOptions } from './solve'
export { evalForm, evalTerm, collectVars } from './reference'
export type { BvAssign } from './reference'
export { BitBlaster } from './blast'
export { runBvChecks } from './selfcheck'
export type { BvCheckReport } from './selfcheck'
export { BV_EXAMPLES } from './examples'
export type { BvExample } from './examples'
export type { BoolForm, BvTerm, BvScript } from './ast'
export { mask, toSigned } from './ast'
