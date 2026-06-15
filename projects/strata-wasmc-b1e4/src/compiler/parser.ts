import type { Token, TokenType } from './token';
import { tokenize } from './lexer';
import { CompileError } from './diagnostics';
import type { Span } from './diagnostics';
import type {
  BinaryOp,
  Block,
  Decl,
  Expr,
  FnDecl,
  GlobalDecl,
  Param,
  Program,
  Stmt,
  Ty,
  UnaryOp,
} from './ast';
import { T_BOOL, T_F32, T_FLOAT, T_INT, T_LONG, T_STR, T_VOID } from './ast';

// Fold a `long_lit` spelling (decimal or `0x` hex, with an `L`/`l` suffix) into a
// 64-bit-wrapped BigInt. The lexer guarantees the shape, so `BigInt()` cannot
// throw here; `asIntN(64, …)` matches the i64 wrap the backend and oracle use.
function foldLongLiteral(text: string): bigint {
  const body = text.replace(/[lL]$/, '');
  return BigInt.asIntN(64, BigInt(body));
}

// Binding powers for the Pratt expression parser. Higher binds tighter. Each
// entry is [left, right] so we can express left-associativity (left < right).
const BINDING: Partial<Record<TokenType, [number, number]>> = {
  '||': [1, 2],
  '&&': [3, 4],
  '|': [5, 6],
  '^': [7, 8],
  '&': [9, 10],
  '==': [11, 12],
  '!=': [11, 12],
  '<': [13, 14],
  '<=': [13, 14],
  '>': [13, 14],
  '>=': [13, 14],
  '<<': [15, 16],
  '>>': [15, 16],
  '+': [17, 18],
  '-': [17, 18],
  '*': [19, 20],
  '/': [19, 20],
  '%': [19, 20],
};

// The conditional operator binds looser than every binary operator above.
const TERNARY_BP = 0;

class Parser {
  private toks: Token[];
  private pos = 0;
  constructor(toks: Token[]) {
    this.toks = toks;
  }

  private peek(): Token {
    return this.toks[this.pos];
  }
  private next(): Token {
    return this.toks[this.pos++];
  }
  private check(t: TokenType): boolean {
    return this.peek().type === t;
  }
  private accept(t: TokenType): Token | null {
    if (this.check(t)) return this.next();
    return null;
  }
  private expect(t: TokenType): Token {
    if (this.check(t)) return this.next();
    const got = this.peek();
    throw new CompileError(`expected '${t}' but found '${got.text || got.type}'`, got.span, 'parse');
  }
  private spanFrom(start: Span): Span {
    const prev = this.toks[this.pos - 1] ?? this.peek();
    return { start: start.start, end: prev.span.end, line: start.line, col: start.col };
  }

  parseProgram(): Program {
    const decls: Decl[] = [];
    while (!this.check('eof')) {
      decls.push(this.parseDecl());
    }
    return { decls };
  }

  private parseDecl(): Decl {
    if (this.check('fn')) return this.parseFn();
    if (this.check('let')) return this.parseGlobal();
    if (this.check('struct')) return this.parseStruct();
    const t = this.peek();
    throw new CompileError(`expected a function, global, or struct declaration, found '${t.text || t.type}'`, t.span, 'parse');
  }

  // struct Name { f1: T1; f2: T2; … }  — fields are `name: type` separated by
  // semicolons (a trailing semicolon is allowed). Field types may be any value
  // type, including another struct (composition / recursive linked structures)
  // or an array; the checker validates that struct field types name real structs.
  private parseStruct(): import('./ast').StructDecl {
    const start = this.expect('struct').span;
    const nameTok = this.expect('ident');
    this.expect('{');
    const fields: import('./ast').StructField[] = [];
    while (!this.check('}') && !this.check('eof')) {
      const f = this.expect('ident');
      this.expect(':');
      const ty = this.parseType();
      fields.push({ name: f.text, ty, span: f.span });
      if (!this.accept(';')) break;
    }
    this.expect('}');
    return { kind: 'struct', name: nameTok.text, fields, span: this.spanFrom(start) };
  }

