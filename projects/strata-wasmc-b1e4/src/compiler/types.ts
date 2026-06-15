import { CompileError } from './diagnostics';
import type {
  BinaryOp,
  Block,
  Expr,
  Program,
  ScalarTy,
  Stmt,
  StructDecl,
  Ty,
} from './ast';
import { T_BOOL, T_F32, T_FLOAT, T_INT, T_LONG, T_NULL, T_STR, T_VOID, tyEqual, tyName } from './ast';

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
  /** every declared `struct`, keyed by name (preserves field order) */
  structs: Map<string, StructDecl>;
}

// Builtins available without declaration. `print`/`int`/`float` are special-
// cased because they accept multiple argument types; array intrinsics return
// handles into linear memory.
const ARRAY_INTRINSICS = new Set(['int_array', 'long_array', 'float_array', 'f32_array', 'str_array', 'struct_array', 'len']);
const STR_BUILTINS = new Set([
  'str', 'char', 'substr', 'index_of', 'to_upper', 'to_lower',
  'repeat', 'trim', 'replace', 'find', 'contains', 'starts_with', 'ends_with', 'parse_int',
  'parse_float', 'split', 'join',
]);
// Bit-manipulation builtins that map 1:1 to wasm integer ops. `popcount`/`clz`/
// `ctz` are unary; `rotl`/`rotr` are binary. All work on `int` (i32) and `long`
// (i64), returning the operand's own type.
const BIT_BUILTINS = new Set(['popcount', 'clz', 'ctz', 'rotl', 'rotr']);
// Floating-point math builtins (each maps 1:1 to a wasm f64 op). Unlike the
// builtins above these are **soft**: they are only recognized when the program
// does *not* declare a function of the same name, so a user is free to write
// their own `fn sqrt(...)` (the `newton` example does exactly that). The unary
// group is f64 -> f64; the binary group is (f64, f64) -> f64. `round` is
// round-half-to-even (wasm `f64.nearest`), not the half-up of many languages.
const FLOAT_UNARY = new Set(['sqrt', 'floor', 'ceil', 'trunc', 'round', 'abs']);
const FLOAT_BINARY = new Set(['fmin', 'fmax', 'copysign']);
// Transcendental math builtins. They share the soft-builtin rules above (each is
// `float -> float` / `(float,float) -> float` and yields to a user `fn` of the
// same name), but instead of a single wasm op they lower to a call into the
// shared MATH_PRELUDE kernel, which the interpreter runs too (see interp.ts).
const MATH_UNARY = new Set([
  'exp', 'expm1', 'ln', 'log2', 'log10', 'log1p',
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan',
  'sinh', 'cosh', 'tanh', 'cbrt',
]);
const MATH_BINARY = new Set(['pow', 'atan2', 'hypot', 'fmod']);

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
  // Save / restore the bump-allocator top, so a runtime function can free all of
  // its own transient scratch on the way out (used by the float format/parse).
  __heap_get: { params: [], ret: 'int' },
  __heap_set: { params: ['int'], ret: 'void' },
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

// Names that may never be used for a `struct` (they already mean something as a
// builtin, a primitive type, or a reserved conversion). Keeps the constructor
// call `Name(...)` unambiguous.
const RESERVED_NAMES = new Set<string>([
  'print', 'str', 'char', 'int', 'float', 'f32', 'long', 'len',
  'int_array', 'long_array', 'float_array', 'f32_array', 'str_array',
  'bool', 'void',
]);

class Checker {
  syms: SymbolTable = { functions: new Map(), globals: new Map(), structs: new Map() };
  private scope = new Scope();
  private retTy: Ty = T_VOID;
  private loopDepth = 0;
  private lowLevel: boolean;
  constructor(lowLevel = false) {
    this.lowLevel = lowLevel;
  }

