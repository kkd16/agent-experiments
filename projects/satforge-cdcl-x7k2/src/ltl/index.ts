// The LTL model-checking subsystem: a from-scratch explicit-state model checker
// — LTL → generalized Büchi automaton (GPVW tableau), synchronous product with
// a Kripke structure (degeneralized on the fly), and emptiness by nested DFS —
// every verdict refereed by an independent word-level LTL oracle. Surfaced as
// the Temporal Studio.

export type { Ltl } from './ast'
export { atomsOf, key, printLtl, size } from './ast'

export { parseLtl, tryParseLtl, LtlParseError } from './parse'
export { toNnf } from './nnf'

export { buildGba, labelMatches } from './buchi'
export type { Gba, GbaState } from './buchi'

export { parseKripke, printKripke, deadlocks, KripkeParseError } from './kripke'
export type { Kripke, KState } from './kripke'

export { buildProduct } from './product'
export type { ProductBa } from './product'

export { nestedDfs, findLasso } from './emptiness'
export type { NestedDfsResult, ProductLasso } from './emptiness'

export { modelCheck, counterexampleWord } from './check'
export type { Counterexample, ModelCheckResult, ModelCheckStats } from './check'

export { satisfiesLasso } from './ltleval'
export type { LassoWord } from './ltleval'

export { EXAMPLES, mulberry32, randomKripke, randomLassoWord, randomLtl } from './examples'
export type { Example } from './examples'

export { runLtlChecks } from './selfcheck'
export type { LtlCheckReport } from './selfcheck'
