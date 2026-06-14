import type { Span } from './diagnostics';

// The abstract syntax tree for Strata. The type checker annotates expression
// nodes with their resolved `ty` in place; everything else is produced by the
// parser. Arrays live in linear memory and are typed `int[]` / `float[]`.

export type Ty =
  | { kind: 'int' }
  | { kind: 'float' }
  | { kind: 'bool' }
  | { kind: 'void' }
  | { kind: 'array'; elem: ScalarTy };

export type ScalarTy = { kind: 'int' } | { kind: 'float' } | { kind: 'bool' };

export const T_INT: Ty = { kind: 'int' };
export const T_FLOAT: Ty = { kind: 'float' };
export const T_BOOL: Ty = { kind: 'bool' };
export const T_VOID: Ty = { kind: 'void' };

export function tyEqual(a: Ty, b: Ty): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'array' && b.kind === 'array') return a.elem.kind === b.elem.kind;
  return true;
}

export function tyName(t: Ty): string {
  if (t.kind === 'array') return `${t.elem.kind}[]`;
  return t.kind;
}

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

export type UnaryOp = '-' | '!' | '~' | '+';
export type BinaryOp =
  | '+'
  | '-'
  | '*'
  | '/'
  | '%'
  | '=='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | '&&'
  | '||'
  | '&'
  | '|'
  | '^'
  | '<<'
  | '>>';

export interface ExprBase {
  span: Span;
  ty?: Ty; // filled in by the type checker
}

export type Expr =
  | (ExprBase & { node: 'int'; value: number })
  | (ExprBase & { node: 'float'; value: number })
  | (ExprBase & { node: 'bool'; value: boolean })
  | (ExprBase & { node: 'ident'; name: string })
  | (ExprBase & { node: 'unary'; op: UnaryOp; operand: Expr })
  | (ExprBase & { node: 'binary'; op: BinaryOp; left: Expr; right: Expr })
  | (ExprBase & { node: 'call'; callee: string; args: Expr[] })
  | (ExprBase & { node: 'index'; target: Expr; index: Expr });

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

export interface Block {
  stmts: Stmt[];
  span: Span;
}

export type Stmt =
  | { node: 'let'; name: string; declTy: Ty | null; init: Expr; span: Span; resolvedTy?: Ty }
  | { node: 'assign'; name: string; value: Expr; span: Span }
  | { node: 'index-assign'; target: Expr; index: Expr; value: Expr; span: Span }
  | { node: 'expr'; expr: Expr; span: Span }
  | { node: 'if'; cond: Expr; then: Block; otherwise: Block | null; span: Span }
  | { node: 'while'; cond: Expr; body: Block; span: Span }
  | {
      node: 'for';
      init: Stmt | null;
      cond: Expr | null;
      update: Stmt | null;
      body: Block;
      span: Span;
    }
  | { node: 'return'; value: Expr | null; span: Span }
  | { node: 'break'; span: Span }
  | { node: 'continue'; span: Span }
  | { node: 'block'; block: Block; span: Span };

// ---------------------------------------------------------------------------
// Top-level declarations
// ---------------------------------------------------------------------------

export interface Param {
  name: string;
  ty: Ty;
  span: Span;
}

export interface FnDecl {
  kind: 'fn';
  name: string;
  params: Param[];
  retTy: Ty;
  body: Block;
  span: Span;
}

export interface GlobalDecl {
  kind: 'global';
  name: string;
  declTy: Ty | null;
  init: Expr;
  span: Span;
  resolvedTy?: Ty;
}

export type Decl = FnDecl | GlobalDecl;

export interface Program {
  decls: Decl[];
}
