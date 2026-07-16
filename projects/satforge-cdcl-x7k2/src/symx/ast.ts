// The abstract syntax of "Mini" — the tiny imperative language the Symbolic
// Studio verifies. It is deliberately minimal: mathematical integer variables
// (unbounded `bigint`, no wraparound), `if` / `while` / `assume` / `assert`,
// and *linear* integer expressions. Linearity is what keeps every path
// condition inside the quantifier-free integer-linear (QF_LIA) fragment that
// the Omega test decides exactly, so the symbolic executor never has to
// approximate.
//
// Two evaluators walk this same tree:
//   • the symbolic executor (symexec.ts) maps expressions to `Lin` affine forms
//     over the free input variables and discharges branch conditions to Omega;
//   • the concrete interpreter (interp.ts) maps them to `bigint`s and runs the
//     program for real — the independent oracle every symbolic verdict answers to.

/** An arithmetic expression. Multiplication must keep at least one side a
 *  constant (enforced at symbolic-evaluation time) so forms stay linear. */
export type Expr =
  | { kind: 'num'; value: bigint }
  | { kind: 'var'; name: string }
  | { kind: 'neg'; e: Expr }
  | { kind: 'bin'; op: '+' | '-' | '*'; a: Expr; b: Expr }

export type RelOp = '==' | '!=' | '<=' | '>=' | '<' | '>'

/** A Boolean condition — comparisons combined with ¬ / ∧ / ∨. */
export type BExpr =
  | { kind: 'blit'; value: boolean }
  | { kind: 'not'; e: BExpr }
  | { kind: 'and'; a: BExpr; b: BExpr }
  | { kind: 'or'; a: BExpr; b: BExpr }
  | { kind: 'cmp'; op: RelOp; a: Expr; b: Expr }

export type Stmt =
  | { kind: 'input'; name: string }
  | { kind: 'assign'; name: string; e: Expr }
  | { kind: 'if'; cond: BExpr; then: Stmt[]; else: Stmt[] }
  | { kind: 'while'; id: number; cond: BExpr; body: Stmt[] }
  | { kind: 'assume'; cond: BExpr; text: string }
  | { kind: 'assert'; cond: BExpr; text: string }

export interface Program {
  /** Declared symbolic inputs, in source order — these are the free variables. */
  inputs: string[]
  body: Stmt[]
}

/** Pretty-print an expression (for traces / counterexample rendering). */
export function exprToString(e: Expr): string {
  switch (e.kind) {
    case 'num':
      return e.value.toString()
    case 'var':
      return e.name
    case 'neg':
      return `-${atom(e.e)}`
    case 'bin':
      return `${side(e.op, e.a)} ${e.op} ${side(e.op, e.b)}`
  }
}

function atom(e: Expr): string {
  return e.kind === 'bin' ? `(${exprToString(e)})` : exprToString(e)
}

function side(op: '+' | '-' | '*', e: Expr): string {
  // Parenthesize a lower-precedence child under `*`.
  if (op === '*' && e.kind === 'bin' && (e.op === '+' || e.op === '-')) return `(${exprToString(e)})`
  return exprToString(e)
}

export function bexprToString(b: BExpr): string {
  switch (b.kind) {
    case 'blit':
      return b.value ? 'true' : 'false'
    case 'not':
      return `!${batom(b.e)}`
    case 'and':
      return `${batom(b.a)} && ${batom(b.b)}`
    case 'or':
      return `${batom(b.a)} || ${batom(b.b)}`
    case 'cmp':
      return `${exprToString(b.a)} ${b.op} ${exprToString(b.b)}`
  }
}

function batom(b: BExpr): string {
  return b.kind === 'and' || b.kind === 'or' ? `(${bexprToString(b)})` : bexprToString(b)
}
