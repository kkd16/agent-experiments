// A recursive-descent parser for the C subset. Declaration specifiers and declarators are
// parsed in the classic C way (pointers wrap the base, then array/function suffixes wrap
// that), expressions via precedence climbing. Struct types are interned in a tag table so
// member layout is computed once. We don't support typedef, so a statement is a declaration
// iff it starts with a type keyword — no lexer hack needed.

import { lex, CError } from './lexer';
import type { Tok } from './token';
import {
  tVoid,
  tInt,
  tChar,
  pointerTo,
  arrayOf,
  funcType,
  structType,
  layoutStruct,
  decay,
} from './ctype';
import type { CType } from './ctype';
import type {
  Program,
  FuncDecl,
  VarDecl,
  Stmt,
  Expr,
  BlockStmt,
  BinOp,
  UnaryOp,
} from './ast';

// va_list is a pointer that va_arg walks one 4-byte slot at a time.
const tVaList = pointerTo(tInt);

const BIN_PREC: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '|': 3,
  '^': 4,
  '&': 5,
  '==': 6,
  '!=': 6,
  '<': 7,
  '<=': 7,
  '>': 7,
  '>=': 7,
  '<<': 8,
  '>>': 8,
  '+': 9,
  '-': 9,
  '*': 10,
  '/': 10,
  '%': 10,
};

const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=']);

export class Parser {
  private toks: Tok[];
  private pos = 0;
  private structs = new Map<string, CType>();
  private globals: VarDecl[] = [];
  private funcs: FuncDecl[] = [];

  constructor(src: string) {
    this.toks = lex(src);
  }

  static parse(src: string): Program {
    return new Parser(src).parseProgram();
  }

  // ---- token helpers ----
  private peek(k = 0): Tok {
    return this.toks[Math.min(this.pos + k, this.toks.length - 1)];
  }
  private next(): Tok {
    return this.toks[this.pos++];
  }
  private at(v: string): boolean {
    const t = this.peek();
    return (t.kind === 'punct' || t.kind === 'keyword') && t.value === v;
  }
  private accept(v: string): boolean {
    if (this.at(v)) {
      this.pos++;
      return true;
    }
    return false;
  }
  private expect(v: string): Tok {
    if (!this.at(v)) this.err(`expected '${v}' but got '${this.peek().value || this.peek().kind}'`);
    return this.next();
  }
  private err(msg: string): never {
    const t = this.peek();
    throw new CError(msg, t.line, t.col);
  }
  private line(): number {
    return this.peek().line;
  }

  // ---- program ----
  parseProgram(): Program {
    while (this.peek().kind !== 'eof') {
      this.parseTopLevel();
    }
    return { funcs: this.funcs, globals: this.globals };
  }

  private isTypeStart(): boolean {
    const t = this.peek();
    if (t.kind !== 'keyword') return false;
    return ['int', 'char', 'void', 'struct', 'const', 'unsigned', 'signed', 'static', 'va_list'].includes(
      t.value,
    );
  }

  private parseTopLevel(): void {
    const line = this.line();
    const { base, isStatic } = this.parseDeclSpec();

    // A bare `struct Foo { ... };` declaration just defines the type.
    if (this.accept(';')) return;

    // First declarator
    let { name, type } = this.parseDeclarator(base);

    if (type.kind === 'func') {
      // function declaration or definition
      const params = this.lastParams;
      if (this.at('{')) {
        const fn = this.parseFuncBody(name, type, params, isStatic, line);
        this.funcs.push(fn);
        return;
      }
      // prototype only — record a func declaration with no body
      this.expect(';');
      this.funcs.push({
        kind: 'func',
        line,
        name,
        retType: type.base!,
        params,
        variadic: !!type.variadic,
        isStatic,
        locals: [],
        frameSize: 0,
      });
      return;
    }

    // global variable(s)
    for (;;) {
      let init: Expr | undefined;
      if (this.accept('=')) init = this.parseAssign();
      this.globals.push({ kind: 'var', line, name, type, init });
      if (this.accept(',')) {
        ({ name, type } = this.parseDeclarator(base));
        continue;
      }
      this.expect(';');
      break;
    }
  }

