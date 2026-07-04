// Public surface of the Answer Set Programming subsystem.

export type { Term, Arg, Atom, BodyLit, CondLit, Head, Rule, CompareOp } from './ast'
export type { GroundProgram, Rule as GroundRule, AnswerSet } from './program'
export { formatAnswerSet, answerSetKey, ruleAtoms } from './program'
export { parseProgram, AspParseError } from './parse'
export type { ParseResult } from './parse'
export { ground, GroundError } from './ground'
export type { GroundResult } from './ground'
export {
  buildCompletion,
  unfoundedSet,
  solveAsp,
  wellFoundedModel,
} from './solve'
export type { Completion, AspSolveOptions, AspSolveResult, AspStats, WellFounded } from './solve'
export { bruteAnswerSets, isAnswerSet, normalizeForOracle } from './reduct'
export { positiveDependencyGraph, layoutDepGraph } from './depgraph'
export type { DepGraph, DepEdge, DepLayout, NodePos } from './depgraph'
export { derivationOrder, verifyCertificate, consequences } from './certificate'
export type { DerivationStep, Consequences } from './certificate'
export { ASP_EXAMPLES } from './examples'
export type { AspExample } from './examples'
export { runAspChecks } from './selfcheck'
export type { AspCheckReport } from './selfcheck'
