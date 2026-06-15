import type { Span } from './diagnostics';

// The abstract syntax tree for Strata. The type checker annotates expression
// nodes with their resolved `ty` in place; everything else is produced by the
// parser. Arrays live in linear memory and are typed `int[]` / `float[]`.

export type Ty =
  | { kind: 'int' }
  | { kind: 'long' }
  | { kind: 'float' }
  | { kind: 'bool' }
  | { kind: 'str' }
  | { kind: 'void' }
  | { kind: 'array'; elem: ScalarTy }
  // An aggregate value, referenced by an i32 handle into linear memory. The
  // `name` keys into the program's struct table; the interpreter holds the same
  // value as a by-reference object, so the two share mutation semantics.
  | { kind: 'struct'; name: string }
  // The type of the `null` literal: a struct handle that points nowhere. It
  // unifies with (is assignable to) any struct type and only ever compares with
  // `==`/`!=`. Lowers to the i32 constant 0.
  | { kind: 'null' };

// Array element types. `str` elements are i32 pointers into linear memory (just
// like a bare `str`), so the wasm backend treats `str[]` exactly like an i32
// array; only the type system and the interpreter track the element kind.
export type ScalarTy = { kind: 'int' } | { kind: 'long' } | { kind: 'float' } | { kind: 'bool' } | { kind: 'str' };

export const T_INT: Ty = { kind: 'int' };
export const T_LONG: Ty = { kind: 'long' };
export const T_FLOAT: Ty = { kind: 'float' };
export const T_BOOL: Ty = { kind: 'bool' };
export const T_STR: Ty = { kind: 'str' };
export const T_VOID: Ty = { kind: 'void' };
export const T_NULL: Ty = { kind: 'null' };

export function tyEqual(a: Ty, b: Ty): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'array' && b.kind === 'array') return a.elem.kind === b.elem.kind;
  if (a.kind === 'struct' && b.kind === 'struct') return a.name === b.name;
  return true;
}

export function tyName(t: Ty): string {
  if (t.kind === 'array') return `${t.elem.kind}[]`;
  if (t.kind === 'struct') return t.name;
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
  | (ExprBase & { node: 'long'; value: bigint })
  | (ExprBase & { node: 'float'; value: number })
  | (ExprBase & { node: 'bool'; value: boolean })
  | (ExprBase & { node: 'string'; value: string })
  | (ExprBase & { node: 'ident'; name: string })
  | (ExprBase & { node: 'unary'; op: UnaryOp; operand: Expr })
  | (ExprBase & { node: 'binary'; op: BinaryOp; left: Expr; right: Expr })
  | (ExprBase & { node: 'call'; callee: string; args: Expr[] })
  | (ExprBase & { node: 'index'; target: Expr; index: Expr })
  // `target.field` — read a struct field. The checker resolves `field` to its
  // declared type; the builder lowers it to a load at the field's byte offset.
  | (ExprBase & { node: 'member'; target: Expr; field: string })
  // The null struct handle (lowers to the i32 constant 0).
  | (ExprBase & { node: 'null' })
  | (ExprBase & { node: 'ternary'; cond: Expr; then: Expr; otherwise: Expr });

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

export interface Block {
  stmts: Stmt[];
  span: Span;
}

// A `switch` case. `values` are the constant int label expressions; the type
// checker folds them to `nums` (also used to reject duplicate labels). `body`
// runs with no fallthrough — control leaves the switch after it.
export interface SwitchCase {
  values: Expr[];
  body: Block;
  span: Span;
  nums?: number[];
}

export type Stmt =
  | { node: 'let'; name: string; declTy: Ty | null; init: Expr; span: Span; resolvedTy?: Ty }
  | { node: 'assign'; name: string; value: Expr; span: Span }
  | { node: 'index-assign'; target: Expr; index: Expr; value: Expr; span: Span }
  // `target.field = value` — store into a struct field.
  | { node: 'member-assign'; target: Expr; field: string; value: Expr; span: Span }
  | { node: 'expr'; expr: Expr; span: Span }
  | { node: 'if'; cond: Expr; then: Block; otherwise: Block | null; span: Span }
  | { node: 'while'; cond: Expr; body: Block; span: Span }
  | { node: 'switch'; disc: Expr; cases: SwitchCase[]; default: Block | null; span: Span }
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

export interface StructField {
  name: string;
  ty: Ty;
  span: Span;
}

export interface StructDecl {
  kind: 'struct';
  name: string;
  fields: StructField[];
  span: Span;
}

export type Decl = FnDecl | GlobalDecl | StructDecl;

export interface Program {
  decls: Decl[];
}
