import { CompileError } from './diagnostics';
import type {
  BinaryOp,
  Block,
  Expr,
  Program,
  ScalarTy,
  Stmt,
  Ty,
} from './ast';
import { T_BOOL, T_FLOAT, T_INT, T_STR, T_VOID, tyEqual, tyName } from './ast';

// The type checker resolves every identifier, validates operators, and writes
// the inferred `ty` back onto each expression node so later phases never have to
// re-derive it. It also produces a SymbolTable describing function signatures
// and globals, which the IR builder consumes.

export interface FnSig {
  params: Ty[];
  ret: Ty;
}

export interface SymbolTable {
  functions: Map<string, FnSig>;
  globals: Map<string, Ty>;
}

// Builtins available without declaration. `print`/`int`/`float` are special-
// cased because they accept multiple argument types; array intrinsics return
// handles into linear memory.
const ARRAY_INTRINSICS = new Set(['int_array', 'float_array', 'str_array', 'len']);
const STR_BUILTINS = new Set([
  'str', 'char', 'substr', 'index_of', 'to_upper', 'to_lower',
  'repeat', 'trim', 'replace', 'find', 'contains', 'starts_with', 'ends_with', 'parse_int',
  'split', 'join',
]);

// Table-driven signatures for the extended string library. Each entry lists the
// expected argument types and the result type; the checker validates arity and
// types uniformly. (`str`/`char`/`substr`/… keep their bespoke checks above for
// historical error messages.)
const STRING_FN_SIGS: Record<string, { params: ('str' | 'int')[]; ret: 'str' | 'int' | 'bool' }> = {
  repeat: { params: ['str', 'int'], ret: 'str' },
  trim: { params: ['str'], ret: 'str' },
  replace: { params: ['str', 'str', 'str'], ret: 'str' },
  find: { params: ['str', 'str'], ret: 'int' },
  contains: { params: ['str', 'str'], ret: 'bool' },
  starts_with: { params: ['str', 'str'], ret: 'bool' },
  ends_with: { params: ['str', 'str'], ret: 'bool' },
  parse_int: { params: ['str'], ret: 'int' },
};

// Low-level memory intrinsics. They are *not* part of the user-facing language —
// they are only enabled while type-checking the internal string runtime prelude
// (see `lowLevel`), which is written in Strata itself and compiled through the
// real pipeline. Each maps to a single IR memory op in the builder.
const INTRINSIC_SIGS: Record<string, { params: ('int')[]; ret: 'int' | 'void' }> = {
  __load8: { params: ['int'], ret: 'int' },
  __load32: { params: ['int'], ret: 'int' },
  __store8: { params: ['int', 'int'], ret: 'void' },
  __store32: { params: ['int', 'int'], ret: 'void' },
  __alloc: { params: ['int'], ret: 'int' },
};

class Scope {
  private maps: Map<string, Ty>[] = [new Map()];
  push(): void {
    this.maps.push(new Map());
  }
  pop(): void {
    this.maps.pop();
  }
  declare(name: string, ty: Ty, span: import('./diagnostics').Span): void {
    const top = this.maps[this.maps.length - 1];
    if (top.has(name)) throw new CompileError(`'${name}' is already declared in this scope`, span, 'type');
    top.set(name, ty);
  }
  lookup(name: string): Ty | undefined {
    for (let i = this.maps.length - 1; i >= 0; i--) {
      const t = this.maps[i].get(name);
      if (t) return t;
    }
    return undefined;
  }
}

class Checker {
  syms: SymbolTable = { functions: new Map(), globals: new Map() };
  private scope = new Scope();
  private retTy: Ty = T_VOID;
  private loopDepth = 0;
  private lowLevel: boolean;
  constructor(lowLevel = false) {
    this.lowLevel = lowLevel;
  }

