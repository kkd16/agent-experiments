import { CompileError } from './diagnostics';
import type { Block, Expr, Program, Stmt, StructDecl, Ty } from './ast';

// A straightforward tree-walking interpreter. Its sole purpose is to be an
// independent oracle: the test harness runs every program through both this
// interpreter and the compiled WebAssembly and asserts the printed output is
// identical at every optimization level. Integer arithmetic mirrors wasm i32
// semantics (wrapping, truncating division, saturating float->int casts) so the
// two implementations agree bit-for-bit.

export type RtValue = number | bigint | ArrayVal | string | StructVal | null;
export interface ArrayVal {
  arr: true;
  elem: 'int' | 'long' | 'float' | 'str' | 'struct';
  // `int`/`float` arrays hold numbers; `long` arrays hold BigInts; `str` arrays
  // hold byte strings; `struct` arrays hold struct handles (StructVal or null).
  // A single union keeps the element accessors uniform.
  data: (number | bigint | string | StructVal | null)[];
}

// A struct value: a by-reference record. Two distinct constructions are distinct
// objects (so `==` — JS identity — disagrees), an aliased struct is the same
// object (so `==` agrees), and a mutation through one alias is seen through every
// alias — exactly the i32-handle-into-linear-memory semantics the wasm backend
// has. `null` is the struct handle that points nowhere (the JS value `null`).
export interface StructVal {
  struct: string;
  fields: Map<string, RtValue>;
}

// Strings are byte strings (Latin-1): every character is one byte. A JS string
// here is guaranteed to hold only code points 0..255 (the lexer enforces this on
// literals, and every runtime op below preserves it), so `.length` is the byte
// length and `charCodeAt` reads a byte — matching the wasm backend exactly.

export class Trap extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'Trap';
  }
}

// Signals used to unwind structured control flow.
const BREAK = Symbol('break');
const CONTINUE = Symbol('continue');
class ReturnSignal {
  readonly value: RtValue | undefined;
  constructor(value: RtValue | undefined) {
    this.value = value;
  }
}

export const i32 = (x: number): number => x | 0;
export const satTruncI32 = (x: number): number => {
  if (Number.isNaN(x)) return 0;
  if (x >= 2147483647) return 2147483647;
  if (x <= -2147483648) return -2147483648;
  return Math.trunc(x);
};

// 64-bit integer helpers — the `long` type is modeled as a BigInt with explicit
// `asIntN(64, …)` wrapping so it tracks wasm i64 bit-for-bit.
export const I64_MIN = -(2n ** 63n);
export const I64_MAX = 2n ** 63n - 1n;
export const asI64 = (x: bigint): bigint => BigInt.asIntN(64, x);
// Saturating f64 -> i64 truncation (wasm `i64.trunc_sat_f64_s`): NaN -> 0, and
// out-of-range magnitudes clamp to the i64 bounds instead of trapping.
export const satTruncI64 = (x: number): bigint => {
  if (Number.isNaN(x)) return 0n;
  if (x >= 9223372036854775808) return I64_MAX; // x >= 2^63
  if (x < -9223372036854775808) return I64_MIN; // x < -2^63
  return BigInt(Math.trunc(x));
};

export function formatInt(x: number): string {
  return String(i32(x));
}
export function formatLong(x: bigint): string {
  return String(asI64(x));
}

