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
import { T_BOOL, T_FLOAT, T_INT, T_VOID, tyEqual, tyName } from './ast';

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
const ARRAY_INTRINSICS = new Set(['int_array', 'float_array', 'len']);

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

  check(prog: Program): SymbolTable {
    // Pass 1: collect signatures so functions can be mutually recursive.
    for (const d of prog.decls) {
      if (d.kind === 'fn') {
        if (this.syms.functions.has(d.name) || ARRAY_INTRINSICS.has(d.name) || d.name === 'print')
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
        if (tt.kind !== 'array') throw new CompileError(`cannot index a non-array of type ${tyName(tt)}`, e.span, 'type');
        const it = this.checkExpr(e.index);
        if (it.kind !== 'int') throw new CompileError('array index must be int', e.index.span, 'type');
        return tt.elem;
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
        throw new CompileError(`'${op}' requires matching numeric operands, found ${tyName(lt)} and ${tyName(rt)}`, e.span, 'type');
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
    if (name === 'print') {
      if (e.args.length !== 1) throw new CompileError('print expects 1 argument', e.span, 'type');
      const t = this.checkExpr(e.args[0]);
      if (t.kind !== 'int' && t.kind !== 'float' && t.kind !== 'bool')
        throw new CompileError(`print expects a scalar, found ${tyName(t)}`, e.span, 'type');
      return T_VOID;
    }
    if (name === 'int' || name === 'float') {
      if (e.args.length !== 1) throw new CompileError(`${name}() expects 1 argument`, e.span, 'type');
      const t = this.checkExpr(e.args[0]);
      if (t.kind !== 'int' && t.kind !== 'float' && t.kind !== 'bool')
        throw new CompileError(`${name}() expects a numeric argument, found ${tyName(t)}`, e.span, 'type');
      return name === 'int' ? T_INT : T_FLOAT;
    }
    if (name === 'int_array' || name === 'float_array') {
      if (e.args.length !== 1) throw new CompileError(`${name}() expects a length`, e.span, 'type');
      const t = this.checkExpr(e.args[0]);
      if (t.kind !== 'int') throw new CompileError(`${name}() length must be int`, e.span, 'type');
      const elem: ScalarTy = name === 'int_array' ? { kind: 'int' } : { kind: 'float' };
      return { kind: 'array', elem };
    }
    if (name === 'len') {
      if (e.args.length !== 1) throw new CompileError('len() expects 1 argument', e.span, 'type');
      const t = this.checkExpr(e.args[0]);
      if (t.kind !== 'array') throw new CompileError(`len() expects an array, found ${tyName(t)}`, e.span, 'type');
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

export function typecheck(prog: Program): SymbolTable {
  return new Checker().check(prog);
}
