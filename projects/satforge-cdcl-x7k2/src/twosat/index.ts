// 2-SAT subsystem: the linear-time implication-graph decision procedure
// (Aspvall–Plass–Tarjan) promoted to a first-class, visual studio — model
// extraction, equivalent-literal classes, the backbone, and the condensation
// DAG, all cross-checked against the project's own CDCL solver and brute force.

export {
  decide2Sat,
  isSat2,
  is2Cnf,
  wideClauses,
  litToNode,
  nodeToLit,
  negNode,
} from './twosat'
export type { TwoSatResult, ImplEdge, Condensation, Backbone } from './twosat'

export {
  TWO_SAT_EXAMPLES,
  randomTwoSat,
  twoColoringCnf,
  cycleEdges,
  mulberry32,
} from './examples'
export type { TwoSatExample } from './examples'

export {
  layoutImplication,
  layoutCondensation,
  compColor,
  litLabel,
} from './layout'
export type {
  ImplicationLayout,
  CondensationLayout,
  LaidOutNode,
  LaidOutEdge,
  CondNode,
  CondEdge,
} from './layout'

export { runTwoSatChecks } from './selfcheck'
export type { TwoSatCheckReport } from './selfcheck'