  private parseType(): Ty {
    const t = this.expect('ident');
    let base: Ty;
    switch (t.text) {
      case 'int':
        base = T_INT;
        break;
      case 'long':
        base = T_LONG;
        break;
      case 'float':
        base = T_FLOAT;
        break;
      case 'f32':
        base = T_F32;
        break;
      case 'bool':
        base = T_BOOL;
        break;
      case 'str':
        base = T_STR;
        break;
      case 'void':
        base = T_VOID;
        break;
      default:
        // A user type name refers to a `struct` (the checker, which knows every
        // declared struct, reports an unknown name with a precise error).
        base = { kind: 'struct', name: t.text };
        break;
    }
    if (this.accept('[')) {
      this.expect(']');
      if (base.kind === 'void') throw new CompileError('cannot have an array of void', t.span, 'parse');
      return { kind: 'array', elem: base as import('./ast').ElemTy };
    }
    return base;
  }

  private parseFn(): FnDecl {
    const start = this.expect('fn').span;
    const nameTok = this.expect('ident');
    this.expect('(');
    const params: Param[] = [];
    if (!this.check(')')) {
      do {
        const p = this.expect('ident');
        this.expect(':');
        const ty = this.parseType();
        params.push({ name: p.text, ty, span: p.span });
      } while (this.accept(','));
    }
    this.expect(')');
    let retTy: Ty = T_VOID;
    if (this.accept('->')) retTy = this.parseType();
    const body = this.parseBlock();
    return { kind: 'fn', name: nameTok.text, params, retTy, body, span: this.spanFrom(start) };
  }

  private parseGlobal(): GlobalDecl {
    const start = this.expect('let').span;
    const nameTok = this.expect('ident');
    let declTy: Ty | null = null;
    if (this.accept(':')) declTy = this.parseType();
    this.expect('=');
    const init = this.parseExpr();
    this.expect(';');
    return { kind: 'global', name: nameTok.text, declTy, init, span: this.spanFrom(start) };
  }

  private parseBlock(): Block {
    const start = this.expect('{').span;
    const stmts: Stmt[] = [];
    while (!this.check('}') && !this.check('eof')) {
      stmts.push(this.parseStmt());
    }
    this.expect('}');
    return { stmts, span: this.spanFrom(start) };
  }

  private parseStmt(): Stmt {
    const t = this.peek();
    switch (t.type) {
      case 'let':
        return this.parseLet();
      case 'if':
        return this.parseIf();
      case 'while':
        return this.parseWhile();
      case 'do':
        return this.parseDoWhile();
      case 'switch':
        return this.parseSwitch();
      case 'for':
        return this.parseFor();
      case 'return':
        return this.parseReturn();
      case 'break':
        this.next();
        this.expect(';');
        return { node: 'break', span: this.spanFrom(t.span) };
      case 'continue':
        this.next();
        this.expect(';');
        return { node: 'continue', span: this.spanFrom(t.span) };
      case '{': {
        const block = this.parseBlock();
        return { node: 'block', block, span: block.span };
      }
      default:
        return this.parseSimpleStmt();
    }
  }

  private parseLet(): Stmt {
    const start = this.expect('let').span;
    const nameTok = this.expect('ident');
    let declTy: Ty | null = null;
    if (this.accept(':')) declTy = this.parseType();
    this.expect('=');
    const init = this.parseExpr();
    this.expect(';');
    return { node: 'let', name: nameTok.text, declTy, init, span: this.spanFrom(start) };
  }

  private parseIf(): Stmt {
    const start = this.expect('if').span;
    this.expect('(');
    const cond = this.parseExpr();
    this.expect(')');
    const then = this.parseBlock();
    let otherwise: Block | null = null;
    if (this.accept('else')) {
      if (this.check('if')) {
        // `else if` — wrap the nested if as a single-statement block.
        const inner = this.parseIf();
        otherwise = { stmts: [inner], span: inner.span };
      } else {
        otherwise = this.parseBlock();
      }
    }
    return { node: 'if', cond, then, otherwise, span: this.spanFrom(start) };
  }

  private parseWhile(): Stmt {
    const start = this.expect('while').span;
    this.expect('(');
    const cond = this.parseExpr();
    this.expect(')');
    const body = this.parseBlock();
    return { node: 'while', cond, body, span: this.spanFrom(start) };
  }

