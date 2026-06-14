// Semantic analysis / type checking. We resolve every identifier to a symbol, annotate
// every expression node with its C type (`cty`), lay out each function's stack frame
// (assigning byte offsets to params and locals), and validate the obvious C rules
// (lvalues, assignability, struct members, call arities). Errors are collected rather than
// thrown so the IDE can show several at once; a best-effort type is filled in on failure so
// the walk can continue.

import {
  tVoid,
  tInt,
  tChar,
  pointerTo,
  arrayOf,
  funcType,
  decay,
  isInteger,
  isPointer,
  isPointerLike,
  isScalar,
  isVoid,
  elementOf,
  alignUp,
  typeName,
} from './ctype';
import type { CType } from './ctype';
import type {
  Program,
  FuncDecl,
  VarDecl,
  Stmt,
  Expr,
  Sym,
  BinOp,
} from './ast';

export interface SemaError {
  line: number;
  message: string;
}

// Builtins the codegen lowers to inline `ecall` / instruction sequences. Predeclared here so
// the prelude (and user code) type-check when they call them.
const BUILTINS: { name: string; ret: CType; params: CType[] }[] = [
  { name: '__sys_print_int', ret: tInt, params: [tInt] },
  { name: '__sys_print_uint', ret: tInt, params: [tInt] },
  { name: '__sys_print_char', ret: tInt, params: [tInt] },
  { name: '__sys_print_str', ret: tInt, params: [pointerTo(tChar)] },
  { name: '__sys_sbrk', ret: pointerTo(tVoid), params: [tInt] },
  { name: '__sys_exit', ret: tVoid, params: [tInt] },
  { name: '__sys_rand', ret: tInt, params: [] },
  { name: '__lsr', ret: tInt, params: [tInt, tInt] },
];

export function mangle(name: string): string {
  return '_cc_' + name;
}

class Scope {
  vars = new Map<string, Sym>();
  parent: Scope | null;
  constructor(parent: Scope | null) {
    this.parent = parent;
  }
  lookup(name: string): Sym | undefined {
    return this.vars.get(name) ?? this.parent?.lookup(name);
  }
}

export class Sema {
  errors: SemaError[] = [];
  private global = new Scope(null);
  private scope = this.global;
  private fn: FuncDecl | null = null;
  private cursor = 0; // frame allocation cursor (negative offsets)
  private strs: { value: string; label: string }[] = [];
  private strSeq = 0;

  /** All string literals discovered, for codegen's .data section. */
  get strings(): readonly { value: string; label: string }[] {
    return this.strs;
  }

  check(prog: Program): SemaError[] {
    // builtins
    for (const b of BUILTINS) {
      const sym: Sym = {
        name: b.name,
        type: funcType(b.ret, b.params, false),
        storage: 'global',
        offset: 0,
        isFunc: true,
        label: b.name,
      };
      this.global.vars.set(b.name, sym);
    }
    // globals + function prototypes first (so forward references resolve)
    for (const g of prog.globals) this.declareGlobal(g);
    for (const f of prog.funcs) this.declareFunc(f);
    // function bodies
    for (const f of prog.funcs) if (f.body) this.checkFunc(f);
    return this.errors;
  }

  private error(line: number, message: string): void {
    this.errors.push({ line, message });
  }

  // ---- declarations ----
  private declareGlobal(g: VarDecl): void {
    if (this.global.vars.has(g.name)) {
      // allow redeclaration if same kind (tentative); just reuse
      const prev = this.global.vars.get(g.name)!;
      g.sym = prev;
      if (g.init) this.checkInit(g);
      return;
    }
    const sym: Sym = {
      name: g.name,
      type: g.type,
      storage: 'global',
      offset: 0,
      label: mangle(g.name),
    };
    this.global.vars.set(g.name, sym);
    g.sym = sym;
    if (g.init) this.checkInit(g);
  }

  private checkInit(g: VarDecl): void {
    if (!g.init) return;
    // String initializer for a char array / pointer is handled specially by codegen;
    // type-check the initializer expression for everything else.
    this.checkExpr(g.init);
  }

