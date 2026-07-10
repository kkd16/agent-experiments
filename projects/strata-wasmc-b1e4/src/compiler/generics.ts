import { CompileError } from './diagnostics';
import type { Span } from './diagnostics';
import type {
  Block,
  Decl,
  ElemTy,
  Expr,
  FnDecl,
  Param,
  Program,
  Stmt,
  StructField,
  Ty,
} from './ast';
import {
  T_BOOL, T_F32, T_FLOAT, T_INT, T_LONG, T_NULL, T_STR, T_VOID,
  VEC_NAME_TO_LANES, laneTy, tyEqual, tyName,
} from './ast';

// ---------------------------------------------------------------------------
// Generics — parametric polymorphism by monomorphization.
//
// A *source→source* elaboration that runs BEFORE the type checker, IR builder,
// optimizer and backend. A generic function `fn max<T>(a: T, b: T) -> T` is a
// template; wherever it is *called*, this pass infers the concrete type
// arguments from the call's argument types, stamps out a specialised clone with
// the type parameters substituted (mangled to a fresh monomorphic name), and
// rewrites the call to it. The output is ordinary monomorphic Strata — no type
// parameters, no new IR, no new value representation — so the whole downstream
// pipeline (and the reference interpreter, and the from-scratch VM) is untouched
// and the three-engine differential oracle proves the result exactly as before.
//
// A monomorphizer bug therefore can only produce a concrete program the existing
// checker rejects (a loud compile error) or one the oracle flags — never a silent
// miscompile. Programs with no generic function hit the fast path below and are
// returned unchanged, so every existing program is provably unaffected.
//
// Instantiation is fully *inferred* from argument types (there is no turbofish
// `f<int>(…)` at call sites), which is why the only syntax added is the `<T, U>`
// list in a function header — a `T`, `T[]`, `fn(T)->U` in a signature already
// parses as an ordinary `{kind:'struct'}` reference the pass recognises here.
// ---------------------------------------------------------------------------

// Names that can never be a type parameter (they already denote a built-in type
// in a type position, so a parameter with that name could never be referenced).
const RESERVED_TY_NAMES = new Set<string>([
  'int', 'long', 'float', 'f32', 'bool', 'str', 'void',
  'int4', 'float4', 'long2', 'double2',
]);

// A guard so a genuinely unbounded polymorphic recursion (`fn f<T>() { f<T[]>() }`
// — each call at a strictly larger type) fails cleanly instead of hanging. Far
// above any real program's instantiation count.
const INSTANTIATION_CAP = 20000;

const isGeneric = (d: Decl): boolean => d.kind === 'fn' && !!d.typeParams && d.typeParams.length > 0;

// A lanewise comparison yields an integer mask vector of matching lane width
// (mirrors the checker's `maskShapeOf`).
function maskShapeOf(lanes: import('./ast').VecLanes): Ty {
  return lanes === 'i64x2' || lanes === 'f64x2' ? { kind: 'vec', lanes: 'i64x2' } : { kind: 'vec', lanes: 'i32x4' };
}

// Soft, user-overridable float-math builtins (see the checker). Recognised only
// when no user function of the same name shadows them.
const SOFT_MATH = new Set<string>([
  'sqrt', 'floor', 'ceil', 'trunc', 'round', 'abs', 'fmin', 'fmax', 'copysign',
  'exp', 'expm1', 'ln', 'log2', 'log10', 'log1p',
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh', 'cbrt',
  'pow', 'atan2', 'hypot', 'fmod',
]);
const STRING_RET: Record<string, Ty> = {
  repeat: T_STR, trim: T_STR, replace: T_STR, find: T_INT, contains: T_BOOL,
  starts_with: T_BOOL, ends_with: T_BOOL, parse_int: T_INT,
};

// A deep structural clone that preserves `bigint` literal values (which
// `structuredClone` also does, but this has zero environment dependency).
function deepClone<T>(x: T): T {
  if (x === null || typeof x !== 'object') return x;
  if (Array.isArray(x)) return x.map((e) => deepClone(e)) as unknown as T;
  const o: Record<string, unknown> = {};
  for (const k in x) o[k] = deepClone((x as Record<string, unknown>)[k]);
  return o as T;
}

