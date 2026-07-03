// The sketch engine: probabilistic, sublinear, mergeable data summaries.
//
// Each sketch trades a provable, tiny error for a fixed (cardinality-independent)
// memory footprint and one-pass, mergeable state. They are the substrate of
// approximate query processing — `APPROX_COUNT_DISTINCT`, `APPROX_PERCENTILE`,
// `APPROX_TOP_K`, `TABLESAMPLE`, and Bloom join filters.

export { murmur32, mix32, hashValue64, hashString64, ctz32, popcount32, rho64 } from './hash'
export type { Hash64 } from './hash'
export { HyperLogLog, mergeHLL } from './hll'
export { CountMin } from './countmin'
export { SpaceSaving } from './spacesaving'
export type { HeavyHitter } from './spacesaving'
export { TDigest } from './tdigest'
export type { Centroid } from './tdigest'
export { Reservoir, WeightedReservoir } from './reservoir'
export { BloomFilter, CountingBloomFilter, bloomParams, bloomSemiJoin } from './bloom'