  check(prog: Program): SymbolTable {
    // Pass 1: collect signatures so functions can be mutually recursive.
    for (const d of prog.decls) {
      if (d.kind === 'fn') {
        if (!this.lowLevel && d.name.startsWith('__'))
          throw new CompileError(`names beginning with '__' are reserved`, d.span, 'type');
        if (this.syms.functions.has(d.name) || ARRAY_INTRINSICS.has(d.name) || STR_BUILTINS.has(d.name) || d.name === 'print')
          throw new CompileError(`duplicate or reserved function name '${d.name}'`, d.span, 'type');
        this.syms.functions.set(d.name, { params: d.params.map((p) => p.ty), ret: d.retTy });
      }
    }
    // Pass 2: globals (constant initializers, no forward references to globals).
    for (const d of prog.decls) {
      if (d.kind === 'global') {
        const t = this.checkExpr(d.init);
        const declared = d.declTy ?? t;
        if (d.declTy && !this.coercible(t, d.declTy))
          throw new CompileError(`global '${d.name}' declared ${tyName(d.declTy)} but initialized with ${tyName(t)}`, d.span, 'type');
        if (declared.kind === 'void') throw new CompileError(`global '${d.name}' cannot be void`, d.span, 'type');
        d.resolvedTy = declared;
        if (this.syms.globals.has(d.name)) throw new CompileError(`duplicate global '${d.name}'`, d.span, 'type');
        this.syms.globals.set(d.name, declared);
      }
    }
    // Pass 3: function bodies.
    for (const d of prog.decls) {
      if (d.kind === 'fn') {
        this.scope = new Scope();
        this.retTy = d.retTy;
        this.loopDepth = 0;
        for (const p of d.params) {
          if (p.ty.kind === 'void') throw new CompileError(`parameter '${p.name}' cannot be void`, p.span, 'type');
          this.scope.declare(p.name, p.ty, p.span);
        }
        this.checkBlock(d.body);
      }
    }
    return this.syms;
  }

  private checkBlock(b: Block): void {
    this.scope.push();
    for (const s of b.stmts) this.checkStmt(s);
    this.scope.pop();
  }

