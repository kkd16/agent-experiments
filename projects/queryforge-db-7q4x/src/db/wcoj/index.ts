// The worst-case-optimal join engine: variable-at-a-time joins that provably
// never build an intermediate bigger than their own answer (the AGM bound).
//
// A standalone module — like `vectorized/*`, `ivm/*`, `sketch/*` — built on the
// engine's own value order so every SQL type joins correctly.

export { Relation, relation, compareTuples, tuplesEqual } from './relation'
export type { Tuple } from './relation'
export { SortedTrie, TrieIterator } from './trie'
export { LeapfrogJoin } from './leapfrog'
export { triejoin, chooseOrder, queryVariables } from './triejoin'
export type { Atom, TrieJoinResult } from './triejoin'
export { solveGE } from './simplex'
export type { LpResult, LpStatus } from './simplex'
export { agmBound, fractionalCover } from './agm'
export type { AgmBound, FractionalCover } from './agm'
export { binaryJoin } from './binary'
export type { BinaryJoinResult } from './binary'
export { SHAPES, shape, randomInstance, denseInstance } from './query'
export type { Shape, ShapeId } from './query'
export { wcojReport, eliminationTrace } from './lab'
export type { WcojReport, EliminationLevel } from './lab'