// Bit-manipulation primitives shared by the builtin library *and* the optimizer's
// constant folder, so the interpreter, SCCP and the real wasm op can never
// disagree. Each mirrors its wasm counterpart exactly (counts are over the
// unsigned bit pattern; rotate amounts are masked to the type's width).
export const popcnt32 = (x: number): number => { let v = x >>> 0; let c = 0; while (v) { c += v & 1; v >>>= 1; } return c; };
export const clz32 = (x: number): number => Math.clz32(x >>> 0);
export const ctz32 = (x: number): number => { let v = x >>> 0; if (v === 0) return 32; let c = 0; while ((v & 1) === 0) { c++; v >>>= 1; } return c; };
export const rotl32 = (a: number, b: number): number => { const n = b & 31; return n === 0 ? a | 0 : ((a << n) | (a >>> (32 - n))) | 0; };
export const rotr32 = (a: number, b: number): number => { const n = b & 31; return n === 0 ? a | 0 : ((a >>> n) | (a << (32 - n))) | 0; };
export const popcnt64 = (x: bigint): bigint => { let v = BigInt.asUintN(64, x); let c = 0n; while (v) { c += v & 1n; v >>= 1n; } return c; };
export const clz64 = (x: bigint): bigint => { const v = BigInt.asUintN(64, x); if (v === 0n) return 64n; let c = 0n; let bit = 1n << 63n; while ((v & bit) === 0n) { c++; bit >>= 1n; } return c; };
export const ctz64 = (x: bigint): bigint => { let v = BigInt.asUintN(64, x); if (v === 0n) return 64n; let c = 0n; while ((v & 1n) === 0n) { c++; v >>= 1n; } return c; };
export const rotl64 = (a: bigint, b: bigint): bigint => { const n = b & 63n; if (n === 0n) return asI64(a); const u = BigInt.asUintN(64, a); return asI64((u << n) | (u >> (64n - n))); };
export const rotr64 = (a: bigint, b: bigint): bigint => { const n = b & 63n; if (n === 0n) return asI64(a); const u = BigInt.asUintN(64, a); return asI64((u >> n) | (u << (64n - n))); };
export function formatFloat(x: number): string {
  if (Number.isNaN(x)) return 'nan';
  if (x === Infinity) return 'inf';
  if (x === -Infinity) return '-inf';
  // Match WebAssembly f64 -> string round-tripping by deferring to the engine.
  return Object.is(x, -0) ? '0' : String(x);
}
export function formatBool(x: number): string {
  return x !== 0 ? 'true' : 'false';
}

// Whitespace test matching the prelude's __is_ws: space (32) and \t\n\v\f\r.
const isWs = (c: number): boolean => c === 32 || (c >= 9 && c <= 13);

// --- f64 math helpers mirroring the wasm opcodes exactly ----------------------
const _dv = new DataView(new ArrayBuffer(8));
// Sign bit of a double (true = negative), read straight from the IEEE-754 bytes
// so it is correct for ±0 and ±NaN — matching wasm `f64.copysign`'s sign rule.
const signBit = (x: number): boolean => {
  _dv.setFloat64(0, x);
  return (_dv.getUint8(0) & 0x80) !== 0;
};
// wasm `f64.nearest`: round to the nearest integer, ties to even, preserving the
// sign of a zero result (JS `Math.round` is half-up and loses both properties).
export function nearestEven(x: number): number {
  if (!Number.isFinite(x)) return x; // ±Infinity, NaN pass through unchanged
  const fl = Math.floor(x);
  const diff = x - fl;
  let r: number;
  if (diff < 0.5) r = fl;
  else if (diff > 0.5) r = fl + 1;
  else r = fl % 2 === 0 ? fl : fl + 1; // exact tie -> even
  if (r === 0) return signBit(x) ? -0 : 0;
  return r;
}
// wasm `f64.copysign`: magnitude of `a`, sign of `b`.
const copysign = (a: number, b: number): number => {
  const mag = Math.abs(a);
  return signBit(b) ? -mag : mag;
};

// First index of `sub` in `s` at or after `from`, else -1 (empty needle -> from).
// Mirrors the prelude's __find_from byte-for-byte so the two never disagree.
function findFrom(s: string, sub: string, from: number): number {
  if (sub.length === 0) return from;
  for (let i = from; i + sub.length <= s.length; i++) {
    let j = 0;
    while (j < sub.length && s.charCodeAt(i + j) === sub.charCodeAt(j)) j++;
    if (j === sub.length) return i;
  }
  return -1;
}