  private parseFuncBody(
    name: string,
    type: CType,
    params: VarDecl[],
    isStatic: boolean,
    line: number,
  ): FuncDecl {
    const body = this.parseBlock();
    return {
      kind: 'func',
      line,
      name,
      retType: type.base!,
      params,
      variadic: !!type.variadic,
      body,
      isStatic,
      locals: [],
      frameSize: 0,
    };
  }

  // ---- declaration specifiers ----
  private parseDeclSpec(): { base: CType; isStatic: boolean } {
    let base: CType | null = null;
    let isStatic = false;
    let sawUnsigned = false;
    for (;;) {
      const t = this.peek();
      if (t.kind !== 'keyword') break;
      if (t.value === 'const' || t.value === 'signed') {
        this.next();
        continue;
      }
      if (t.value === 'static') {
        this.next();
        isStatic = true;
        continue;
      }
      if (t.value === 'unsigned') {
        this.next();
        sawUnsigned = true;
        base = tInt;
        continue;
      }
      if (t.value === 'int') {
        this.next();
        base = tInt;
        continue;
      }
      if (t.value === 'char') {
        this.next();
        base = tChar;
        continue;
      }
      if (t.value === 'void') {
        this.next();
        base = tVoid;
        continue;
      }
      if (t.value === 'va_list') {
        this.next();
        base = tVaList;
        continue;
      }
      if (t.value === 'struct') {
        base = this.parseStructSpec();
        continue;
      }
      break;
    }
    void sawUnsigned; // we have a single integer width; unsigned only affects nothing yet
    if (!base) this.err('expected a type');
    return { base, isStatic };
  }

  private parseStructSpec(): CType {
    this.expect('struct');
    let tag: string | undefined;
    if (this.peek().kind === 'ident') tag = this.next().value;

    let st: CType;
    if (tag) {
      st = this.structs.get(tag) ?? structType(tag);
      this.structs.set(tag, st);
    } else {
      st = structType(undefined);
    }

    if (this.accept('{')) {
      if (st.complete) this.err(`redefinition of struct '${tag ?? '<anon>'}'`);
      const members: { name: string; type: CType }[] = [];
      while (!this.at('}')) {
        const { base } = this.parseDeclSpec();
        for (;;) {
          const { name, type } = this.parseDeclarator(base);
          members.push({ name, type });
          if (this.accept(',')) continue;
          this.expect(';');
          break;
        }
      }
      this.expect('}');
      layoutStruct(st, members);
    }
    return st;
  }

  // ---- declarators ----
  private lastParams: VarDecl[] = [];

  private parseDeclarator(base: CType): { name: string; type: CType } {
    let t = base;
    while (this.accept('*')) {
      // swallow pointer qualifiers
      while (this.at('const') || this.at('signed') || this.at('unsigned')) this.next();
      t = pointerTo(t);
    }
    // Parenthesized declarator, e.g. a function pointer `int (*f)(int)`. We parse the inner
    // declarator twice: once to skip past it and reach the suffix, then for real once the
    // suffix (the function/array part after `)`) has been folded into the base type.
    if (this.at('(')) {
      const start = this.pos;
      this.expect('(');
      this.parseDeclarator(tVoid); // throwaway, just to advance to ')'
      this.expect(')');
      t = this.parseTypeSuffix(t);
      const after = this.pos;
      this.pos = start;
      this.expect('(');
      const inner = this.parseDeclarator(t);
      this.expect(')');
      this.pos = after;
      return inner;
    }
    if (this.peek().kind !== 'ident') this.err('expected a name in declarator');
    const name = this.next().value;
    t = this.parseTypeSuffix(t);
    return { name, type: t };
  }

  // Abstract declarator (no name) — for casts, sizeof(type), and param types.
  private parseAbstractDeclarator(base: CType): CType {
    let t = base;
    while (this.accept('*')) {
      while (this.at('const') || this.at('signed') || this.at('unsigned')) this.next();
      t = pointerTo(t);
    }
    // optional array suffixes
    return this.parseTypeSuffix(t);
  }