  // `do { B } while (C);` is desugared here into an equivalent bottom-tested loop
  // built only from `while` + a synthetic once-flag:
  //
  //   { let <once> = true; while (<once> || (C)) { <once> = false; B } }
  //
  // The flag forces the first iteration (C is short-circuited away while it is
  // true) and is cleared at the top of the body, so every later header check
  // evaluates C exactly once after the body — precise do-while semantics. Because
  // the desugaring happens before type checking, the interpreter and the backend
  // see the very same `while`, so they cannot disagree about it, and the CFG is
  // the well-tested top-tested-loop shape the relooper already handles.
  private dwCounter = 0;
  private parseDoWhile(): Stmt {
    const start = this.expect('do').span;
    const body = this.parseBlock();
    this.expect('while');
    this.expect('(');
    const cond = this.parseExpr();
    this.expect(')');
    this.expect(';');
    const span = this.spanFrom(start);
    // A name no user identifier can collide with (the lexer never emits '$').
    const flag = `do$once$${this.dwCounter++}`;
    const trueLit: Expr = { node: 'bool', value: true, span };
    const falseLit: Expr = { node: 'bool', value: false, span };
    const flagRef: Expr = { node: 'ident', name: flag, span };
    const guard: Expr = { node: 'binary', op: '||', left: flagRef, right: cond, span };
    const clear: Stmt = { node: 'assign', name: flag, value: falseLit, span };
    const whileBody: Block = { stmts: [clear, ...body.stmts], span: body.span };
    const whileStmt: Stmt = { node: 'while', cond: guard, body: whileBody, span };
    const decl: Stmt = { node: 'let', name: flag, declTy: T_BOOL, init: trueLit, span };
    const block: Block = { stmts: [decl, whileStmt], span };
    return { node: 'block', block, span };
  }

  // switch (disc) { case 1: { … }  case 2, 3: { … }  default: { … } }
  // Cases are constant int labels (comma-separated for multiple), each followed
  // by a block. There is no fallthrough; `default` is optional and may appear in
  // any position but matches last.
  private parseSwitch(): Stmt {
    const start = this.expect('switch').span;
    this.expect('(');
    const disc = this.parseExpr();
    this.expect(')');
    this.expect('{');
    const cases: import('./ast').SwitchCase[] = [];
    let dflt: Block | null = null;
    while (!this.check('}') && !this.check('eof')) {
      if (this.accept('default')) {
        this.expect(':');
        if (dflt) throw new CompileError('duplicate default in switch', this.spanFrom(start), 'parse');
        dflt = this.parseBlock();
        continue;
      }
      const caseStart = this.expect('case').span;
      const values: Expr[] = [this.parseExpr()];
      while (this.accept(',')) values.push(this.parseExpr());
      this.expect(':');
      const body = this.parseBlock();
      cases.push({ values, body, span: this.spanFrom(caseStart) });
    }
    this.expect('}');
    return { node: 'switch', disc, cases, default: dflt, span: this.spanFrom(start) };
  }

  private parseFor(): Stmt {
    const start = this.expect('for').span;
    this.expect('(');
    let init: Stmt | null = null;
    if (!this.check(';')) {
      init = this.check('let') ? this.parseLetNoSemi() : this.parseSimpleStmtNoSemi();
    }
    this.expect(';');
    const cond = this.check(';') ? null : this.parseExpr();
    this.expect(';');
    const update = this.check(')') ? null : this.parseSimpleStmtNoSemi();
    this.expect(')');
    const body = this.parseBlock();
    return { node: 'for', init, cond, update, body, span: this.spanFrom(start) };
  }

  private parseLetNoSemi(): Stmt {
    const start = this.expect('let').span;
    const nameTok = this.expect('ident');
    let declTy: Ty | null = null;
    if (this.accept(':')) declTy = this.parseType();
    this.expect('=');
    const init = this.parseExpr();
    return { node: 'let', name: nameTok.text, declTy, init, span: this.spanFrom(start) };
  }

  private parseReturn(): Stmt {
    const start = this.expect('return').span;
    let value: Expr | null = null;
    if (!this.check(';')) value = this.parseExpr();
    this.expect(';');
    return { node: 'return', value, span: this.spanFrom(start) };
  }

  // Assignment / index-assignment / bare expression statement.
  private parseSimpleStmt(): Stmt {
    const s = this.parseSimpleStmtNoSemi();
    this.expect(';');
    return s;
  }

  // Compound-assignment operators (`a += b` etc.) are lexed as the binary op
  // token followed by `=`; we desugar them to `a = a <op> b`. Because the desugar
  // happens before the AST is consumed by *both* the interpreter and the backend,
  // the two can never disagree about its meaning.
  private static readonly COMPOUND_OPS = new Set<TokenType>(['+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>']);