interface Frame {
  vars: Map<string, RtValue>[];
}

export class Interpreter {
  private fns = new Map<string, Extract<Program['decls'][number], { kind: 'fn' }>>();
  private structs = new Map<string, StructDecl>();
  private globals = new Map<string, RtValue>();
  output: string[] = [];
  private steps = 0;
  private readonly stepLimit: number;

  constructor(prog: Program, stepLimit = 50_000_000) {
    this.stepLimit = stepLimit;
    for (const d of prog.decls) {
      if (d.kind === 'fn') this.fns.set(d.name, d);
      else if (d.kind === 'struct') this.structs.set(d.name, d);
    }
    for (const d of prog.decls) {
      if (d.kind === 'global') this.globals.set(d.name, this.evalConst(d.init));
    }
  }

  /** Evaluate a global initializer in an empty environment. */
  private evalConst(e: Expr): RtValue {
    const frame: Frame = { vars: [new Map()] };
    return this.evalExpr(e, frame);
  }

  run(entry = 'main', args: RtValue[] = []): RtValue | undefined {
    const fn = this.fns.get(entry);
    if (!fn) throw new Trap(`no function '${entry}'`);
    return this.call(fn, args);
  }

  private call(fn: Extract<Program['decls'][number], { kind: 'fn' }>, args: RtValue[]): RtValue | undefined {
    const frame: Frame = { vars: [new Map()] };
    fn.params.forEach((p, i) => frame.vars[0].set(p.name, args[i]));
    try {
      this.execBlock(fn.body, frame);
    } catch (sig) {
      if (sig instanceof ReturnSignal) return sig.value;
      throw sig;
    }
    return undefined;
  }

  private tick(): void {
    if (++this.steps > this.stepLimit) throw new Trap('step limit exceeded (possible infinite loop)');
  }

  private execBlock(b: Block, f: Frame): void {
    f.vars.push(new Map());
    try {
      for (const s of b.stmts) this.execStmt(s, f);
    } finally {
      f.vars.pop();
    }
  }

  private setVar(name: string, v: RtValue, f: Frame): void {
    for (let i = f.vars.length - 1; i >= 0; i--) {
      if (f.vars[i].has(name)) {
        f.vars[i].set(name, v);
        return;
      }
    }
    if (this.globals.has(name)) {
      this.globals.set(name, v);
      return;
    }
    throw new Trap(`assign to undefined '${name}'`);
  }
  private getVar(name: string, f: Frame): RtValue {
    for (let i = f.vars.length - 1; i >= 0; i--) {
      const v = f.vars[i].get(name);
      if (v !== undefined) return v;
    }
    const g = this.globals.get(name);
    if (g !== undefined) return g;
    throw new Trap(`read of undefined '${name}'`);
  }