// An ElemTy is a strict subset of Ty; for unification purposes a `T[]` element is
// treated as the equivalent Ty.
const elemToTy = (e: ElemTy): Ty => e as Ty;

class Monomorphizer {
  private genericFns = new Map<string, FnDecl>();
  private structFields = new Map<string, StructField[]>();
  private variants = new Map<string, { enumName: string; fields: Ty[] }>();
  private enums = new Set<string>();
  private fnSigs = new Map<string, { params: Ty[]; ret: Ty }>(); // concrete user functions
  private globals = new Map<string, Ty>();

  private emitted = new Map<string, FnDecl>(); // mangled → concrete clone
  private queue: FnDecl[] = [];
  private scopes: Map<string, Ty>[] = [];
  private prog: Program;

  constructor(prog: Program) { this.prog = prog; }

  run(): Program {
    // Collect declarations. Generic functions go to `genericFns` (never the
    // concrete-signature table), so an ordinary call never resolves to a template.
    for (const d of this.prog.decls) {
      if (d.kind === 'struct') this.structFields.set(d.name, d.fields);
      else if (d.kind === 'enum') {
        this.enums.add(d.name);
        for (const v of d.variants) this.variants.set(v.name, { enumName: d.name, fields: v.fields });
      }
    }
    for (const d of this.prog.decls) {
      if (d.kind === 'fn') {
        if (isGeneric(d)) {
          this.validateTemplate(d);
          if (this.genericFns.has(d.name))
            throw new CompileError(`duplicate generic function '${d.name}'`, d.span, 'type');
          this.genericFns.set(d.name, d);
        } else {
          this.fnSigs.set(d.name, { params: d.params.map((p) => p.ty), ret: d.retTy });
        }
      }
    }
    // Global types (inferred once; a body may read a global that holds a value).
    for (const d of this.prog.decls) {
      if (d.kind === 'global') this.globals.set(d.name, d.declTy ?? this.tryInfer(d.init));
    }

    // Roots: every concrete function body + every global initializer. Walking a
    // body resolves its generic calls (rewriting each callee to its instantiation)
    // and enqueues any newly-needed clone.
    for (const d of this.prog.decls) {
      if (d.kind === 'fn' && !isGeneric(d)) this.processFn(d);
      else if (d.kind === 'global') { this.scopes = [new Map()]; this.tryInfer(d.init); }
    }
    // Drain: each clone body is itself concrete, walked the same way, and may need
    // further instantiations (including the same template at a different type).
    while (this.queue.length > 0) this.processFn(this.queue.shift()!);

    // Assemble the output: drop the templates, keep everything else (with its
    // call sites now rewritten), then append every specialised clone.
    const decls: Decl[] = [];
    for (const d of this.prog.decls) {
      if (isGeneric(d)) continue;
      decls.push(d);
    }
    for (const clone of this.emitted.values()) decls.push(clone);
    return { decls };
  }

  private validateTemplate(d: FnDecl): void {
    if (d.name === 'main')
      throw new CompileError(`'main' cannot be generic (it is the entry point and is never called)`, d.span, 'type');
    for (const tp of d.typeParams!) {
      if (RESERVED_TY_NAMES.has(tp))
        throw new CompileError(`type parameter '${tp}' collides with a built-in type name`, d.span, 'type');
      if (tp.startsWith('__'))
        throw new CompileError(`type parameter names beginning with '__' are reserved`, d.span, 'type');
      if (this.structFields.has(tp) || this.enums.has(tp))
        throw new CompileError(`type parameter '${tp}' collides with a declared type '${tp}' — rename the parameter`, d.span, 'type');
    }
    // A parameter that is never referenced anywhere in the signature can never be
    // inferred from a call, so it would make the function un-instantiable.
    const used = new Set<string>();
    const scan = (t: Ty): void => {
      if (t.kind === 'struct' && d.typeParams!.includes(t.name)) used.add(t.name);
      else if (t.kind === 'array') scan(elemToTy(t.elem));
      else if (t.kind === 'fn') { t.params.forEach(scan); scan(t.ret); }
    };
    for (const p of d.params) scan(p.ty);
    for (const tp of d.typeParams!) {
      if (!used.has(tp))
        throw new CompileError(`type parameter '${tp}' of '${d.name}' is never used in a parameter type, so it can never be inferred — remove it or use it`, d.span, 'type');
    }
  }