  private parseTypeSuffix(base: CType): CType {
    if (this.at('(')) {
      const { params, variadic } = this.parseParamList();
      this.lastParams = params;
      return funcType(base, params.map((p) => decay(p.type)), variadic);
    }
    if (this.accept('[')) {
      let len = -1;
      if (!this.at(']')) {
        len = this.parseConstInt();
      }
      this.expect(']');
      const inner = this.parseTypeSuffix(base);
      return arrayOf(inner, len < 0 ? 0 : len);
    }
    return base;
  }

  private parseParamList(): { params: VarDecl[]; variadic: boolean } {
    this.expect('(');
    const params: VarDecl[] = [];
    let variadic = false;
    if (this.at(')')) {
      this.expect(')');
      return { params, variadic };
    }
    // `(void)` means no params
    if (this.at('void') && this.peek(1).kind === 'punct' && this.peek(1).value === ')') {
      this.next();
      this.expect(')');
      return { params, variadic };
    }
    for (;;) {
      if (this.accept('...')) {
        variadic = true;
        break;
      }
      const line = this.line();
      const { base } = this.parseDeclSpec();
      // parameters may be named or abstract; we expect names for definitions
      let name = '';
      let type: CType;
      if (this.peek().kind === 'ident' || this.at('*') || this.at('(')) {
        const d = this.parseDeclarator(base);
        name = d.name;
        type = d.type;
      } else {
        type = this.parseAbstractDeclarator(base);
      }
      params.push({ kind: 'var', line, name, type: decay(type) });
      if (this.accept(',')) continue;
      break;
    }
    this.expect(')');
    return { params, variadic };
  }

  private parseConstInt(): number {
    // very small constant-expression evaluator for array sizes
    const v = this.parseAssign();
    const n = foldConst(v);
    if (n === null) this.err('array size must be a constant integer');
    return n;
  }

  // ---- statements ----
  private parseBlock(): BlockStmt {
    const line = this.line();
    this.expect('{');
    const stmts: Stmt[] = [];
    while (!this.at('}') && this.peek().kind !== 'eof') {
      stmts.push(this.parseStmt());
    }
    this.expect('}');
    return { kind: 'block', line, stmts };
  }

  private parseStmt(): Stmt {
    const line = this.line();
    if (this.at('{')) return this.parseBlock();
    if (this.accept(';')) return { kind: 'empty', line };

    if (this.isTypeStart()) {
      return this.parseLocalDecl();
    }

    if (this.accept('if')) {
      this.expect('(');
      const cond = this.parseExpr();
      this.expect(')');
      const then = this.parseStmt();
      let els: Stmt | undefined;
      if (this.accept('else')) els = this.parseStmt();
      return { kind: 'if', line, cond, then, els };
    }
    if (this.accept('while')) {
      this.expect('(');
      const cond = this.parseExpr();
      this.expect(')');
      const body = this.parseStmt();
      return { kind: 'while', line, cond, body };
    }
    if (this.accept('do')) {
      const body = this.parseStmt();
      this.expect('while');
      this.expect('(');
      const cond = this.parseExpr();
      this.expect(')');
      this.expect(';');
      return { kind: 'dowhile', line, body, cond };
    }
    if (this.accept('for')) {
      this.expect('(');
      let init: Stmt | undefined;
      if (this.at(';')) {
        this.expect(';');
      } else if (this.isTypeStart()) {
        init = this.parseLocalDecl();
      } else {
        init = { kind: 'expr', line, expr: this.parseExpr() };
        this.expect(';');
      }
      let cond: Expr | undefined;
      if (!this.at(';')) cond = this.parseExpr();
      this.expect(';');
      let step: Expr | undefined;
      if (!this.at(')')) step = this.parseExpr();
      this.expect(')');
      const body = this.parseStmt();
      return { kind: 'for', line, init, cond, step, body };
    }
    if (this.accept('return')) {
      let expr: Expr | undefined;
      if (!this.at(';')) expr = this.parseExpr();
      this.expect(';');
      return { kind: 'return', line, expr };
    }
    if (this.accept('break')) {
      this.expect(';');
      return { kind: 'break', line };
    }
    if (this.accept('continue')) {
      this.expect(';');
      return { kind: 'continue', line };
    }

    // expression statement
    const expr = this.parseExpr();
    this.expect(';');
    return { kind: 'expr', line, expr };
  }

