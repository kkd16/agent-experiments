// The AIG / logic-synthesis subsystem — And-Inverter Graphs, a hardware DSL,
// bit-parallel simulation, a Tseitin bridge to the CDCL core, SAT sweeping (FRAIG)
// and combinational equivalence checking, plus a differential self-check. This
// barrel is the studio's single import surface.

export {
  Aig,
  CONST0,
  CONST1,
  mkLit,
  litNode,
  litInv,
  litNot,
} from './aig'
export type { Lit } from './aig'

export {
  parseCircuit,
  buildCircuit,
  buildPairFromDsl,
  rippleAdder,
  carrySelectAdder,
  arrayMultiplier,
  inputBus,
} from './build'
export type { Ast, Circuit, ParseCircuit, BuiltPair, BuildPairResult } from './build'

export { simulate, addPattern, canonical, evalPattern, truthTable } from './simulate'
export type { SimState } from './simulate'

export { tseitin } from './cnf'
export type { AigCnf } from './cnf'

export { fraig, checkEquivalence } from './cec'
export type { FraigResult, FraigStats, CecResult, OutputVerdict } from './cec'

export { AIG_EXAMPLES, exampleById } from './examples'
export type { AigExample } from './examples'

export { runAigChecks } from './selfcheck'
export type { AigCheckReport } from './selfcheck'