  private declareFunc(f: FuncDecl): void {
    const ftype = funcType(
      f.retType,
      f.params.map((p) => decay(p.type)),
      f.variadic,
    );
    const existing = this.global.vars.get(f.name);
    if (existing && existing.isFunc) {
      f.sym = existing;
    } else {
      const sym: Sym = {
        name: f.name,
        type: ftype,
        storage: 'global',
        offset: 0,
        isFunc: true,
        label: f.name === 'main' ? mangle('main') : mangle(f.name),
        defined: !!f.body,
      };
      this.global.vars.set(f.name, sym);
      f.sym = sym;
    }
    if (f.body) f.sym!.defined = true;
  }

  // ---- function body ----
  private checkFunc(f: FuncDecl): void {
    this.fn = f;
    this.cursor = -8; // below saved ra (-4) and saved fp (-8)
    f.locals = [];
    const fnScope = new Scope(this.global);
    this.scope = fnScope;

    if (f.variadic) {
      // reserve an 8-word register save area; named params alias its first slots.
      const base = this.cursor - 32;
      this.cursor = base;
      f.vaBase = base;
      f.params.forEach((p, i) => {
        if (i >= 8) {
          this.error(p.line, `variadic function '${f.name}' has too many named params`);
          return;
        }
        const sym: Sym = { name: p.name, type: decay(p.type), storage: 'param', offset: base + i * 4 };
        p.sym = sym;
        fnScope.vars.set(p.name, sym);
        f.locals.push(sym);
      });
    } else {
      f.params.forEach((p, i) => {
        const pt = decay(p.type);
        let offset: number;
        if (i < 8) {
          this.cursor -= 4;
          offset = this.cursor;
        } else {
          offset = (i - 8) * 4; // passed on the caller's stack, above fp
        }
        const sym: Sym = { name: p.name, type: pt, storage: 'param', offset };
        p.sym = sym;
        fnScope.vars.set(p.name, sym);
        f.locals.push(sym);
      });
    }

    this.checkStmt(f.body!);

    this.scope = this.global;
    f.frameSize = alignUp(-this.cursor, 16);
    this.fn = null;
  }

  private allocLocal(name: string, type: CType, line: number): Sym {
    const size = Math.max(type.size, 1);
    const slot = alignUp(size, 4);
    this.cursor -= slot;
    const sym: Sym = { name, type, storage: 'local', offset: this.cursor };
    if (this.scope.vars.has(name)) this.error(line, `redeclaration of '${name}'`);
    this.scope.vars.set(name, sym);
    this.fn?.locals.push(sym);
    return sym;
  }

  // ---- statements ----
  private checkStmt(s: Stmt): void {
    switch (s.kind) {
      case 'block': {
        const saved = this.scope;
        this.scope = new Scope(saved);
        for (const st of s.stmts) this.checkStmt(st);
        this.scope = saved;
        break;
      }
      case 'decl':
        for (const d of s.decls) {
          const sym = this.allocLocal(d.name, d.type, d.line);
          d.sym = sym;
          if (d.init) {
            // string init for char arrays handled in codegen; type-check others
            this.checkExpr(d.init);
            if (!(isCharArray(d.type) && d.init.kind === 'str')) {
              this.checkAssignable(d.type, d.init, d.line, 'initialize');
            }
          }
        }
        break;
      case 'expr':
        this.checkExpr(s.expr);
        break;
      case 'if':
        this.checkCond(s.cond);
        this.checkStmt(s.then);
        if (s.els) this.checkStmt(s.els);
        break;
      case 'while':
        this.checkCond(s.cond);
        this.checkStmt(s.body);
        break;
      case 'dowhile':
        this.checkStmt(s.body);
        this.checkCond(s.cond);
        break;
      case 'for': {
        const saved = this.scope;
        this.scope = new Scope(saved);
        if (s.init) this.checkStmt(s.init);
        if (s.cond) this.checkCond(s.cond);
        if (s.step) this.checkExpr(s.step);
        this.checkStmt(s.body);
        this.scope = saved;
        break;
      }
      case 'return':
        if (s.expr) {
          this.checkExpr(s.expr);
          if (this.fn && isVoid(this.fn.retType)) this.error(s.line, 'returning a value from a void function');
          else if (this.fn) this.checkAssignable(this.fn.retType, s.expr, s.line, 'return');
        }
        break;
      case 'break':
      case 'continue':
      case 'empty':
        break;
    }
  }