  private parseLocalDecl(): Stmt {
    const line = this.line();
    const { base } = this.parseDeclSpec();
    const decls: VarDecl[] = [];
    if (this.accept(';')) return { kind: 'decl', line, decls };
    for (;;) {
      const { name, type } = this.parseDeclarator(base);
      let init: Expr | undefined;
      if (this.accept('=')) init = this.parseAssign();
      decls.push({ kind: 'var', line, name, type, init });
      if (this.accept(',')) continue;
      this.expect(';');
      break;
    }
    return { kind: 'decl', line, decls };
  }

  // ---- expressions ----
  parseExpr(): Expr {
    let e = this.parseAssign();
    while (this.at(',')) {
      const line = this.line();
      this.next();
      const rhs = this.parseAssign();
      e = { kind: 'comma', line, lhs: e, rhs };
    }
    return e;
  }

  private parseAssign(): Expr {
    const lhs = this.parseTernary();
    const t = this.peek();
    if (t.kind === 'punct' && ASSIGN_OPS.has(t.value)) {
      this.next();
      const value = this.parseAssign();
      const op = t.value === '=' ? null : (t.value.slice(0, -1) as BinOp);
      return { kind: 'assign', line: t.line, op, target: lhs, value };
    }
    return lhs;
  }

  private parseTernary(): Expr {
    const cond = this.parseBinary(1);
    if (this.at('?')) {
      const line = this.line();
      this.next();
      const then = this.parseExpr();
      this.expect(':');
      const els = this.parseAssign();
      return { kind: 'cond', line, cond, then, els };
    }
    return cond;
  }