  private execStmt(s: Stmt, f: Frame): void {
    this.tick();
    switch (s.node) {
      case 'let':
        f.vars[f.vars.length - 1].set(s.name, this.evalExpr(s.init, f));
        break;
      case 'assign':
        this.setVar(s.name, this.evalExpr(s.value, f), f);
        break;
      case 'index-assign': {
        const target = this.evalExpr(s.target, f) as ArrayVal;
        const idx = i32(this.evalExpr(s.index, f) as number);
        const val = this.evalExpr(s.value, f);
        if (idx < 0 || idx >= target.data.length) throw new Trap('array index out of bounds');
        if (target.elem === 'str') target.data[idx] = val as string;
        else if (target.elem === 'struct') target.data[idx] = val as StructVal | null;
        else if (target.elem === 'long') target.data[idx] = asI64(val as bigint);
        else target.data[idx] = target.elem === 'int' ? i32(val as number) : (val as number);
        break;
      }
      case 'member-assign': {
        const obj = this.evalExpr(s.target, f);
        if (obj === null) throw new Trap('field assignment on a null struct');
        const sv = obj as StructVal;
        const ft = this.fieldTy(sv.struct, s.field);
        sv.fields.set(s.field, normalizeField(this.evalExpr(s.value, f), ft));
        break;
      }
      case 'expr':
        this.evalExpr(s.expr, f);
        break;
      case 'if':
        if (this.evalExpr(s.cond, f)) this.execBlock(s.then, f);
        else if (s.otherwise) this.execBlock(s.otherwise, f);
        break;
      case 'while':
        while (this.evalExpr(s.cond, f)) {
          this.tick();
          try {
            this.execBlock(s.body, f);
          } catch (sig) {
            if (sig === BREAK) break;
            if (sig === CONTINUE) continue;
            throw sig;
          }
        }
        break;
      case 'switch': {
        const d = i32(this.evalExpr(s.disc, f) as number);
        let matched = false;
        for (const c of s.cases) {
          if (c.nums!.includes(d)) {
            this.execBlock(c.body, f);
            matched = true;
            break;
          }
        }
        if (!matched && s.default) this.execBlock(s.default, f);
        break;
      }
      case 'for': {
        f.vars.push(new Map());
        try {
          if (s.init) this.execStmt(s.init, f);
          while (s.cond ? this.evalExpr(s.cond, f) : true) {
            this.tick();
            try {
              this.execBlock(s.body, f);
            } catch (sig) {
              if (sig === BREAK) break;
              if (sig !== CONTINUE) throw sig;
            }
            if (s.update) this.execStmt(s.update, f);
          }
        } finally {
          f.vars.pop();
        }
        break;
      }
      case 'return':
        throw new ReturnSignal(s.value ? this.evalExpr(s.value, f) : undefined);
      case 'break':
        throw BREAK;
      case 'continue':
        throw CONTINUE;
      case 'block':
        this.execBlock(s.block, f);
        break;
    }
  }

  private evalExpr(e: Expr, f: Frame): RtValue {
    switch (e.node) {
      case 'int':
        return i32(e.value);
      case 'long':
        return asI64(e.value);
      case 'float':
        return e.value;
      case 'bool':
        return e.value ? 1 : 0;
      case 'string':
        return e.value;
      case 'null':
        return null;
      case 'member': {
        const obj = this.evalExpr(e.target, f);
        if (obj === null) throw new Trap('field access on a null struct');
        return (obj as StructVal).fields.get(e.field)!;
      }
      case 'ident':
        return this.getVar(e.name, f);
      case 'unary':
        return this.evalUnary(e, f);
      case 'binary':
        return this.evalBinary(e, f);
      case 'index': {
        const target = this.evalExpr(e.target, f);
        const idx = i32(this.evalExpr(e.index, f) as number);
        if (typeof target === 'string') {
          if (idx < 0 || idx >= target.length) throw new Trap('string index out of bounds');
          return target.charCodeAt(idx);
        }
        const arr = target as ArrayVal;
        if (idx < 0 || idx >= arr.data.length) throw new Trap('array index out of bounds');
        return arr.data[idx];
      }
      case 'call':
        return this.evalCall(e, f);
      case 'ternary':
        return this.evalExpr(e.cond, f) ? this.evalExpr(e.then, f) : this.evalExpr(e.otherwise, f);
    }
  }

  private evalUnary(e: Extract<Expr, { node: 'unary' }>, f: Frame): RtValue {
    if (e.operand.ty?.kind === 'long') {
      const v = this.evalExpr(e.operand, f) as bigint;
      switch (e.op) {
        case '-': return asI64(-v);
        case '+': return v;
        case '~': return asI64(~v);
        case '!': return v ? 0 : 1; // not type-valid, kept total
      }
    }
    const v = this.evalExpr(e.operand, f) as number;
    const isInt = e.operand.ty?.kind === 'int' || e.operand.ty?.kind === 'bool';
    switch (e.op) {
      case '-':
        return isInt ? i32(-v) : -v;
      case '+':
        return v;
      case '!':
        return v ? 0 : 1;
      case '~':
        return i32(~v);
    }
  }