  private checkCond(e: Expr): void {
    this.checkExpr(e);
    const t = decay(e.cty ?? tInt);
    if (!isScalar(t)) this.error(e.line, `condition must be scalar, got ${typeName(t)}`);
  }

  // ---- expressions ----
  private checkExpr(e: Expr): CType {
    const t = this.checkExprInner(e);
    e.cty = t;
    return t;
  }

  private checkExprInner(e: Expr): CType {
    switch (e.kind) {
      case 'num':
        return tInt;
      case 'str': {
        const label = `__cc_str_${this.strSeq++}`;
        e.label = label;
        this.strs.push({ value: e.value, label });
        return arrayOf(tChar, e.value.length + 1);
      }
      case 'ident': {
        const sym = this.scope.lookup(e.name);
        if (!sym) {
          this.error(e.line, `undeclared identifier '${e.name}'`);
          return tInt;
        }
        e.sym = sym;
        return sym.type;
      }
      case 'call':
        return this.checkCall(e);
      case 'unary':
        return this.checkUnary(e);
      case 'binary':
        return this.checkBinary(e);
      case 'logical':
        this.checkExpr(e.lhs);
        this.checkExpr(e.rhs);
        return tInt;
      case 'assign':
        return this.checkAssign(e);
      case 'cond': {
        this.checkCond(e.cond);
        const a = decay(this.checkExpr(e.then));
        const b = decay(this.checkExpr(e.els));
        // pick a pointer type if either is a pointer, else int
        if (isPointer(a)) return a;
        if (isPointer(b)) return b;
        void b;
        return a.kind === 'void' ? b : a;
      }
      case 'comma':
        this.checkExpr(e.lhs);
        return this.checkExpr(e.rhs);
      case 'member':
        return this.checkMember(e);
      case 'index':
        return this.checkIndex(e);
      case 'cast': {
        this.checkExpr(e.operand);
        return e.toType;
      }
      case 'sizeof': {
        if (e.argExpr) this.checkExpr(e.argExpr);
        return tInt;
      }
      case 'va_arg': {
        this.checkExpr(e.ap);
        return e.argType;
      }
      case 'vactl': {
        this.checkExpr(e.ap);
        if (e.last) this.checkExpr(e.last);
        return tVoid;
      }
    }
  }

  private checkCall(e: import('./ast').CallExpr): CType {
    const ct = this.checkExpr(e.callee);
    for (const a of e.args) this.checkExpr(a);
    let ftype = ct;
    if (ftype.kind === 'ptr' && ftype.base?.kind === 'func') ftype = ftype.base;
    if (ftype.kind !== 'func') {
      this.error(e.line, 'called object is not a function');
      return tInt;
    }
    const params = ftype.params ?? [];
    if (!ftype.variadic && e.args.length !== params.length) {
      this.error(e.line, `expected ${params.length} argument(s), got ${e.args.length}`);
    } else if (ftype.variadic && e.args.length < params.length) {
      this.error(e.line, `expected at least ${params.length} argument(s), got ${e.args.length}`);
    }
    return ftype.base ?? tInt;
  }

  private checkUnary(e: import('./ast').UnaryExpr): CType {
    const t = this.checkExpr(e.operand);
    const dt = decay(t);
    switch (e.op) {
      case 'neg':
      case 'pos':
      case 'bnot':
        if (!isInteger(dt)) this.error(e.line, `operand of unary must be integer`);
        return tInt;
      case 'not':
        if (!isScalar(dt)) this.error(e.line, `operand of '!' must be scalar`);
        return tInt;
      case 'deref':
        if (!isPointerLike(t)) {
          this.error(e.line, `cannot dereference non-pointer ${typeName(t)}`);
          return tInt;
        }
        return elementOf(t);
      case 'addr':
        if (!this.isLvalue(e.operand)) this.error(e.line, `cannot take address of a non-lvalue`);
        return pointerTo(t);
      case 'preinc':
      case 'predec':
      case 'postinc':
      case 'postdec':
        if (!this.isLvalue(e.operand)) this.error(e.line, `operand of ++/-- must be an lvalue`);
        if (!isScalar(dt)) this.error(e.line, `operand of ++/-- must be scalar`);
        return dt;
    }
  }

