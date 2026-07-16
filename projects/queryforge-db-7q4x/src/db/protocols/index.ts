// Public surface of the pluggable concurrency-control protocol layer.

export type {
  ProtocolId,
  ProtocolMeta,
  ProtocolEngine,
  Predicate,
  Access,
} from './types'
export { INDEX_GUARD } from './types'
export type {
  ProtocolRunResult,
  ProtocolStep,
  ProtocolStepStatus,
  TxnOutcome,
  RunMetrics,
} from './result'
export { analyzeHistory, replaySerial } from './history'
export type { OracleResult } from './history'
export { runProtocol } from './scheduler'
export {
  runOne,
  runAll,
  makeEngine,
  generateSchedule,
  PROTOCOL_METAS,
  PROTOCOL_ORDER,
} from './compare'
export type { GenOptions } from './compare'
export { runBenchmark } from './bench'
export type { BenchResult, BenchPoint, ProtocolBenchStat, BenchOptions } from './bench'
export { TwoPhaseLockEngine, LockManager, S2PL_META } from './lock2pl'
export { OptimisticEngine, OCC_META } from './occ'
export { TimestampEngine, TO_META } from './timestamp'
export { runMvccAsProtocol, MVCC_META } from './mvccAdapter'