  private evalBinary(e: Extract<Expr, { node: 'binary' }>, f: Frame): RtValue {
    // Short-circuit logical operators.
    if (e.op === '&&') return this.evalExpr(e.left, f) ? (this.evalExpr(e.right, f) ? 1 : 0) : 0;
    if (e.op === '||') return this.evalExpr(e.left, f) ? 1 : (this.evalExpr(e.right, f) ? 1 : 0);

    // Struct / null comparison: reference identity. Same object (or null===null)
    // is equal; two distinct constructions are not — matching wasm pointer
    // equality, where every construction bump-allocates a fresh, non-zero handle.
    if (e.op === '==' || e.op === '!=') {
      const lk = e.left.ty?.kind;
      const rk = e.right.ty?.kind;
      if (lk === 'struct' || lk === 'null' || rk === 'struct' || rk === 'null') {
        const a = this.evalExpr(e.left, f);
        const b = this.evalExpr(e.right, f);
        const eq = a === b;
        return (e.op === '==' ? eq : !eq) ? 1 : 0;
      }
    }

    // String operations (concatenation and equality).
    if (e.left.ty?.kind === 'str') {
      const sa = this.evalExpr(e.left, f) as string;
      const sb = this.evalExpr(e.right, f) as string;
      switch (e.op) {
        case '+': return sa + sb;
        case '==': return sa === sb ? 1 : 0;
        case '!=': return sa !== sb ? 1 : 0;
        case '<': return sa < sb ? 1 : 0;
        case '<=': return sa <= sb ? 1 : 0;
        case '>': return sa > sb ? 1 : 0;
        case '>=': return sa >= sb ? 1 : 0;
        default: throw new Trap(`unsupported string operator '${e.op}'`);
      }
    }

    if (e.left.ty?.kind === 'long') return this.evalLongBinary(e, f);

    const a = this.evalExpr(e.left, f) as number;
    const b = this.evalExpr(e.right, f) as number;
    const isInt = e.left.ty?.kind === 'int' || e.left.ty?.kind === 'bool';
    switch (e.op) {
      case '+':
        return isInt ? i32(a + b) : a + b;
      case '-':
        return isInt ? i32(a - b) : a - b;
      case '*':
        return isInt ? Math.imul(a, b) : a * b;
      case '/':
        if (isInt) {
          if (b === 0) throw new Trap('integer divide by zero');
          if (a === -2147483648 && b === -1) throw new Trap('integer overflow');
          return i32(Math.trunc(a / b));
        }
        return a / b;
      case '%':
        if (b === 0) throw new Trap('integer divide by zero');
        if (a === -2147483648 && b === -1) return 0;
        return i32(a % b);
      case '&':
        return i32(a & b);
      case '|':
        return i32(a | b);
      case '^':
        return i32(a ^ b);
      case '<<':
        return i32(a << (b & 31));
      case '>>':
        return i32(a >> (b & 31));
      case '<':
        return a < b ? 1 : 0;
      case '<=':
        return a <= b ? 1 : 0;
      case '>':
        return a > b ? 1 : 0;
      case '>=':
        return a >= b ? 1 : 0;
      case '==':
        return a === b ? 1 : 0;
      case '!=':
        return a !== b ? 1 : 0;
    }
  }

