// The concrete interpreter — Mini's *reference semantics* and the independent
// oracle for every symbolic verdict. It shares no code with the symbolic
// executor: it runs the program forward on honest-to-goodness `bigint`s, taking
// exactly one branch at each `if`, iterating `while` loops fully (up to a step
// cap), and reporting the first `assert` that fails. When the symbolic engine
// claims "these inputs violate assertion A", we run *this* on those inputs and
// insist it agrees.

import type { BExpr, Expr, Program, Stmt } from './ast'

export type RunStatus =
  | { kind: 'ok' } // reached the end with every assertion holding
  | { kind: 'assert-failed'; text: string; step: number } // an assert was violated
  | { kind: 'assume-failed'; text: string } // an assume was violated (input outside the assumption)
  | { kind: 'diverged' } // exceeded the step budget (loop did not terminate)
  | { kind: 'error'; message: string } // e.g. a genuinely non-linear op is fine here, but div-by-zero etc.

export interface RunOptions {
  maxSteps?: number
}

class Diverged extends Error {}
class AssertFail extends Error {
  readonly text: string
  readonly step: number
  constructor(text: string, step: number) {
    super('assert failed')
    this.text = text
    this.step = step
  }
}
class AssumeFail extends Error {
  readonly text: string
  constructor(text: string) {
    super('assume failed')
    this.text = text
  }
}

export function interpret(program: Program, inputs: Map<string, bigint>, opts: RunOptions = {}): RunStatus {
  const maxSteps = opts.maxSteps ?? 200_000
  const env = new Map<string, bigint>()
  for (const name of program.inputs) env.set(name, inputs.get(name) ?? 0n)
  const state = { steps: 0 }

  try {
    runBlock(program.body, env, state, maxSteps)
    return { kind: 'ok' }
  } catch (e) {
    if (e instanceof AssertFail) return { kind: 'assert-failed', text: e.text, step: e.step }
    if (e instanceof AssumeFail) return { kind: 'assume-failed', text: e.text }
    if (e instanceof Diverged) return { kind: 'diverged' }
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) }
  }
}

function runBlock(stmts: Stmt[], env: Map<string, bigint>, state: { steps: number }, maxSteps: number): void {
  for (const s of stmts) runStmt(s, env, state, maxSteps)
}

function runStmt(s: Stmt, env: Map<string, bigint>, state: { steps: number }, maxSteps: number): void {
  if (++state.steps > maxSteps) throw new Diverged()
  switch (s.kind) {
    case 'input':
      // Inputs are pre-seeded in `env`; a redundant declaration is a no-op.
      return
    case 'assign':
      env.set(s.name, evalExpr(s.e, env))
      return
    case 'if':
      if (evalB(s.cond, env)) runBlock(s.then, env, state, maxSteps)
      else runBlock(s.else, env, state, maxSteps)
      return
    case 'while':
      while (evalB(s.cond, env)) {
        if (++state.steps > maxSteps) throw new Diverged()
        runBlock(s.body, env, state, maxSteps)
      }
      return
    case 'assume':
      if (!evalB(s.cond, env)) throw new AssumeFail(s.text)
      return
    case 'assert':
      if (!evalB(s.cond, env)) throw new AssertFail(s.text, state.steps)
      return
  }
}

export function evalExpr(e: Expr, env: Map<string, bigint>): bigint {
  switch (e.kind) {
    case 'num':
      return e.value
    case 'var':
      return env.get(e.name) ?? 0n
    case 'neg':
      return -evalExpr(e.e, env)
    case 'bin': {
      const a = evalExpr(e.a, env)
      const b = evalExpr(e.b, env)
      return e.op === '+' ? a + b : e.op === '-' ? a - b : a * b
    }
  }
}

export function evalB(b: BExpr, env: Map<string, bigint>): boolean {
  switch (b.kind) {
    case 'blit':
      return b.value
    case 'not':
      return !evalB(b.e, env)
    case 'and':
      return evalB(b.a, env) && evalB(b.b, env)
    case 'or':
      return evalB(b.a, env) || evalB(b.b, env)
    case 'cmp': {
      const a = evalExpr(b.a, env)
      const c = evalExpr(b.b, env)
      switch (b.op) {
        case '==':
          return a === c
        case '!=':
          return a !== c
        case '<=':
          return a <= c
        case '>=':
          return a >= c
        case '<':
          return a < c
        case '>':
          return a > c
      }
    }
  }
}