  // --- monomorphization -----------------------------------------------------

  private processFn(fn: FnDecl): void {
    this.scopes = [new Map()];
    for (const p of fn.params) this.scopes[0].set(p.name, p.ty);
    this.inferBlock(fn.body);
  }

  // Resolve a call to a generic function: infer its argument types, unify to solve
  // every type parameter, rewrite the callee to the instantiation's mangled name,
  // enqueue the clone if new, and return the (substituted) result type.
  private resolveGeneric(e: Extract<Expr, { node: 'call' }>, tmpl: FnDecl): Ty {
    const argTys = e.args.map((a) => this.infer(a));
    if (tmpl.params.length !== argTys.length)
      throw new CompileError(`generic '${tmpl.name}' expects ${tmpl.params.length} argument(s), got ${argTys.length}`, e.span, 'type');
    const tvars = new Set(tmpl.typeParams);
    const map = new Map<string, Ty>();
    for (let i = 0; i < argTys.length; i++)
      this.unify(tmpl.params[i].ty, argTys[i], map, tvars, e.args[i].span);
    const typeArgs = tmpl.typeParams!.map((tp) => {
      const r = map.get(tp);
      if (!r)
        throw new CompileError(`cannot infer type parameter '${tp}' of generic function '${tmpl.name}' from its arguments`, e.span, 'type');
      return r;
    });
    const mangled = mangleName(tmpl.name, typeArgs);
    e.callee = mangled; // rewrite the call in place
    if (!this.emitted.has(mangled)) {
      if (this.emitted.size >= INSTANTIATION_CAP)
        throw new CompileError(`too many generic instantiations (> ${INSTANTIATION_CAP}) — a generic function is recursing at ever-larger types`, tmpl.span, 'type');
      const clone = this.specialize(tmpl, map, mangled);
      this.emitted.set(mangled, clone); // set before draining so recursion terminates
      this.queue.push(clone);
    }
    return substTy(tmpl.retTy, map, tmpl.span);
  }

  // Structural unification of a template parameter type (which may contain type
  // variables) against a concrete argument type. It only ever *binds* type
  // variables; a fixed-type leaf imposes no constraint (the real checker validates
  // the actual coercion later), so a legal coercion like `null → struct` is never
  // rejected here.
  private unify(p: Ty, a: Ty, map: Map<string, Ty>, tvars: Set<string>, span: Span): void {
    if (p.kind === 'struct' && tvars.has(p.name)) {
      if (a.kind === 'null') return; // a `null` argument can't pin a type parameter
      const prev = map.get(p.name);
      if (prev) {
        if (!tyEqual(prev, a))
          throw new CompileError(`type parameter '${p.name}' is used at conflicting types ${tyName(prev)} and ${tyName(a)}`, span, 'type');
      } else map.set(p.name, a);
      return;
    }
    if (p.kind === 'array' && a.kind === 'array') { this.unify(elemToTy(p.elem), elemToTy(a.elem), map, tvars, span); return; }
    if (p.kind === 'fn' && a.kind === 'fn') {
      if (p.params.length === a.params.length)
        for (let i = 0; i < p.params.length; i++) this.unify(p.params[i], a.params[i], map, tvars, span);
      this.unify(p.ret, a.ret, map, tvars, span);
    }
  }

  private specialize(tmpl: FnDecl, map: Map<string, Ty>, mangled: string): FnDecl {
    const params: Param[] = tmpl.params.map((p) => ({ name: p.name, ty: substTy(p.ty, map, p.span), span: p.span }));
    const retTy = substTy(tmpl.retTy, map, tmpl.span);
    const body = deepClone(tmpl.body);
    substBlockTypes(body, map);
    return { kind: 'fn', name: mangled, params, retTy, body, span: tmpl.span };
  }

  // --- a focused, inference-only type engine over CONCRETE bodies -----------
  // It mirrors the checker's type production, but never validates (the real
  // checker runs on the concrete output). Its only jobs are to type each
  // expression well enough to (a) resolve generic-call type arguments and (b) type
  // the locals those calls read.