  // 64-bit integer arithmetic, mirroring wasm i64: wrapping add/sub/mul, signed
  // truncating division (with the `MIN/-1` overflow trap), sign-of-dividend
  // remainder, and shift counts masked to 6 bits. Comparisons yield 0/1 (i32).
  private evalLongBinary(e: Extract<Expr, { node: 'binary' }>, f: Frame): RtValue {
    const a = this.evalExpr(e.left, f) as bigint;
    const b = this.evalExpr(e.right, f) as bigint;
    switch (e.op) {
      case '+': return asI64(a + b);
      case '-': return asI64(a - b);
      case '*': return asI64(a * b);
      case '/':
        if (b === 0n) throw new Trap('integer divide by zero');
        if (a === I64_MIN && b === -1n) throw new Trap('integer overflow');
        return asI64(a / b);
      case '%':
        if (b === 0n) throw new Trap('integer divide by zero');
        if (a === I64_MIN && b === -1n) return 0n;
        return asI64(a % b);
      case '&': return asI64(a & b);
      case '|': return asI64(a | b);
      case '^': return asI64(a ^ b);
      case '<<': return asI64(a << (b & 63n));
      case '>>': return asI64(a >> (b & 63n));
      case '<': return a < b ? 1 : 0;
      case '<=': return a <= b ? 1 : 0;
      case '>': return a > b ? 1 : 0;
      case '>=': return a >= b ? 1 : 0;
      case '==': return a === b ? 1 : 0;
      case '!=': return a !== b ? 1 : 0;
      default: return 0;
    }
  }

  private evalCall(e: Extract<Expr, { node: 'call' }>, f: Frame): RtValue {
    const name = e.callee;
    // Strict left-to-right argument evaluation (no builtin is short-circuiting).
    const argv = e.args.map((a) => this.evalExpr(a, f));
    // A call to a struct name constructs a fresh record (a new object: distinct
    // from every other construction under `==`).
    const sd = this.structs.get(name);
    if (sd) {
      const fields = new Map<string, RtValue>();
      sd.fields.forEach((fld, i) => fields.set(fld.name, normalizeField(argv[i], fld.ty)));
      return { struct: name, fields };
    }
    // A user function shadows any *soft* builtin of the same name (e.g. a
    // hand-written `fn sqrt`); hard builtins can never be user-declared (they are
    // reserved), so they still fall through to `callBuiltin` below.
    const fn = this.fns.get(name);
    if (fn) {
      const r = this.call(fn, argv);
      return r === undefined ? 0 : r;
    }
    const argKinds = e.args.map((a) => a.ty?.kind);
    const b = callBuiltin(name, argv, argKinds, this.output);
    if (b.handled) return b.value;
    throw new Trap(`call to undefined '${name}'`);
  }

  private fieldTy(structName: string, field: string): Ty {
    const f = this.structs.get(structName)!.fields.find((x) => x.name === field)!;
    return f.ty;
  }
}

// Normalize a value to a struct field's declared type so a stored value reads
// back the same way the wasm load would (i32 wrap for int/bool, i64 wrap for
// long). Handles (str/array/struct/null) and floats pass through unchanged.
function normalizeField(v: RtValue, ty: Ty): RtValue {
  switch (ty.kind) {
    case 'int':
    case 'bool':
      return i32(v as number);
    case 'long':
      return asI64(v as bigint);
    default:
      return v;
  }
}