  private parseSimpleStmtNoSemi(): Stmt {
    const start = this.peek().span;
    const lhs = this.parseExpr();

    const op = this.peek().type;
    const compound = Parser.COMPOUND_OPS.has(op) && this.toks[this.pos + 1]?.type === '=';
    if (this.check('=') || compound) {
      if (compound) {
        this.next(); // the operator
      }
      this.next(); // '='
      const rhs = this.parseExpr();
      const value: Expr = compound
        ? { node: 'binary', op: op as BinaryOp, left: lhs, right: rhs, span: this.spanFrom(start) }
        : rhs;
      if (lhs.node === 'ident') {
        return { node: 'assign', name: lhs.name, value, span: this.spanFrom(start) };
      }
      if (lhs.node === 'index') {
        return { node: 'index-assign', target: lhs.target, index: lhs.index, value, span: this.spanFrom(start) };
      }
      if (lhs.node === 'member') {
        return { node: 'member-assign', target: lhs.target, field: lhs.field, value, span: this.spanFrom(start) };
      }
      throw new CompileError('invalid assignment target', lhs.span, 'parse');
    }
    return { node: 'expr', expr: lhs, span: this.spanFrom(start) };
  }

  // ----- expressions (Pratt) -----

  private parseExpr(minBp = 0): Expr {
    let left = this.parsePrefix();
    for (;;) {
      const op = this.peek().type;
      // Ternary `cond ? a : b` sits at the very bottom of the precedence ladder
      // and is right-associative, so it only triggers when nothing tighter is in
      // progress (minBp === 0 — e.g. at statement / paren / argument level).
      if (op === '?') {
        if (minBp > TERNARY_BP) break;
        this.next();
        const thenE = this.parseExpr(0);
        this.expect(':');
        const elseE = this.parseExpr(TERNARY_BP);
        left = {
          node: 'ternary',
          cond: left,
          then: thenE,
          otherwise: elseE,
          span: { start: left.span.start, end: elseE.span.end, line: left.span.line, col: left.span.col },
        };
        continue;
      }
      // Stop before a compound-assignment operator (`+=`, `<<=`, …) so the
      // statement parser can desugar it; here it is not a binary operator.
      if (Parser.COMPOUND_OPS.has(op) && this.toks[this.pos + 1]?.type === '=') break;
      const bp = BINDING[op];
      if (!bp || bp[0] < minBp) break;
      const opTok = this.next();
      const right = this.parseExpr(bp[1]);
      left = {
        node: 'binary',
        op: opTok.type as BinaryOp,
        left,
        right,
        span: { start: left.span.start, end: right.span.end, line: left.span.line, col: left.span.col },
      };
    }
    return left;
  }

  private parsePrefix(): Expr {
    const t = this.peek();
    if (t.type === '-' || t.type === '!' || t.type === '~' || t.type === '+') {
      this.next();
      const operand = this.parsePrefix();
      return { node: 'unary', op: t.type as UnaryOp, operand, span: this.spanFrom(t.span) };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Expr {
    let e = this.parsePrimary();
    for (;;) {
      if (this.check('[')) {
        this.next();
        const index = this.parseExpr();
        this.expect(']');
        e = { node: 'index', target: e, index, span: this.spanFrom(e.span) };
      } else if (this.check('.')) {
        this.next();
        const field = this.expect('ident');
        e = { node: 'member', target: e, field: field.text, span: this.spanFrom(e.span) };
      } else {
        break;
      }
    }
    return e;
  }

  private parsePrimary(): Expr {
    const t = this.next();
    switch (t.type) {
      case 'int_lit':
        return { node: 'int', value: t.value, span: t.span };
      case 'long_lit':
        return { node: 'long', value: foldLongLiteral(t.text), span: t.span };
      case 'float_lit':
        return { node: 'float', value: t.value, span: t.span };
      case 'str_lit':
        return { node: 'string', value: t.str ?? '', span: t.span };
      case 'true':
        return { node: 'bool', value: true, span: t.span };
      case 'false':
        return { node: 'bool', value: false, span: t.span };
      case 'null':
        return { node: 'null', span: t.span };
      case '(': {
        const e = this.parseExpr();
        this.expect(')');
        return e;
      }
      case 'ident': {
        if (this.check('(')) {
          this.next();
          const args: Expr[] = [];
          if (!this.check(')')) {
            do {
              args.push(this.parseExpr());
            } while (this.accept(','));
          }
          this.expect(')');
          return { node: 'call', callee: t.text, args, span: this.spanFrom(t.span) };
        }
        return { node: 'ident', name: t.text, span: t.span };
      }
      default:
        throw new CompileError(`unexpected token '${t.text || t.type}' in expression`, t.span, 'parse');
    }
  }
}

export function parse(source: string): Program {
  const toks = tokenize(source);
  return new Parser(toks).parseProgram();
}