  private checkStmt(s: Stmt): void {
    switch (s.node) {
      case 'let': {
        const t = this.checkExpr(s.init);
        const declared = s.declTy ?? t;
        if (s.declTy && !this.coercible(t, s.declTy))
          throw new CompileError(`'${s.name}' declared ${tyName(s.declTy)} but initialized with ${tyName(t)}`, s.span, 'type');
        if (declared.kind === 'void') throw new CompileError(`'${s.name}' cannot be void`, s.span, 'type');
        s.resolvedTy = declared;
        this.scope.declare(s.name, declared, s.span);
        break;
      }
      case 'assign': {
        // A bare name resolves to a local first, then to a (mutable) global.
        const target = this.scope.lookup(s.name) ?? this.syms.globals.get(s.name);
        if (!target) throw new CompileError(`undefined variable '${s.name}'`, s.span, 'type');
        const vt = this.checkExpr(s.value);
        if (!this.coercible(vt, target))
          throw new CompileError(`cannot assign ${tyName(vt)} to '${s.name}' of type ${tyName(target)}`, s.span, 'type');
        break;
      }
      case 'index-assign': {
        const tt = this.checkExpr(s.target);
        if (tt.kind !== 'array') throw new CompileError(`cannot index a non-array of type ${tyName(tt)}`, s.span, 'type');
        const it = this.checkExpr(s.index);
        if (it.kind !== 'int') throw new CompileError('array index must be int', s.index.span, 'type');
        const vt = this.checkExpr(s.value);
        const elem: Ty = tt.elem;
        if (!this.coercible(vt, elem))
          throw new CompileError(`cannot store ${tyName(vt)} into ${tyName(tt)}`, s.span, 'type');
        break;
      }
      case 'expr':
        this.checkExpr(s.expr);
        break;
      case 'if': {
        this.expectBool(s.cond);
        this.checkBlock(s.then);
        if (s.otherwise) this.checkBlock(s.otherwise);
        break;
      }
      case 'while': {
        this.expectBool(s.cond);
        this.loopDepth++;
        this.checkBlock(s.body);
        this.loopDepth--;
        break;
      }
      case 'switch': {
        const dt = this.checkExpr(s.disc);
        if (dt.kind !== 'int') throw new CompileError(`switch value must be int, found ${tyName(dt)}`, s.disc.span, 'type');
        const seen = new Set<number>();
        for (const c of s.cases) {
          c.nums = c.values.map((v) => {
            const t = this.checkExpr(v);
            if (t.kind !== 'int') throw new CompileError('case label must be an int constant', v.span, 'type');
            const n = foldIntConst(v);
            if (n === null) throw new CompileError('case label must be a constant expression', v.span, 'type');
            if (seen.has(n)) throw new CompileError(`duplicate case label ${n}`, v.span, 'type');
            seen.add(n);
            return n;
          });
          this.checkBlock(c.body);
        }
        if (s.default) this.checkBlock(s.default);
        break;
      }
      case 'for': {
        this.scope.push();
        if (s.init) this.checkStmt(s.init);
        if (s.cond) this.expectBool(s.cond);
        this.loopDepth++;
        if (s.update) this.checkStmt(s.update);
        this.checkBlock(s.body);
        this.loopDepth--;
        this.scope.pop();
        break;
      }
      case 'return': {
        if (s.value) {
          const t = this.checkExpr(s.value);
          if (this.retTy.kind === 'void') throw new CompileError('cannot return a value from a void function', s.span, 'type');
          if (!this.coercible(t, this.retTy))
            throw new CompileError(`return type ${tyName(t)} does not match ${tyName(this.retTy)}`, s.span, 'type');
        } else if (this.retTy.kind !== 'void') {
          throw new CompileError(`must return a value of type ${tyName(this.retTy)}`, s.span, 'type');
        }
        break;
      }
      case 'break':
      case 'continue':
        if (this.loopDepth === 0) throw new CompileError(`'${s.node}' outside of a loop`, s.span, 'type');
        break;
      case 'block':
        this.checkBlock(s.block);
        break;
    }
  }

  private expectBool(e: Expr): void {
    const t = this.checkExpr(e);
    if (t.kind !== 'bool') throw new CompileError(`condition must be bool, found ${tyName(t)}`, e.span, 'type');
  }

  // `coercible` is intentionally strict: Strata performs no implicit numeric
  // conversions. Kept as a hook so future literal-widening could slot in here.
  private coercible(from: Ty, to: Ty): boolean {
    return tyEqual(from, to);
  }

  private checkExpr(e: Expr): Ty {
    const t = this.checkExprInner(e);
    e.ty = t;
    return t;
  }

  private checkExprInner(e: Expr): Ty {
    switch (e.node) {
      case 'int':
        return T_INT;
      case 'float':
        return T_FLOAT;
      case 'bool':
        return T_BOOL;
      case 'string':
        return T_STR;
      case 'ident': {
        const local = this.scope.lookup(e.name);
        if (local) return local;
        const g = this.syms.globals.get(e.name);
        if (g) return g;
        throw new CompileError(`undefined name '${e.name}'`, e.span, 'type');
      }
      case 'unary':
        return this.checkUnary(e);
      case 'binary':
        return this.checkBinary(e);
      case 'index': {
        const tt = this.checkExpr(e.target);
        if (tt.kind !== 'array' && tt.kind !== 'str')
          throw new CompileError(`cannot index a non-array of type ${tyName(tt)}`, e.span, 'type');
        const it = this.checkExpr(e.index);
        if (it.kind !== 'int') throw new CompileError('index must be int', e.index.span, 'type');
        // Indexing a string yields the byte at that position as an int (0..255).
        return tt.kind === 'str' ? T_INT : tt.elem;
      }
      case 'call':
        return this.checkCall(e);
      case 'ternary': {
        this.expectBool(e.cond);
        const a = this.checkExpr(e.then);
        const b = this.checkExpr(e.otherwise);
        if (a.kind === 'void' || b.kind === 'void')
          throw new CompileError('a conditional expression cannot have void branches', e.span, 'type');
        if (!tyEqual(a, b))
          throw new CompileError(`conditional branches have mismatched types ${tyName(a)} and ${tyName(b)}`, e.span, 'type');
        return a;
      }
    }
  }

