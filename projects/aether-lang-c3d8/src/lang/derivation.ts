// Aether — type-derivation tree
//
// Reconstructs the Hindley–Milner *proof tree* from the per-node types the
// inferencer already records. Each node of the tree is one application of a
// typing rule (Var, Abs, App, Let, If, …): its conclusion is `expr : τ` with
// the inferred type, and its premises are the derivations of the sub-expressions
// the rule depends on. This turns "here's the final scheme" into "here's *why*",
// which is exactly what the backlog asked for.

import type { Expr } from './ast.ts'
import { children } from './ast.ts'
import type { Type } from './types.ts'
import { typeToString } from './types.ts'

export interface DerivNode {
  /** name of the typing rule applied at this step */
  rule: string
  /** compact source of the expression being typed */
  exprText: string
  /** the inferred type of the expression */
  type: string
  /** sub-derivations this rule depends on */
  premises: DerivNode[]
}

function ruleOf(e: Expr): string {
  switch (e.kind) {
    case 'int':
    case 'float':
    case 'bool':
    case 'str':
    case 'unit':
      return 'Lit'
    case 'var':
      return 'Var'
    case 'lambda':
      return 'Abs'
    case 'app':
      return 'App'
    case 'let':
      return e.recursive ? 'Let-rec' : 'Let'
    case 'letrec':
      return 'Let-rec-and'
    case 'if':
      return 'If'
    case 'binop':
      return `Op (${e.op})`
    case 'unop':
      return `Op (${e.op})`
    case 'list':
      return 'List'
    case 'tuple':
      return 'Tuple'
    case 'seq':
      return 'Seq'
    case 'match':
      return 'Match'
    case 'typedecl':
      return 'Type'
    case 'record':
      return 'Record'
    case 'field':
      return 'Proj'
    case 'recordUpdate':
      return 'Update'
    case 'classdecl':
      return 'Class'
    case 'instancedecl':
      return 'Instance'
  }
}

const MAX_LEN = 42

/** Render a node's own expression compactly, eliding deep structure with `…`. */
export function shortExpr(e: Expr, depth = 0): string {
  const text = render(e, depth)
  return text.length > MAX_LEN ? text.slice(0, MAX_LEN - 1) + '…' : text
}

function render(e: Expr, depth: number): string {
  if (depth > 3) return '…'
  const d = depth + 1
  switch (e.kind) {
    case 'int':
      return String(e.value)
    case 'float':
      return String(e.value)
    case 'bool':
      return String(e.value)
    case 'str':
      return JSON.stringify(e.value)
    case 'unit':
      return '()'
    case 'var':
      return e.name
    case 'lambda':
      return `fn ${e.param} -> ${render(e.body, d)}`
    case 'app':
      return `${render(e.fn, d)} ${paren(e.arg, d)}`
    case 'let':
      return `let ${e.recursive ? 'rec ' : ''}${e.name} = … in …`
    case 'letrec':
      return `let rec ${e.bindings.map((b) => b.name).join(' and ')} = … in …`
    case 'if':
      return `if ${render(e.cond, d)} then … else …`
    case 'binop':
      return `${paren(e.left, d)} ${e.op} ${paren(e.right, d)}`
    case 'unop':
      return `${e.op}${paren(e.operand, d)}`
    case 'list':
      return `[${e.elements.map((x) => render(x, d)).join(', ')}]`
    case 'tuple':
      return `(${e.elements.map((x) => render(x, d)).join(', ')})`
    case 'seq':
      return `${render(e.first, d)} ; …`
    case 'match':
      return `match ${render(e.scrutinee, d)} with …`
    case 'typedecl':
      return `type ${e.name} … in …`
    case 'record':
      return `{ ${e.fields.map((f) => `${f.label} = …`).join(', ')} }`
    case 'field':
      return `${paren(e.record, d)}.${e.label}`
    case 'recordUpdate':
      return `{ ${render(e.record, d)} | … }`
    case 'classdecl':
      return `class ${e.name} ${e.param} where … in …`
    case 'instancedecl':
      return `instance ${e.cls} … where … in …`
  }
}

// parenthesise compound sub-expressions when they appear as operands/arguments
function paren(e: Expr, depth: number): string {
  const atom =
    e.kind === 'int' ||
    e.kind === 'float' ||
    e.kind === 'bool' ||
    e.kind === 'str' ||
    e.kind === 'unit' ||
    e.kind === 'var' ||
    e.kind === 'list' ||
    e.kind === 'tuple' ||
    e.kind === 'record' ||
    e.kind === 'field'
  const s = render(e, depth)
  return atom ? s : `(${s})`
}

/** Build the derivation tree for `root`, using the inferencer's per-node types. */
export function buildDerivation(root: Expr, nodeTypes: Map<Expr, Type>): DerivNode {
  const build = (e: Expr): DerivNode => {
    const t = nodeTypes.get(e)
    const premises = children(e)
      .filter((c) => nodeTypes.has(c))
      .map(build)
    return {
      rule: ruleOf(e),
      exprText: shortExpr(e),
      type: t ? typeToString(t) : '?',
      premises,
    }
  }
  return build(root)
}

/** Total number of inference steps (nodes) in a derivation. */
export function countSteps(d: DerivNode): number {
  return 1 + d.premises.reduce((n, p) => n + countSteps(p), 0)
}