  private push(): void { this.scopes.push(new Map()); }
  private pop(): void { this.scopes.pop(); }
  private declare(name: string, ty: Ty): void { this.scopes[this.scopes.length - 1].set(name, ty); }
  private lookup(name: string): Ty | undefined {
    for (let i = this.scopes.length - 1; i >= 0; i--) { const t = this.scopes[i].get(name); if (t) return t; }
    return undefined;
  }

  // Infer without letting a genuinely un-typeable expression abort elaboration —
  // used for global initializers, where a best-effort type is all we need.
  private tryInfer(e: Expr): Ty {
    try { return this.infer(e); } catch { return T_VOID; }
  }

  private inferBlock(b: Block): void {
    this.push();
    for (const s of b.stmts) this.inferStmt(s);
    this.pop();
  }

  private inferStmt(s: Stmt): void {
    switch (s.node) {
      case 'let': {
        // Walk the initializer once (resolving any generic call inside it), then
        // bind the name at its annotated or inferred type.
        const t = this.infer(s.init);
        this.declare(s.name, s.declTy ?? t);
        break;
      }
      case 'assign': this.infer(s.value); break;
      case 'index-assign': this.infer(s.target); this.infer(s.index); this.infer(s.value); break;
      case 'member-assign': this.infer(s.target); this.infer(s.value); break;
      case 'expr': this.infer(s.expr); break;
      case 'if':
        this.infer(s.cond); this.inferBlock(s.then);
        if (s.otherwise) this.inferBlock(s.otherwise);
        break;
      case 'while': this.infer(s.cond); this.inferBlock(s.body); break;
      case 'switch':
        this.infer(s.disc);
        for (const c of s.cases) this.inferBlock(c.body);
        if (s.default) this.inferBlock(s.default);
        break;
      case 'match': {
        const dt = this.infer(s.disc);
        for (const arm of s.arms) {
          this.push();
          if (arm.variant !== null) {
            const vs = this.variants.get(arm.variant);
            const fields = vs ? vs.fields : (dt.kind === 'enum' ? [] : []);
            arm.binds.forEach((b, i) => { if (b !== null && fields[i]) this.declare(b, fields[i]); });
          }
          this.inferBlock(arm.body);
          this.pop();
        }
        break;
      }
      case 'for': {
        this.push();
        if (s.init) this.inferStmt(s.init);
        if (s.cond) this.infer(s.cond);
        if (s.update) this.inferStmt(s.update);
        this.inferBlock(s.body);
        this.pop();
        break;
      }
      case 'return': if (s.value) this.infer(s.value); break;
      case 'block': this.inferBlock(s.block); break;
      case 'break': case 'continue': break;
    }
  }

  private infer(e: Expr): Ty {
    switch (e.node) {
      case 'int': return T_INT;
      case 'long': return T_LONG;
      case 'float': return T_FLOAT;
      case 'bool': return T_BOOL;
      case 'string': return T_STR;
      case 'null': return T_NULL;
      case 'ident': {
        const local = this.lookup(e.name); if (local) return local;
        const g = this.globals.get(e.name); if (g) return g;
        const nv = this.variants.get(e.name); if (nv && nv.fields.length === 0) return { kind: 'enum', name: nv.enumName };
        const f = this.fnSigs.get(e.name); if (f) return { kind: 'fn', params: f.params, ret: f.ret };
        if (this.genericFns.has(e.name))
          throw new CompileError(`cannot use generic function '${e.name}' as a value — call it directly, or wrap it in a monomorphic function first`, e.span, 'type');
        return T_VOID;
      }
      case 'member': {
        const t = this.infer(e.target);
        if (t.kind === 'struct') {
          const f = this.structFields.get(t.name)?.find((x) => x.name === e.field);
          if (f) return f.ty;
        }
        return T_VOID;
      }
      case 'index': {
        const t = this.infer(e.target); this.infer(e.index);
        if (t.kind === 'array') return elemToTy(t.elem);
        return T_INT; // string index → byte
      }
      case 'unary': {
        const t = this.infer(e.operand);
        if (e.op === '!') return T_BOOL;
        return t; // '-','+','~' preserve the operand type (incl. vectors)
      }
      case 'binary': return this.inferBinary(e);
      case 'ternary': { this.infer(e.cond); const a = this.infer(e.then); this.infer(e.otherwise); return a; }
      case 'call': return this.inferCall(e);
      case 'callptr': { const t = this.infer(e.target); e.args.forEach((a) => this.infer(a)); return t.kind === 'fn' ? t.ret : T_VOID; }
    }
  }