  private parseBinary(minPrec: number): Expr {
    let lhs = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (t.kind !== 'punct') break;
      const prec = BIN_PREC[t.value];
      if (prec === undefined || prec < minPrec) break;
      this.next();
      const rhs = this.parseBinary(prec + 1);
      if (t.value === '&&' || t.value === '||') {
        lhs = { kind: 'logical', line: t.line, op: t.value, lhs, rhs };
      } else {
        lhs = { kind: 'binary', line: t.line, op: t.value as BinOp, lhs, rhs };
      }
    }
    return lhs;
  }

  private parseUnary(): Expr {
    const t = this.peek();
    const line = t.line;
    const prefix: Record<string, UnaryOp> = {
      '-': 'neg',
      '+': 'pos',
      '!': 'not',
      '~': 'bnot',
      '*': 'deref',
      '&': 'addr',
    };
    if (t.kind === 'punct' && t.value in prefix) {
      this.next();
      const operand = this.parseUnary();
      return { kind: 'unary', line, op: prefix[t.value], operand };
    }
    if (this.at('++') || this.at('--')) {
      const op = this.next().value === '++' ? 'preinc' : 'predec';
      const operand = this.parseUnary();
      return { kind: 'unary', line, op, operand };
    }
    if (this.at('sizeof')) {
      this.next();
      // sizeof(type) vs sizeof expr
      if (this.at('(') && this.peekIsTypeAfterParen()) {
        this.expect('(');
        const { base } = this.parseDeclSpec();
        const ty = this.parseAbstractDeclarator(base);
        this.expect(')');
        return { kind: 'sizeof', line, argType: ty };
      }
      const operand = this.parseUnary();
      return { kind: 'sizeof', line, argExpr: operand };
    }
    // cast: ( type ) unary
    if (this.at('(') && this.peekIsTypeAfterParen()) {
      this.expect('(');
      const { base } = this.parseDeclSpec();
      const ty = this.parseAbstractDeclarator(base);
      this.expect(')');
      const operand = this.parseUnary();
      return { kind: 'cast', line, toType: ty, operand };
    }
    return this.parsePostfix();
  }

  private peekIsTypeAfterParen(): boolean {
    // we are positioned at '(' — is the next token a type keyword?
    const n = this.peek(1);
    if (n.kind !== 'keyword') return false;
    return ['int', 'char', 'void', 'struct', 'const', 'unsigned', 'signed', 'va_list'].includes(
      n.value,
    );
  }

  private parsePostfix(): Expr {
    let e = this.parsePrimary();
    for (;;) {
      const t = this.peek();
      if (this.at('(')) {
        this.next();
        const args: Expr[] = [];
        if (!this.at(')')) {
          for (;;) {
            args.push(this.parseAssign());
            if (this.accept(',')) continue;
            break;
          }
        }
        this.expect(')');
        e = { kind: 'call', line: t.line, callee: e, args };
      } else if (this.accept('[')) {
        const index = this.parseExpr();
        this.expect(']');
        e = { kind: 'index', line: t.line, base: e, index };
      } else if (this.accept('.')) {
        const name = this.expectIdent();
        e = { kind: 'member', line: t.line, obj: e, name, arrow: false };
      } else if (this.accept('->')) {
        const name = this.expectIdent();
        e = { kind: 'member', line: t.line, obj: e, name, arrow: true };
      } else if (this.at('++') || this.at('--')) {
        const op = this.next().value === '++' ? 'postinc' : 'postdec';
        e = { kind: 'unary', line: t.line, op, operand: e };
      } else {
        break;
      }
    }
    return e;
  }

  private expectIdent(): string {
    if (this.peek().kind !== 'ident') this.err('expected an identifier');
    return this.next().value;
  }

  private parsePrimary(): Expr {
    const t = this.peek();
    if (t.kind === 'num' || t.kind === 'char') {
      this.next();
      return { kind: 'num', line: t.line, value: t.num! };
    }
    if (t.kind === 'str') {
      this.next();
      return { kind: 'str', line: t.line, value: t.str! };
    }
    if (this.at('(')) {
      this.next();
      const e = this.parseExpr();
      this.expect(')');
      return e;
    }
    if (this.at('va_arg')) {
      this.next();
      this.expect('(');
      const ap = this.parseAssign();
      this.expect(',');
      const { base } = this.parseDeclSpec();
      const ty = this.parseAbstractDeclarator(base);
      this.expect(')');
      return { kind: 'va_arg', line: t.line, ap, argType: ty };
    }
    if (this.at('va_start')) {
      this.next();
      this.expect('(');
      const ap = this.parseAssign();
      this.expect(',');
      const last = this.parseAssign();
      this.expect(')');
      return { kind: 'vactl', line: t.line, which: 'start', ap, last };
    }
    if (this.at('va_end')) {
      this.next();
      this.expect('(');
      const ap = this.parseAssign();
      this.expect(')');
      return { kind: 'vactl', line: t.line, which: 'end', ap };
    }
    if (t.kind === 'ident') {
      this.next();
      return { kind: 'ident', line: t.line, name: t.value };
    }
    this.err(`unexpected token '${t.value || t.kind}'`);
  }
}

// A tiny constant folder used for array sizes (and harmless elsewhere).
export function foldConst(e: Expr): number | null {
  switch (e.kind) {
    case 'num':
      return e.value | 0;
    case 'unary':
      if (e.op === 'neg') {
        const v = foldConst(e.operand);
        return v === null ? null : -v | 0;
      }
      if (e.op === 'bnot') {
        const v = foldConst(e.operand);
        return v === null ? null : ~v | 0;
      }
      if (e.op === 'pos') return foldConst(e.operand);
      return null;
    case 'binary': {
      const a = foldConst(e.lhs);
      const b = foldConst(e.rhs);
      if (a === null || b === null) return null;
      switch (e.op) {
        case '+':
          return (a + b) | 0;
        case '-':
          return (a - b) | 0;
        case '*':
          return Math.imul(a, b);
        case '/':
          return b === 0 ? null : (a / b) | 0;
        case '%':
          return b === 0 ? null : a % b | 0;
        case '<<':
          return a << (b & 31);
        case '>>':
          return a >> (b & 31);
        case '&':
          return a & b;
        case '|':
          return a | b;
        case '^':
          return a ^ b;
        default:
          return null;
      }
    }
    case 'sizeof':
      return e.argType ? e.argType.size : null;
    default:
      return null;
  }
}

export function parse(src: string): Program {
  return Parser.parse(src);
}
