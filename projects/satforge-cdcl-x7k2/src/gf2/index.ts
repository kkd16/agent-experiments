// The GF(2) / XOR-reasoning subsystem — a Gaussian-elimination engine for parity
// constraints, a hybrid DPLL(⊕) solver, the Lights Out & LFSR demonstrations,
// authoring front-ends, and a differential self-check. See each module's header
// for the details; this barrel is the studio's single import surface.

export {
  popcountBig,
  lowestSetBit,
  cloneSystem,
  rref,
  solutionCount,
  solutionCountOf,
  particularSolution,
  nullSpaceBasis,
  satisfies,
  enumerateSolutions,
  linearBackbone,
} from './gf2'
export type { Gf2Row, Gf2System, RrefResult } from './gf2'

export {
  normalizeXorLits,
  makeXor,
  xorToClauses,
  xorCnfToCnf,
  xorSystem,
  xorsToSystem,
  recoverXors,
  verifyXors,
} from './xor'
export type { XorClause, XorCnf, RecoverResult } from './xor'

export { solveMixed } from './solver'
export type { MixedResult, MixedStats, MixedOptions } from './solver'

export {
  mulberry32,
  randomConnectedGraph,
  tseitinFormula,
  randomKXorSat,
  parityChain,
  GF2_EXAMPLES,
} from './examples'
export type { Graph, TseitinResult, Gf2Example } from './examples'

export { lightsOutSystem, applyPresses, solveLightsOut, quietDimension } from './lightsout'
export type { LightsOutSolution } from './lightsout'

export { runLfsr, lfsrRecoverySystem, breakLfsr, randomLfsr } from './crypto'
export type { LfsrSpec, LfsrBreak } from './crypto'

export { rrefTrace } from './trace'
export type { RrefStep, RrefTrace } from './trace'

export { parseXorDimacs, parseXorDsl, toXorDimacs } from './parse'
export type { ParseXorResult, ParseXorOk, ParseXorErr } from './parse'

export { runGf2Checks } from './selfcheck'
export type { Gf2CheckReport } from './selfcheck'
