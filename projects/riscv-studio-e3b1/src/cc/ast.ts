// The abstract syntax tree for the C subset. Expression nodes carry an optional `cty`
// (their resolved C type) which the type checker fills in and codegen relies on. Each node
// keeps the source line for diagnostics.

import type { CType } from './ctype';

export interface Node {
  line: number;
}

// ---- Expressions ----------------------------------------------------------

export type Expr =
  | NumExpr
  | StrExpr
  | IdentExpr
  | CallExpr
  | UnaryExpr
  | BinaryExpr
  | LogicalExpr
  | AssignExpr
  | CondExpr
  | CommaExpr
  | MemberExpr
  | IndexExpr
  | CastExpr
  | SizeofExpr
  | VaArgExpr
  | VaCtlExpr;

export interface ExprBase extends Node {
  cty?: CType; // filled by sema
}

export interface NumExpr extends ExprBase {
  kind: 'num';
  value: number;
}
export interface StrExpr extends ExprBase {
  kind: 'str';
  value: string; // decoded bytes
  label?: string; // assigned during codegen
}
export interface IdentExpr extends ExprBase {
  kind: 'ident';
  name: string;
  sym?: Sym; // resolved by sema
}
export interface CallExpr extends ExprBase {
  kind: 'call';
  callee: Expr;
  args: Expr[];
}
export type UnaryOp =
  | 'neg'
  | 'pos'
  | 'not'
  | 'bnot'
  | 'deref'
  | 'addr'
  | 'preinc'
  | 'predec'
  | 'postinc'
  | 'postdec';
export interface UnaryExpr extends ExprBase {
  kind: 'unary';
  op: UnaryOp;
  operand: Expr;
}
export type BinOp =
  | '+'
  | '-'
  | '*'
  | '/'
  | '%'
  | '<<'
  | '>>'
  | '<'
  | '<='
  | '>'
  | '>='
  | '=='
  | '!='
  | '&'
  | '|'
  | '^';
export interface BinaryExpr extends ExprBase {
  kind: 'binary';
  op: BinOp;
  lhs: Expr;
  rhs: Expr;
}
export interface LogicalExpr extends ExprBase {
  kind: 'logical';
  op: '&&' | '||';
  lhs: Expr;
  rhs: Expr;
}
export interface AssignExpr extends ExprBase {
  kind: 'assign';
  op: BinOp | null; // null = plain '='; otherwise compound (a op= b)
  target: Expr;
  value: Expr;
}
export interface CondExpr extends ExprBase {
  kind: 'cond';
  cond: Expr;
  then: Expr;
  els: Expr;
}
export interface CommaExpr extends ExprBase {
  kind: 'comma';
  lhs: Expr;
  rhs: Expr;
}
export interface MemberExpr extends ExprBase {
  kind: 'member';
  obj: Expr;
  name: string;
  arrow: boolean;
  offset?: number; // filled by sema
}
export interface IndexExpr extends ExprBase {
  kind: 'index';
  base: Expr;
  index: Expr;
}
export interface CastExpr extends ExprBase {
  kind: 'cast';
  toType: CType;
  operand: Expr;
}
export interface SizeofExpr extends ExprBase {
  kind: 'sizeof';
  argExpr?: Expr; // sizeof expr
  argType?: CType; // sizeof(type)
}
export interface VaArgExpr extends ExprBase {
  kind: 'va_arg';
  ap: Expr;
  argType: CType;
}
export interface VaCtlExpr extends ExprBase {
  kind: 'vactl';
  which: 'start' | 'end';
  ap: Expr;
  last?: Expr;
}

// ---- Statements -----------------------------------------------------------

export type Stmt =
  | ExprStmt
  | DeclStmt
  | BlockStmt
  | IfStmt
  | WhileStmt
  | DoWhileStmt
  | ForStmt
  | ReturnStmt
  | BreakStmt
  | ContinueStmt
  | EmptyStmt;

export interface ExprStmt extends Node {
  kind: 'expr';
  expr: Expr;
}
export interface DeclStmt extends Node {
  kind: 'decl';
  decls: VarDecl[];
}
export interface BlockStmt extends Node {
  kind: 'block';
  stmts: Stmt[];
}
export interface IfStmt extends Node {
  kind: 'if';
  cond: Expr;
  then: Stmt;
  els?: Stmt;
}
export interface WhileStmt extends Node {
  kind: 'while';
  cond: Expr;
  body: Stmt;
}
export interface DoWhileStmt extends Node {
  kind: 'dowhile';
  body: Stmt;
  cond: Expr;
}
export interface ForStmt extends Node {
  kind: 'for';
  init?: Stmt; // decl or expr statement
  cond?: Expr;
  step?: Expr;
  body: Stmt;
}
export interface ReturnStmt extends Node {
  kind: 'return';
  expr?: Expr;
}
export interface BreakStmt extends Node {
  kind: 'break';
}
export interface ContinueStmt extends Node {
  kind: 'continue';
}
export interface EmptyStmt extends Node {
  kind: 'empty';
}

// ---- Declarations & symbols ----------------------------------------------

export type Storage = 'global' | 'local' | 'param';

export interface Sym {
  name: string;
  type: CType;
  storage: Storage;
  offset: number; // local/param: byte offset from frame pointer (negative); global: 0
  label?: string; // globals: data label; functions: text label
  isFunc?: boolean;
  defined?: boolean;
}

export interface VarDecl extends Node {
  kind: 'var';
  name: string;
  type: CType;
  init?: Expr;
  sym?: Sym;
}

export interface FuncDecl extends Node {
  kind: 'func';
  name: string;
  retType: CType;
  params: VarDecl[];
  variadic: boolean;
  body?: BlockStmt;
  isStatic: boolean;
  // filled by sema/codegen:
  locals: Sym[];
  frameSize: number;
  vaBase?: number; // variadic save-area base offset from fp (a0 slot); set if variadic
  sym?: Sym;
}

export interface Program {
  funcs: FuncDecl[];
  globals: VarDecl[];
}