  private checkUnary(e: Extract<Expr, { node: 'unary' }>): Ty {
    const t = this.checkExpr(e.operand);
    switch (e.op) {
      case '-':
      case '+':
        if (t.kind === 'int' || t.kind === 'float') return t;
        throw new CompileError(`unary '${e.op}' requires a numeric operand, found ${tyName(t)}`, e.span, 'type');
      case '!':
        if (t.kind === 'bool') return T_BOOL;
        throw new CompileError(`'!' requires a bool operand, found ${tyName(t)}`, e.span, 'type');
      case '~':
        if (t.kind === 'int') return T_INT;
        throw new CompileError(`'~' requires an int operand, found ${tyName(t)}`, e.span, 'type');
    }
  }

  private checkBinary(e: Extract<Expr, { node: 'binary' }>): Ty {
    const op: BinaryOp = e.op;
    const lt = this.checkExpr(e.left);
    const rt = this.checkExpr(e.right);
    const sameNumeric = (lt.kind === 'int' || lt.kind === 'float') && tyEqual(lt, rt);

    switch (op) {
      case '+':
        // `+` is overloaded for string concatenation.
        if (lt.kind === 'str' && rt.kind === 'str') return T_STR;
        if (sameNumeric) return lt;
        throw new CompileError(`'+' requires matching numeric or string operands, found ${tyName(lt)} and ${tyName(rt)}`, e.span, 'type');
      case '-':
      case '*':
      case '/':
        if (sameNumeric) return lt;
        throw new CompileError(`'${op}' requires matching numeric operands, found ${tyName(lt)} and ${tyName(rt)}`, e.span, 'type');
      case '%':
      case '&':
      case '|':
      case '^':
      case '<<':
      case '>>':
        if (lt.kind === 'int' && rt.kind === 'int') return T_INT;
        throw new CompileError(`'${op}' requires int operands, found ${tyName(lt)} and ${tyName(rt)}`, e.span, 'type');
      case '<':
      case '<=':
      case '>':
      case '>=':
        if (sameNumeric) return T_BOOL;
        if (lt.kind === 'str' && rt.kind === 'str') return T_BOOL; // lexicographic
        throw new CompileError(`'${op}' requires matching numeric or string operands, found ${tyName(lt)} and ${tyName(rt)}`, e.span, 'type');
      case '==':
      case '!=':
        if (tyEqual(lt, rt) && lt.kind !== 'void' && lt.kind !== 'array') return T_BOOL;
        throw new CompileError(`'${op}' requires matching scalar operands, found ${tyName(lt)} and ${tyName(rt)}`, e.span, 'type');
      case '&&':
      case '||':
        if (lt.kind === 'bool' && rt.kind === 'bool') return T_BOOL;
        throw new CompileError(`'${op}' requires bool operands, found ${tyName(lt)} and ${tyName(rt)}`, e.span, 'type');
    }
  }

