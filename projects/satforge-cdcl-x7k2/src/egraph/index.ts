// The e-graph / equality-saturation subsystem: a from-scratch congruence-closure
// e-graph (the "egg" design) with an e-class analysis for constant folding, an
// e-matching rewriter that saturates to a fixpoint, a cost-based extractor, and
// an equality prover — every derivation cross-checked by an independent exact
// evaluator. Surfaced as the Congruence Studio.

export {
  parseTerm,
  printTerm,
  evalTerm,
  freeVars,
  termSize,
  termKey,
  EvalError,
} from './term'
export type { Term } from './term'

export { EGraph, constNode } from './egraph'
export type { EClassId, ENode } from './egraph'

export {
  saturate,
  extractBest,
  optimize,
  prove,
  costOf,
  opCost,
  ruleLabel,
} from './rewrite'
export type {
  Rewrite,
  IterInfo,
  SaturateResult,
  StopReason,
  SaturateOpts,
  OptimizeResult,
  ProveResult,
  Extraction,
} from './rewrite'

export { RULE_GROUPS, ALL_RULES, rulesFor } from './rules'
export type { RuleGroup } from './rules'

export {
  OPT_EXAMPLES,
  PROVE_EXAMPLES,
  mulberry32,
  randomTerm,
  tryParse,
} from './examples'
export type { OptExample, ProveExample } from './examples'

export { layoutEgraph } from './layout'
export type { EgLayout, EgBox, EgEdge, EgNodeRow } from './layout'

export { runEgraphChecks } from './selfcheck'
export type { EgraphCheckReport } from './selfcheck'