  private inferBinary(e: Extract<Expr, { node: 'binary' }>): Ty {
    const lt = this.infer(e.left);
    const rt = this.infer(e.right);
    switch (e.op) {
      case '<': case '<=': case '>': case '>=':
      case '==': case '!=': case '&&': case '||':
        return T_BOOL;
      case '+':
        if (lt.kind === 'str' || rt.kind === 'str') return T_STR;
        return lt.kind === 'void' ? rt : lt;
      default:
        return lt.kind === 'void' ? rt : lt; // arithmetic/bitwise/shift preserve operand type
    }
  }

  private inferCall(e: Extract<Expr, { node: 'call' }>): Ty {
    const name = e.callee;
    // An indirect call through a function-typed variable wins over any builtin.
    const variable = this.lookup(name) ?? this.globals.get(name);
    if (variable && variable.kind === 'fn') { e.args.forEach((a) => this.infer(a)); return variable.ret; }
    // A generic function call — resolve it (this rewrites the callee + enqueues).
    const tmpl = this.genericFns.get(name);
    if (tmpl) return this.resolveGeneric(e, tmpl);
    // Struct / variant construction.
    if (this.structFields.has(name)) { e.args.forEach((a) => this.infer(a)); return { kind: 'struct', name }; }
    const variant = this.variants.get(name);
    if (variant) { e.args.forEach((a) => this.infer(a)); return { kind: 'enum', name: variant.enumName }; }
    // Builtins (return types only) — argument walking still resolves nested calls.
    const b = this.builtinReturn(name, e.args);
    if (b) { e.args.forEach((a) => this.infer(a)); return b; }
    // Concrete user function.
    const sig = this.fnSigs.get(name);
    e.args.forEach((a) => this.infer(a));
    return sig ? sig.ret : T_VOID;
  }

  private builtinReturn(name: string, args: Expr[]): Ty | null {
    if (name in VEC_NAME_TO_LANES) return { kind: 'vec', lanes: VEC_NAME_TO_LANES[name] };
    switch (name) {
      case 'print': return T_VOID;
      case 'str': case 'char': case 'substr': case 'to_upper': case 'to_lower': return T_STR;
      case 'parse_float': return T_FLOAT;
      case 'index_of': case 'len': return T_INT;
      case 'int': return T_INT;
      case 'long': return T_LONG;
      case 'float': return T_FLOAT;
      case 'f32': return T_F32;
      case 'int_array': return { kind: 'array', elem: { kind: 'int' } };
      case 'long_array': return { kind: 'array', elem: { kind: 'long' } };
      case 'float_array': return { kind: 'array', elem: { kind: 'float' } };
      case 'f32_array': return { kind: 'array', elem: { kind: 'f32' } };
      case 'str_array': return { kind: 'array', elem: { kind: 'str' } };
      case 'struct_array': return { kind: 'array', elem: { kind: 'struct', name: '' } };
      case 'fn_array': return { kind: 'array', elem: { kind: 'fn', params: [], ret: T_VOID, hole: true } };
      case 'split': return { kind: 'array', elem: { kind: 'str' } };
      case 'join': return T_STR;
      case 'lane': case 'hsum': { const v = this.infer(args[0]); return v.kind === 'vec' ? laneTy(v.lanes) : T_INT; }
      case 'withlane': case 'vsqrt': case 'vabs': case 'vmin': case 'vmax': case 'vselect':
        { const v = this.infer(args[name === 'vselect' ? 1 : 0]); return v.kind === 'vec' ? v : T_INT; }
      case 'veq': case 'vne': case 'vlt': case 'vle': case 'vgt': case 'vge':
        { const v = this.infer(args[0]); return v.kind === 'vec' ? maskShapeOf(v.lanes) : T_INT; }
      case 'to_float4': return { kind: 'vec', lanes: 'f32x4' };
      case 'to_int4': return { kind: 'vec', lanes: 'i32x4' };
      case 'popcount': case 'clz': case 'ctz': case 'rotl': case 'rotr':
        { const t = this.infer(args[0]); return t.kind === 'long' ? T_LONG : T_INT; }
    }
    if (name in STRING_RET) return STRING_RET[name];
    // Soft math builtins: only when no user function shadows the name.
    if (SOFT_MATH.has(name) && !this.fnSigs.has(name) && !this.genericFns.has(name)) return T_FLOAT;
    return null;
  }
}