// The complete builtin library, evaluated over already-computed argument values
// and their static type kinds. Extracted so the tree-walking interpreter and the
// generator-based debugger share one implementation (and so can never disagree
// about a builtin). `print` appends to the supplied output sink. Returns
// `{ handled: false }` for a name that is not a builtin (i.e. a user function).
export interface BuiltinResult {
  handled: boolean;
  value: RtValue;
}
export function callBuiltin(
  name: string,
  argv: RtValue[],
  argKinds: (string | undefined)[],
  out: string[],
): BuiltinResult {
  const H = (value: RtValue): BuiltinResult => ({ handled: true, value });
  switch (name) {
    case 'print': {
      const k = argKinds[0];
      if (k === 'str') out.push(argv[0] as string);
      else if (k === 'long') out.push(formatLong(argv[0] as bigint));
      else {
        const v = argv[0] as number;
        out.push(k === 'float' ? formatFloat(v) : k === 'bool' ? formatBool(v) : formatInt(v));
      }
      return H(0);
    }
    case 'str': {
      const k = argKinds[0];
      if (k === 'str') return H(argv[0]);
      if (k === 'long') return H(formatLong(argv[0] as bigint));
      if (k === 'bool') return H(formatBool(argv[0] as number));
      return H(formatInt(argv[0] as number));
    }
    case 'char':
      return H(String.fromCharCode(i32(argv[0] as number) & 0xff));
    case 'substr': {
      const s = argv[0] as string;
      let start = i32(argv[1] as number);
      let count = i32(argv[2] as number);
      const n = s.length;
      if (start < 0) start = 0;
      if (start > n) start = n;
      if (count < 0) count = 0;
      if (start + count > n) count = n - start;
      return H(s.substr(start, count));
    }
    case 'index_of': {
      const s = argv[0] as string;
      const c = i32(argv[1] as number);
      for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === c) return H(i);
      return H(-1);
    }
    case 'to_upper':
    case 'to_lower': {
      const s = argv[0] as string;
      let r = '';
      for (let i = 0; i < s.length; i++) {
        let c = s.charCodeAt(i);
        if (name === 'to_upper' && c >= 97 && c <= 122) c -= 32;
        if (name === 'to_lower' && c >= 65 && c <= 90) c += 32;
        r += String.fromCharCode(c);
      }
      return H(r);
    }
    case 'repeat': {
      const s = argv[0] as string;
      let n = i32(argv[1] as number);
      if (n < 0) n = 0;
      return H(s.repeat(n));
    }
    case 'trim': {
      const s = argv[0] as string;
      let a = 0;
      let b = s.length;
      while (a < b && isWs(s.charCodeAt(a))) a++;
      while (b > a && isWs(s.charCodeAt(b - 1))) b--;
      return H(s.slice(a, b));
    }
    case 'find':
      return H(findFrom(argv[0] as string, argv[1] as string, 0));
    case 'contains':
      return H(findFrom(argv[0] as string, argv[1] as string, 0) >= 0 ? 1 : 0);
    case 'starts_with':
      return H((argv[0] as string).startsWith(argv[1] as string) ? 1 : 0);
    case 'ends_with':
      return H((argv[0] as string).endsWith(argv[1] as string) ? 1 : 0);
    case 'replace': {
      const s = argv[0] as string;
      const fnd = argv[1] as string;
      const repl = argv[2] as string;
      if (fnd.length === 0) return H(s);
      let r = '';
      let i = 0;
      for (;;) {
        const k = findFrom(s, fnd, i);
        if (k < 0) { r += s.slice(i); break; }
        r += s.slice(i, k) + repl;
        i = k + fnd.length;
      }
      return H(r);
    }
    case 'parse_int': {
      const s = argv[0] as string;
      let i = 0;
      let neg = false;
      if (i < s.length) {
        const c = s.charCodeAt(i);
        if (c === 45) { neg = true; i++; }
        else if (c === 43) { i++; }
      }
      let acc = 0;
      while (i < s.length) {
        const c = s.charCodeAt(i);
        if (c < 48 || c > 57) break;
        acc = i32(Math.imul(acc, 10) + (c - 48));
        i++;
      }
      return H(neg ? i32(-acc) : acc);
    }
    case 'int':
      if (argKinds[0] === 'float') return H(satTruncI32(argv[0] as number));
      if (argKinds[0] === 'long') return H(Number(BigInt.asIntN(32, argv[0] as bigint))); // wrap to low 32 bits
      return H(i32(argv[0] as number));
    case 'float':
      if (argKinds[0] === 'long') return H(Number(argv[0] as bigint)); // i64 -> f64, ties to even
      return H(argv[0] as number);
    case 'long':
      if (argKinds[0] === 'long') return H(asI64(argv[0] as bigint));
      if (argKinds[0] === 'float') return H(satTruncI64(argv[0] as number));
      return H(asI64(BigInt(i32(argv[0] as number)))); // int/bool widen, sign-extended
    case 'popcount':
      return H(argKinds[0] === 'long' ? popcnt64(argv[0] as bigint) : popcnt32(argv[0] as number));
    case 'clz':
      return H(argKinds[0] === 'long' ? clz64(argv[0] as bigint) : clz32(argv[0] as number));
    case 'ctz':
      return H(argKinds[0] === 'long' ? ctz64(argv[0] as bigint) : ctz32(argv[0] as number));
    case 'rotl':
      return H(argKinds[0] === 'long' ? rotl64(argv[0] as bigint, argv[1] as bigint) : rotl32(argv[0] as number, argv[1] as number));
    case 'rotr':
      return H(argKinds[0] === 'long' ? rotr64(argv[0] as bigint, argv[1] as bigint) : rotr32(argv[0] as number, argv[1] as number));
    // Soft float-math builtins (wasm f64 ops). JS `number` is an IEEE-754 double
    // evaluated round-to-nearest, so `Math.*` matches the wasm opcode bit-for-bit
    // (`Math.min`/`max` even agree on the signed-zero rule); `round` and
    // `copysign` use the helpers above for their sign/tie edge cases.
    case 'sqrt': return H(Math.sqrt(argv[0] as number));
    case 'floor': return H(Math.floor(argv[0] as number));
    case 'ceil': return H(Math.ceil(argv[0] as number));
    case 'trunc': return H(Math.trunc(argv[0] as number));
    case 'round': return H(nearestEven(argv[0] as number));
    case 'abs': return H(Math.abs(argv[0] as number));
    case 'fmin': return H(Math.min(argv[0] as number, argv[1] as number));
    case 'fmax': return H(Math.max(argv[0] as number, argv[1] as number));
    case 'copysign': return H(copysign(argv[0] as number, argv[1] as number));
    case 'int_array':
    case 'long_array':
    case 'float_array':
    case 'str_array': {
      const n = i32(argv[0] as number);
      if (n < 0) throw new Trap('negative array length');
      if (name === 'str_array') return H({ arr: true, elem: 'str', data: new Array(n).fill('') });
      if (name === 'long_array') return H({ arr: true, elem: 'long', data: new Array(n).fill(0n) });
      return H({ arr: true, elem: name === 'int_array' ? 'int' : 'float', data: new Array(n).fill(0) });
    }
    case 'struct_array': {
      const n = i32(argv[0] as number);
      if (n < 0) throw new Trap('negative array length');
      return H({ arr: true, elem: 'struct', data: new Array(n).fill(null) });
    }
    case 'split': {
      const s = argv[0] as string;
      const sep = argv[1] as string;
      const data: string[] = [];
      if (sep.length === 0) data.push(s);
      else {
        let start = 0;
        for (;;) {
          const k = findFrom(s, sep, start);
          if (k < 0) { data.push(s.slice(start)); break; }
          data.push(s.slice(start, k));
          start = k + sep.length;
        }
      }
      return H({ arr: true, elem: 'str', data });
    }
    case 'join':
      return H(((argv[0] as ArrayVal).data as string[]).join(argv[1] as string));
    case 'len': {
      const v = argv[0];
      return H(typeof v === 'string' ? v.length : (v as ArrayVal).data.length);
    }
    default:
      return { handled: false, value: 0 };
  }
}

export function interpret(prog: Program, entry = 'main'): { output: string[]; result: RtValue | undefined; error?: string } {
  const interp = new Interpreter(prog);
  try {
    const result = interp.run(entry);
    return { output: interp.output, result };
  } catch (e) {
    if (e instanceof Trap) return { output: interp.output, result: undefined, error: e.message };
    if (e instanceof CompileError) throw e;
    return { output: interp.output, result: undefined, error: String(e) };
  }
}