  private checkCall(e: Extract<Expr, { node: 'call' }>): Ty {
    const name = e.callee;
    // builtins
    // Low-level memory intrinsics (only inside the string-runtime prelude).
    if (this.lowLevel && name in INTRINSIC_SIGS) {
      const sig = INTRINSIC_SIGS[name];
      if (e.args.length !== sig.params.length)
        throw new CompileError(`${name}() expects ${sig.params.length} argument(s)`, e.span, 'type');
      for (const a of e.args) {
        const t = this.checkExpr(a);
        if (t.kind !== 'int') throw new CompileError(`${name}() arguments must be int`, a.span, 'type');
      }
      return sig.ret === 'int' ? T_INT : T_VOID;
    }
    if (name === 'print') {
      if (e.args.length !== 1) throw new CompileError('print expects 1 argument', e.span, 'type');
      const t = this.checkExpr(e.args[0]);
      if (t.kind !== 'int' && t.kind !== 'float' && t.kind !== 'bool' && t.kind !== 'str')
        throw new CompileError(`print expects a scalar or string, found ${tyName(t)}`, e.span, 'type');
      return T_VOID;
    }
    if (name === 'str') {
      if (e.args.length !== 1) throw new CompileError('str() expects 1 argument', e.span, 'type');
      const t = this.checkExpr(e.args[0]);
      if (t.kind !== 'int' && t.kind !== 'bool' && t.kind !== 'str')
        throw new CompileError(`str() expects an int, bool, or str, found ${tyName(t)}`, e.span, 'type');
      return T_STR;
    }
    if (name === 'char') {
      if (e.args.length !== 1) throw new CompileError('char() expects 1 argument', e.span, 'type');
      const t = this.checkExpr(e.args[0]);
      if (t.kind !== 'int') throw new CompileError(`char() expects an int, found ${tyName(t)}`, e.span, 'type');
      return T_STR;
    }
    if (name === 'substr') {
      if (e.args.length !== 3) throw new CompileError('substr() expects (str, start, count)', e.span, 'type');
      if (this.checkExpr(e.args[0]).kind !== 'str') throw new CompileError('substr() argument 1 must be str', e.args[0].span, 'type');
      if (this.checkExpr(e.args[1]).kind !== 'int') throw new CompileError('substr() start must be int', e.args[1].span, 'type');
      if (this.checkExpr(e.args[2]).kind !== 'int') throw new CompileError('substr() count must be int', e.args[2].span, 'type');
      return T_STR;
    }
    if (name === 'index_of') {
      if (e.args.length !== 2) throw new CompileError('index_of() expects (str, charCode)', e.span, 'type');
      if (this.checkExpr(e.args[0]).kind !== 'str') throw new CompileError('index_of() argument 1 must be str', e.args[0].span, 'type');
      if (this.checkExpr(e.args[1]).kind !== 'int') throw new CompileError('index_of() charCode must be int', e.args[1].span, 'type');
      return T_INT;
    }
    if (name === 'to_upper' || name === 'to_lower') {
      if (e.args.length !== 1) throw new CompileError(`${name}() expects 1 argument`, e.span, 'type');
      if (this.checkExpr(e.args[0]).kind !== 'str') throw new CompileError(`${name}() expects a str`, e.args[0].span, 'type');
      return T_STR;
    }
    if (name in STRING_FN_SIGS) {
      const sig = STRING_FN_SIGS[name];
      if (e.args.length !== sig.params.length)
        throw new CompileError(`${name}() expects ${sig.params.length} argument(s)`, e.span, 'type');
      sig.params.forEach((want, i) => {
        const got = this.checkExpr(e.args[i]);
        if (got.kind !== want)
          throw new CompileError(`${name}() argument ${i + 1} expects ${want}, found ${tyName(got)}`, e.args[i].span, 'type');
      });
      return sig.ret === 'str' ? T_STR : sig.ret === 'bool' ? T_BOOL : T_INT;
    }
    if (name === 'int' || name === 'float') {
      if (e.args.length !== 1) throw new CompileError(`${name}() expects 1 argument`, e.span, 'type');
      const t = this.checkExpr(e.args[0]);
      if (t.kind !== 'int' && t.kind !== 'float' && t.kind !== 'bool')
        throw new CompileError(`${name}() expects a numeric argument, found ${tyName(t)}`, e.span, 'type');
      return name === 'int' ? T_INT : T_FLOAT;
    }
    if (name === 'int_array' || name === 'float_array' || name === 'str_array') {
      if (e.args.length !== 1) throw new CompileError(`${name}() expects a length`, e.span, 'type');
      const t = this.checkExpr(e.args[0]);
      if (t.kind !== 'int') throw new CompileError(`${name}() length must be int`, e.span, 'type');
      const elem: ScalarTy = name === 'int_array' ? { kind: 'int' } : name === 'float_array' ? { kind: 'float' } : { kind: 'str' };
      return { kind: 'array', elem };
    }
    if (name === 'split') {
      if (e.args.length !== 2) throw new CompileError('split() expects (str, separator)', e.span, 'type');
      if (this.checkExpr(e.args[0]).kind !== 'str') throw new CompileError('split() argument 1 must be str', e.args[0].span, 'type');
      if (this.checkExpr(e.args[1]).kind !== 'str') throw new CompileError('split() separator must be str', e.args[1].span, 'type');
      return { kind: 'array', elem: { kind: 'str' } };
    }
    if (name === 'join') {
      if (e.args.length !== 2) throw new CompileError('join() expects (str[], separator)', e.span, 'type');
      const at = this.checkExpr(e.args[0]);
      if (at.kind !== 'array' || at.elem.kind !== 'str') throw new CompileError('join() argument 1 must be str[]', e.args[0].span, 'type');
      if (this.checkExpr(e.args[1]).kind !== 'str') throw new CompileError('join() separator must be str', e.args[1].span, 'type');
      return T_STR;
    }
    if (name === 'len') {
      if (e.args.length !== 1) throw new CompileError('len() expects 1 argument', e.span, 'type');
      const t = this.checkExpr(e.args[0]);
      if (t.kind !== 'array' && t.kind !== 'str')
        throw new CompileError(`len() expects an array or string, found ${tyName(t)}`, e.span, 'type');
      return T_INT;
    }
    // user function
    const sig = this.syms.functions.get(name);
    if (!sig) throw new CompileError(`call to undefined function '${name}'`, e.span, 'type');
    if (sig.params.length !== e.args.length)
      throw new CompileError(`'${name}' expects ${sig.params.length} arguments, got ${e.args.length}`, e.span, 'type');
    for (let i = 0; i < e.args.length; i++) {
      const at = this.checkExpr(e.args[i]);
      if (!this.coercible(at, sig.params[i]))
        throw new CompileError(`argument ${i + 1} of '${name}' expects ${tyName(sig.params[i])}, got ${tyName(at)}`, e.args[i].span, 'type');
    }
    return sig.ret;
  }
}

export function typecheck(prog: Program, opts?: { lowLevel?: boolean }): SymbolTable {
  return new Checker(opts?.lowLevel ?? false).check(prog);
}

// Fold a constant integer expression (switch case labels). Mirrors wasm i32
// wrapping so a label like `1 << 4` agrees with the discriminant comparison.
function foldIntConst(e: Expr): number | null {
  switch (e.node) {
    case 'int':
      return e.value | 0;
    case 'bool':
      return e.value ? 1 : 0;
    case 'unary': {
      const v = foldIntConst(e.operand);
      if (v === null) return null;
      if (e.op === '-') return -v | 0;
      if (e.op === '+') return v;
      if (e.op === '~') return ~v;
      return null;
    }
    case 'binary': {
      const a = foldIntConst(e.left);
      const b = foldIntConst(e.right);
      if (a === null || b === null) return null;
      switch (e.op) {
        case '+': return (a + b) | 0;
        case '-': return (a - b) | 0;
        case '*': return Math.imul(a, b);
        case '&': return a & b;
        case '|': return a | b;
        case '^': return a ^ b;
        case '<<': return a << (b & 31);
        case '>>': return a >> (b & 31);
        default: return null;
      }
    }
    default:
      return null;
  }
}
