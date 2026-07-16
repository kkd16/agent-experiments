// Symbolic Studio: bounded software verification for a tiny imperative language
// ("Mini") by symbolic execution. Every control-flow path is walked with a
// symbolic store; branch guards become linear integer constraints; each `assert`
// is discharged as a QF_LIA satisfiability query to the very same Omega test the
// LIA Studio uses — so a violated assertion comes back with a concrete input
// witness, and a clean loop-free program is verified for ALL inputs. A separate
// concrete interpreter is the oracle every verdict answers to.

export type { Expr, BExpr, Stmt, Program, RelOp } from './ast'
export { exprToString, bexprToString } from './ast'

export { parseProgram } from './parse'
export type { ParseResult } from './parse'

export { interpret, evalExpr, evalB } from './interp'
export type { RunStatus, RunOptions } from './interp'

export { symExecute } from './symexec'
export type { SymOptions, SymResult, Counterexample, PathSummary, Verdict } from './symexec'

export { SYMX_EXAMPLES } from './examples'
export type { SymxExample } from './examples'

export { runSymxChecks } from './selfcheck'
export type { SymxCheckReport } from './selfcheck'