// --- type substitution (shared) ---------------------------------------------

function substTy(ty: Ty, map: Map<string, Ty>, span: Span): Ty {
  switch (ty.kind) {
    case 'struct': { const r = map.get(ty.name); return r ?? ty; }
    case 'array': return { kind: 'array', elem: substElem(ty.elem, map, span) };
    case 'fn': return { kind: 'fn', params: ty.params.map((t) => substTy(t, map, span)), ret: substTy(ty.ret, map, span) };
    default: return ty;
  }
}

function substElem(e: ElemTy, map: Map<string, Ty>, span: Span): ElemTy {
  if (e.kind === 'struct') {
    const r = map.get(e.name);
    if (!r) return e;
    switch (r.kind) {
      case 'int': case 'long': case 'float': case 'f32': case 'bool': case 'str': return r;
      case 'struct': case 'enum': return { kind: 'struct', name: r.name };
      case 'fn': return { kind: 'fn', params: r.params, ret: r.ret };
      default:
        throw new CompileError(`cannot build an array of ${tyName(r)} — ${r.kind === 'array' ? 'arrays of arrays' : r.kind === 'vec' ? 'arrays of SIMD vectors' : 'arrays of that type'} are not supported`, span, 'type');
    }
  }
  if (e.kind === 'fn') return { kind: 'fn', params: e.params.map((t) => substTy(t, map, span)), ret: substTy(e.ret, map, span), hole: e.hole };
  return e;
}

// The only Ty carried inside a function body is a `let`/`for`-init `declTy`.
function substBlockTypes(b: Block, map: Map<string, Ty>): void {
  for (const s of b.stmts) substStmtTypes(s, map);
}
function substStmtTypes(s: Stmt, map: Map<string, Ty>): void {
  switch (s.node) {
    case 'let': if (s.declTy) s.declTy = substTy(s.declTy, map, s.span); break;
    case 'if': substBlockTypes(s.then, map); if (s.otherwise) substBlockTypes(s.otherwise, map); break;
    case 'while': substBlockTypes(s.body, map); break;
    case 'switch': for (const c of s.cases) substBlockTypes(c.body, map); if (s.default) substBlockTypes(s.default, map); break;
    case 'match': for (const a of s.arms) substBlockTypes(a.body, map); break;
    case 'for': if (s.init) substStmtTypes(s.init, map); substBlockTypes(s.body, map); break;
    case 'block': substBlockTypes(s.block, map); break;
  }
}

// --- name mangling ----------------------------------------------------------
// A mangled instantiation name contains a `$` (and `_`), which no source
// identifier can — so it can never collide with a user function name.

function mangleName(name: string, typeArgs: Ty[]): string {
  return `${name}$${typeArgs.map(mangleTy).join('$')}`;
}
function mangleTy(t: Ty): string {
  switch (t.kind) {
    case 'int': case 'long': case 'float': case 'f32': case 'bool': case 'str': case 'void': case 'null': return t.kind;
    case 'struct': return `s_${t.name}`;
    case 'enum': return `e_${t.name}`;
    case 'array': return `arr_${mangleElemTy(t.elem)}`;
    case 'fn': return `fn_${t.params.map(mangleTy).join('_')}_to_${mangleTy(t.ret)}`;
    case 'vec': return t.lanes;
  }
}
function mangleElemTy(e: ElemTy): string { return mangleTy(elemToTy(e)); }

/**
 * Elaborate generics: replace every generic function with the concrete clones its
 * call sites require, and rewrite those call sites to the clones. Returns the
 * program unchanged (same object) when it declares no generic function.
 */
export function monomorphize(prog: Program): Program {
  if (!prog.decls.some(isGeneric)) return prog; // fast path — no generics, no work
  return new Monomorphizer(prog).run();
}