  check(prog: Program): SymbolTable {
    // Pass 0: collect struct names (so field types and constructors can refer to
    // any struct, including forward / mutually-recursive references), then
    // validate each struct's fields once every name is known.
    for (const d of prog.decls) {
      if (d.kind === 'struct') {
        if (!this.lowLevel && d.name.startsWith('__'))
          throw new CompileError(`names beginning with '__' are reserved`, d.span, 'type');
        if (RESERVED_NAMES.has(d.name) || ARRAY_INTRINSICS.has(d.name) || STR_BUILTINS.has(d.name) || BIT_BUILTINS.has(d.name))
          throw new CompileError(`'${d.name}' is a reserved name and cannot name a struct`, d.span, 'type');
        if (this.syms.structs.has(d.name))
          throw new CompileError(`duplicate struct '${d.name}'`, d.span, 'type');
        this.syms.structs.set(d.name, d);
      }
    }
    for (const d of prog.decls) {
      if (d.kind === 'struct') this.checkStructDecl(d);
    }
    // Pass 1: collect signatures so functions can be mutually recursive.
    for (const d of prog.decls) {
      if (d.kind === 'fn') {
        if (!this.lowLevel && d.name.startsWith('__'))
          throw new CompileError(`names beginning with '__' are reserved`, d.span, 'type');
        if (this.syms.functions.has(d.name) || this.syms.structs.has(d.name) || ARRAY_INTRINSICS.has(d.name) || STR_BUILTINS.has(d.name) || BIT_BUILTINS.has(d.name) || d.name === 'print' || d.name === 'long')
          throw new CompileError(`duplicate or reserved function name '${d.name}'`, d.span, 'type');
        for (const p of d.params) this.validateTy(p.ty, p.span);
        this.validateTy(d.retTy, d.span);
        this.syms.functions.set(d.name, { params: d.params.map((p) => p.ty), ret: d.retTy });
      }
    }
    // Pass 2: globals (constant initializers, no forward references to globals).
    for (const d of prog.decls) {
      if (d.kind === 'global') {
        if (d.declTy) this.validateTy(d.declTy, d.span);
        const t = this.checkExpr(d.init);
        const declared = d.declTy ?? t;
        if (d.declTy && !this.coercible(t, d.declTy))
          throw new CompileError(`global '${d.name}' declared ${tyName(d.declTy)} but initialized with ${tyName(t)}`, d.span, 'type');
        if (declared.kind === 'void') throw new CompileError(`global '${d.name}' cannot be void`, d.span, 'type');
        if (declared.kind === 'null') throw new CompileError(`global '${d.name}' needs an explicit struct type for its null value (e.g. \`let ${d.name}: T = null;\`)`, d.span, 'type');
        if (declared.kind === 'array' && declared.elem.kind === 'struct' && declared.elem.name === '')
          throw new CompileError(`struct_array(...) needs an explicit element type — annotate the global`, d.span, 'type');
        if (declared.kind === 'struct' && d.init.node !== 'null')
          throw new CompileError(`a struct-typed global must be initialized with null (struct construction is not a constant)`, d.span, 'type');
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

  // A type annotation is valid if every struct it names has been declared. (The
  // parser turns any unknown type name into a `struct` reference, so this is
  // where a typo like `: Pont` surfaces as a precise error.)
  private validateTy(ty: Ty, span: import('./diagnostics').Span): void {
    if (ty.kind === 'struct' && !this.syms.structs.has(ty.name))
      throw new CompileError(`unknown type '${ty.name}'`, span, 'type');
    if (ty.kind === 'array' && ty.elem.kind === 'struct' && ty.elem.name !== '' && !this.syms.structs.has(ty.elem.name))
      throw new CompileError(`unknown type '${ty.elem.name}'`, span, 'type');
  }

  private checkStructDecl(d: StructDecl): void {
    const seen = new Set<string>();
    for (const f of d.fields) {
      if (seen.has(f.name))
        throw new CompileError(`duplicate field '${f.name}' in struct '${d.name}'`, f.span, 'type');
      seen.add(f.name);
      if (f.ty.kind === 'void')
        throw new CompileError(`struct field '${f.name}' cannot be void`, f.span, 'type');
      this.validateTy(f.ty, f.span);
    }
  }

  private checkBlock(b: Block): void {
    this.scope.push();
    for (const s of b.stmts) this.checkStmt(s);
    this.scope.pop();
  }

  private checkStmt(s: Stmt): void {
    switch (s.node) {
      case 'let': {
        if (s.declTy) this.validateTy(s.declTy, s.span);
        const t = this.checkExpr(s.init);
        const declared = s.declTy ?? t;
        if (s.declTy && !this.coercible(t, s.declTy))
          throw new CompileError(`'${s.name}' declared ${tyName(s.declTy)} but initialized with ${tyName(t)}`, s.span, 'type');
        if (declared.kind === 'void') throw new CompileError(`'${s.name}' cannot be void`, s.span, 'type');
        if (declared.kind === 'null') throw new CompileError(`'${s.name}' needs an explicit struct type for its null value (e.g. \`let ${s.name}: T = null;\`)`, s.span, 'type');
        if (declared.kind === 'array' && declared.elem.kind === 'struct' && declared.elem.name === '')
          throw new CompileError(`struct_array(...) needs an explicit element type — annotate the variable (e.g. \`let ${s.name}: T[] = struct_array(n);\`)`, s.span, 'type');
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
      case 'member-assign': {
        const ft = this.fieldType(this.checkExpr(s.target), s.field, s.span);
        const vt = this.checkExpr(s.value);
        if (!this.coercible(vt, ft))
          throw new CompileError(`cannot store ${tyName(vt)} into field '${s.field}' of type ${tyName(ft)}`, s.span, 'type');
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

  // The declared type of `obj.field`. `obj` must be a struct that has `field`.
  private fieldType(objTy: Ty, field: string, span: import('./diagnostics').Span): Ty {
    if (objTy.kind !== 'struct')
      throw new CompileError(`type ${tyName(objTy)} has no fields`, span, 'type');
    const def = this.syms.structs.get(objTy.name)!;
    const f = def.fields.find((x) => x.name === field);
    if (!f) throw new CompileError(`struct '${objTy.name}' has no field '${field}'`, span, 'type');
    return f.ty;
  }

  // `coercible` is intentionally strict: Strata performs no implicit numeric
  // conversions. The one exception is `null`, which is assignable to any struct
  // type (it is the struct handle that points nowhere).
  private coercible(from: Ty, to: Ty): boolean {
    if (from.kind === 'null' && to.kind === 'struct') return true;
    // `struct_array(n)` (a placeholder `T[]` with the empty element name) fills
    // any concrete struct-array slot once an annotation names the element.
    if (
      from.kind === 'array' && to.kind === 'array' &&
      from.elem.kind === 'struct' && to.elem.kind === 'struct' && from.elem.name === ''
    )
      return true;
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
      case 'long':
        return T_LONG;
      case 'float':
        return T_FLOAT;
      case 'bool':
        return T_BOOL;
      case 'string':
        return T_STR;
      case 'null':
        return T_NULL;
      case 'member':
        return this.fieldType(this.checkExpr(e.target), e.field, e.span);
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
        if (t.kind === 'int' || t.kind === 'long' || t.kind === 'float' || t.kind === 'f32') return t;
        throw new CompileError(`unary '${e.op}' requires a numeric operand, found ${tyName(t)}`, e.span, 'type');
      case '!':
        if (t.kind === 'bool') return T_BOOL;
        throw new CompileError(`'!' requires a bool operand, found ${tyName(t)}`, e.span, 'type');
      case '~':
        if (t.kind === 'int' || t.kind === 'long') return t;
        throw new CompileError(`'~' requires an int or long operand, found ${tyName(t)}`, e.span, 'type');
    }
  }

  private checkBinary(e: Extract<Expr, { node: 'binary' }>): Ty {
    const op: BinaryOp = e.op;
    const lt = this.checkExpr(e.left);
    const rt = this.checkExpr(e.right);
    const sameNumeric = (lt.kind === 'int' || lt.kind === 'long' || lt.kind === 'float' || lt.kind === 'f32') && tyEqual(lt, rt);

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
        if (lt.kind === 'long' && rt.kind === 'long') return T_LONG;
        throw new CompileError(`'${op}' requires matching int or long operands, found ${tyName(lt)} and ${tyName(rt)}`, e.span, 'type');
      case '<':
      case '<=':
      case '>':
      case '>=':
        if (sameNumeric) return T_BOOL;
        if (lt.kind === 'str' && rt.kind === 'str') return T_BOOL; // lexicographic
        throw new CompileError(`'${op}' requires matching numeric or string operands, found ${tyName(lt)} and ${tyName(rt)}`, e.span, 'type');
      case '==':
      case '!=': {
        // Struct handles (and `null`) compare by reference identity.
        const refKind = (t: Ty): boolean => t.kind === 'struct' || t.kind === 'null';
        if (refKind(lt) && refKind(rt)) {
          if (lt.kind === 'struct' && rt.kind === 'struct' && !tyEqual(lt, rt))
            throw new CompileError(`'${op}' compares unrelated struct types ${tyName(lt)} and ${tyName(rt)}`, e.span, 'type');
          return T_BOOL;
        }
        if (tyEqual(lt, rt) && lt.kind !== 'void' && lt.kind !== 'array') return T_BOOL;
        throw new CompileError(`'${op}' requires matching scalar operands, found ${tyName(lt)} and ${tyName(rt)}`, e.span, 'type');
      }
      case '&&':
      case '||':
        if (lt.kind === 'bool' && rt.kind === 'bool') return T_BOOL;
        throw new CompileError(`'${op}' requires bool operands, found ${tyName(lt)} and ${tyName(rt)}`, e.span, 'type');
    }
  }

  private checkCall(e: Extract<Expr, { node: 'call' }>): Ty {
    const name = e.callee;
    // A call to a struct name is a constructor: positional arguments fill the
    // declared fields in order and the result is a fresh struct value.
    const structDef = this.syms.structs.get(name);
    if (structDef) {
      if (e.args.length !== structDef.fields.length)
        throw new CompileError(`struct '${name}' has ${structDef.fields.length} field(s) but got ${e.args.length} argument(s)`, e.span, 'type');
      structDef.fields.forEach((f, i) => {
        const at = this.checkExpr(e.args[i]);
        if (!this.coercible(at, f.ty))
          throw new CompileError(`field '${f.name}' of '${name}' expects ${tyName(f.ty)}, got ${tyName(at)}`, e.args[i].span, 'type');
      });
      return { kind: 'struct', name };
    }
    // builtins
    // Low-level float bit-reinterpretation intrinsics (prelude only): expose the
    // raw IEEE-754 representation of a double to the float-format runtime.
    if (this.lowLevel && (name === '__f64_bits' || name === '__f64_from_bits')) {
      if (e.args.length !== 1) throw new CompileError(`${name}() expects 1 argument`, e.span, 'type');
      const t = this.checkExpr(e.args[0]);
      if (name === '__f64_bits') {
        if (t.kind !== 'float') throw new CompileError(`${name}() expects a float`, e.args[0].span, 'type');
        return T_LONG;
      }
      if (t.kind !== 'long') throw new CompileError(`${name}() expects a long`, e.args[0].span, 'type');
      return T_FLOAT;
    }
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
      if (t.kind !== 'int' && t.kind !== 'long' && t.kind !== 'float' && t.kind !== 'f32' && t.kind !== 'bool' && t.kind !== 'str')
        throw new CompileError(`print expects a scalar or string, found ${tyName(t)}`, e.span, 'type');
      return T_VOID;
    }
    if (name === 'str') {
      if (e.args.length !== 1) throw new CompileError('str() expects 1 argument', e.span, 'type');
      const t = this.checkExpr(e.args[0]);
      if (t.kind !== 'int' && t.kind !== 'long' && t.kind !== 'float' && t.kind !== 'f32' && t.kind !== 'bool' && t.kind !== 'str')
        throw new CompileError(`str() expects an int, long, float, f32, bool, or str, found ${tyName(t)}`, e.span, 'type');
      return T_STR;
    }
    if (name === 'char') {
      if (e.args.length !== 1) throw new CompileError('char() expects 1 argument', e.span, 'type');
      const t = this.checkExpr(e.args[0]);
      if (t.kind !== 'int') throw new CompileError(`char() expects an int, found ${tyName(t)}`, e.span, 'type');
      return T_STR;
    }
    if (name === 'parse_float') {
      if (e.args.length !== 1) throw new CompileError('parse_float() expects 1 argument', e.span, 'type');
      const t = this.checkExpr(e.args[0]);
      if (t.kind !== 'str') throw new CompileError(`parse_float() expects a str, found ${tyName(t)}`, e.args[0].span, 'type');
      return T_FLOAT;
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
    if (name === 'popcount' || name === 'clz' || name === 'ctz') {
      if (e.args.length !== 1) throw new CompileError(`${name}() expects 1 argument`, e.span, 'type');
      const t = this.checkExpr(e.args[0]);
      if (t.kind !== 'int' && t.kind !== 'long') throw new CompileError(`${name}() expects an int or long, found ${tyName(t)}`, e.args[0].span, 'type');
      return t.kind === 'long' ? T_LONG : T_INT;
    }
    if (name === 'rotl' || name === 'rotr') {
      if (e.args.length !== 2) throw new CompileError(`${name}() expects (value, amount)`, e.span, 'type');
      const t0 = this.checkExpr(e.args[0]);
      const t1 = this.checkExpr(e.args[1]);
      if (!((t0.kind === 'int' && t1.kind === 'int') || (t0.kind === 'long' && t1.kind === 'long')))
        throw new CompileError(`${name}() expects two matching int or long operands, found ${tyName(t0)} and ${tyName(t1)}`, e.span, 'type');
      return t0.kind === 'long' ? T_LONG : T_INT;
    }
    // Soft float-math builtins: recognized only when no user function shadows the
    // name. Every operand and the result are `float` (f64).
    if ((FLOAT_UNARY.has(name) || FLOAT_BINARY.has(name) || MATH_UNARY.has(name) || MATH_BINARY.has(name)) && !this.syms.functions.has(name)) {
      const arity = FLOAT_UNARY.has(name) || MATH_UNARY.has(name) ? 1 : 2;
      if (e.args.length !== arity) throw new CompileError(`${name}() expects ${arity} argument(s)`, e.span, 'type');
      for (const a of e.args) {
        const t = this.checkExpr(a);
        if (t.kind !== 'float') throw new CompileError(`${name}() expects float argument(s), found ${tyName(t)}`, a.span, 'type');
      }
      return T_FLOAT;
    }
    if (name === 'int' || name === 'float' || name === 'f32' || name === 'long') {
      if (e.args.length !== 1) throw new CompileError(`${name}() expects 1 argument`, e.span, 'type');
      const t = this.checkExpr(e.args[0]);
      if (t.kind !== 'int' && t.kind !== 'long' && t.kind !== 'float' && t.kind !== 'f32' && t.kind !== 'bool')
        throw new CompileError(`${name}() expects a numeric argument, found ${tyName(t)}`, e.span, 'type');
      return name === 'int' ? T_INT : name === 'long' ? T_LONG : name === 'f32' ? T_F32 : T_FLOAT;
    }
    if (name === 'int_array' || name === 'long_array' || name === 'float_array' || name === 'f32_array' || name === 'str_array') {
      if (e.args.length !== 1) throw new CompileError(`${name}() expects a length`, e.span, 'type');
      const t = this.checkExpr(e.args[0]);
      if (t.kind !== 'int') throw new CompileError(`${name}() length must be int`, e.span, 'type');
      const elem: ScalarTy =
        name === 'int_array' ? { kind: 'int' }
        : name === 'long_array' ? { kind: 'long' }
        : name === 'float_array' ? { kind: 'float' }
        : name === 'f32_array' ? { kind: 'f32' }
        : { kind: 'str' };
      return { kind: 'array', elem };
    }
    if (name === 'struct_array') {
      // A null-filled array of struct handles. Its concrete element struct is
      // fixed by the annotation on the variable it is assigned to (the empty
      // name `''` is the placeholder until then).
      if (e.args.length !== 1) throw new CompileError(`struct_array() expects a length`, e.span, 'type');
      const t = this.checkExpr(e.args[0]);
      if (t.kind !== 'int') throw new CompileError(`struct_array() length must be int`, e.span, 'type');
      return { kind: 'array', elem: { kind: 'struct', name: '' } };
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