  private checkBinary(e: import('./ast').BinaryExpr): CType {
    const lt = decay(this.checkExpr(e.lhs));
    const rt = decay(this.checkExpr(e.rhs));
    const op = e.op;
    if (op === '+') {
      if (isPointer(lt) && isInteger(rt)) return lt;
      if (isInteger(lt) && isPointer(rt)) return rt;
      return tInt;
    }
    if (op === '-') {
      if (isPointer(lt) && isInteger(rt)) return lt;
      if (isPointer(lt) && isPointer(rt)) return tInt; // pointer difference
      return tInt;
    }
    if (op === '<' || op === '<=' || op === '>' || op === '>=' || op === '==' || op === '!=') {
      return tInt;
    }
    // * / % << >> & | ^
    if (!isInteger(lt) || !isInteger(rt)) {
      // allow comparisons handled above; here require integers
      this.error(e.line, `operands of '${op}' must be integers`);
    }
    return tInt;
  }

  private checkAssign(e: import('./ast').AssignExpr): CType {
    const tt = this.checkExpr(e.target);
    this.checkExpr(e.value);
    if (!this.isLvalue(e.target)) this.error(e.line, 'left side of assignment is not an lvalue');
    if (tt.kind === 'array') this.error(e.line, 'cannot assign to an array');
    if (e.op === null) this.checkAssignable(tt, e.value, e.line, 'assign');
    return decay(tt);
  }

  private checkMember(e: import('./ast').MemberExpr): CType {
    const ot = this.checkExpr(e.obj);
    let st = ot;
    if (e.arrow) {
      if (!isPointerLike(ot) || elementOf(ot).kind !== 'struct') {
        this.error(e.line, `'->' requires a pointer to struct`);
        return tInt;
      }
      st = elementOf(ot);
    } else {
      if (ot.kind !== 'struct') {
        this.error(e.line, `'.' requires a struct`);
        return tInt;
      }
    }
    const m = (st.members ?? []).find((x) => x.name === e.name);
    if (!m) {
      this.error(e.line, `no member '${e.name}' in ${typeName(st)}`);
      return tInt;
    }
    e.offset = m.offset;
    return m.type;
  }

  private checkIndex(e: import('./ast').IndexExpr): CType {
    const bt = decay(this.checkExpr(e.base));
    const it = decay(this.checkExpr(e.index));
    let ptr = bt;
    if (!isPointer(bt) && isPointer(it)) ptr = it; // allow i[arr]
    if (!isPointer(ptr)) {
      this.error(e.line, `cannot index non-pointer ${typeName(bt)}`);
      return tInt;
    }
    return elementOf(ptr);
  }

  // ---- helpers ----
  private isLvalue(e: Expr): boolean {
    switch (e.kind) {
      case 'ident':
        return !e.sym?.isFunc;
      case 'unary':
        return e.op === 'deref';
      case 'index':
        return true;
      case 'member':
        return true;
      default:
        return false;
    }
  }

  private checkAssignable(target: CType, value: Expr, line: number, what: string): void {
    const vt = decay(value.cty ?? tInt);
    const tt = decay(target);
    if (isScalar(tt) && isScalar(vt)) return; // ints/pointers freely convert (lenient teaching rules)
    if (tt.kind === 'struct' && vt.kind === 'struct') return;
    if (isVoid(tt)) return;
    this.error(line, `cannot ${what} ${typeName(vt)} to ${typeName(tt)}`);
  }
}

function isCharArray(t: CType): boolean {
  return t.kind === 'array' && t.base?.kind === 'char';
}

export { BUILTINS };

// Re-export a small helper used by codegen for compound-assignment lowering type checks.
export type { BinOp };
