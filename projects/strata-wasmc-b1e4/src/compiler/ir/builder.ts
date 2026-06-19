import type { BinaryOp, Block, Expr, Program, Stmt, Ty } from '../ast';
import type { ConstNum, IRType, RetType } from './ir';
import { parse } from '../parser';
import { typecheck } from '../types';
import { STRING_PRELUDE, FLOAT_PRELUDE, MATH_PRELUDE } from './prelude';
import type { StructLayout } from '../struct';
import { computeLayouts } from '../struct';

// Stage 1 of lowering: the typed AST is translated into a control-flow graph of
// basic blocks where local variables are still referenced *by name* and may be
// assigned more than once ("pre-SSA"). Stage 2 (ssa.ts) renames these into pure
// SSA with phi nodes. Keeping the two stages separate makes both far simpler.

export type POperand = { tag: 'var'; name: string } | { tag: 'const'; ty: IRType; num: ConstNum };

export interface PInst {
  dest: string | null;
  ty: RetType;
  kind: import('./ir').InstKind;
  sub: string;
  args: POperand[];
}

export type PTerm =
  | { op: 'br'; target: number }
  | { op: 'condbr'; cond: POperand; t: number; f: number }
  | { op: 'ret'; value: POperand | null }
  | { op: 'unreachable' };

export interface PBlock {
  id: number;
  insts: PInst[];
  term: PTerm | null;
  preds: number[];
}

export interface PFunc {
  name: string;
  params: { name: string; ty: IRType }[];
  retTy: RetType;
  blocks: PBlock[];
  entry: number;
  varType: Map<string, IRType>;
  exported: boolean;
}

export interface PModule {
  funcs: PFunc[];
  globals: { name: string; ty: IRType; init: ConstNum; mutable: boolean }[];
  usesMemory: boolean;
  memPages: number;
  staticData?: { offset: number; bytes: number[] };
}

export const HEAP_GLOBAL = '__hp';
const ARRAY_HEADER = 8; // bytes reserved before element data (length word + padding)
const MEM_PAGES = 256; // 16 MiB linear memory
const STR_DATA_BASE = 16; // static string data starts here; the heap follows it

// Interns string literals into a single static data segment. Each entry is laid
// out exactly like a runtime string/array object — an 8-byte header whose first
// word is the byte length, followed by the (Latin-1) bytes — so `len`, indexing
// and the string runtime treat literals and heap strings uniformly. Identical
// literals are deduplicated, so `"x" == "x"` is even a pointer-equal fast path.
export class StringPool {
  private map = new Map<string, number>();
  readonly bytes: number[] = [];
  used = false;

  intern(s: string): number {
    this.used = true;
    const hit = this.map.get(s);
    if (hit !== undefined) return hit;
    while (this.bytes.length % 8 !== 0) this.bytes.push(0); // 8-byte align each entry
    const off = STR_DATA_BASE + this.bytes.length;
    const n = s.length;
    this.bytes.push(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff, 0, 0, 0, 0);
    for (let i = 0; i < s.length; i++) this.bytes.push(s.charCodeAt(i) & 0xff);
    this.map.set(s, off);
    return off;
  }

  heapStart(): number {
    return (STR_DATA_BASE + this.bytes.length + 7) & ~7;
  }
}

function irTypeOf(t: Ty): IRType {
  switch (t.kind) {
    case 'float':
      return 'f64';
    case 'f32':
      return 'f32';
    case 'long':
      return 'i64';
    default:
      return 'i32'; // int, bool, and array handles are all i32
  }
}
function retTypeOf(t: Ty): RetType {
  return t.kind === 'void' ? 'void' : irTypeOf(t);
}

const VAR = (name: string): POperand => ({ tag: 'var', name });
const CI = (n: number): POperand => ({ tag: 'const', ty: 'i32', num: n | 0 });
const CL = (n: bigint): POperand => ({ tag: 'const', ty: 'i64', num: BigInt.asIntN(64, n) });

// String builtins that lower 1:1 to a prelude function `__<name>` taking string
// pointers / ints and returning an i32. The result's user-visible type (str/int/
// bool) is decided by the type checker; at the IR level it is always i32.
const STRING_HELPERS = new Set([
  'substr', 'index_of', 'to_upper', 'to_lower',
  'repeat', 'trim', 'replace', 'find', 'contains', 'starts_with', 'ends_with', 'parse_int',
  'split', 'join',
]);

// Soft float-math builtins (overridable by a user function of the same name).
// The unary group lowers to a single-operand f64 "cast" opcode; the binary group
// to an `fbin`. `round` is wasm `f64.nearest` (round-half-to-even).
const FLOAT_UNARY_SUB: Record<string, string> = {
  sqrt: 'f_sqrt', floor: 'f_floor', ceil: 'f_ceil', trunc: 'f_trunc', round: 'f_nearest', abs: 'f_abs',
};
const FLOAT_BINARY_SUB: Record<string, string> = { fmin: 'min', fmax: 'max', copysign: 'copysign' };

// Transcendental math builtins. Unlike the single-op floats above, each lowers to
// a call into the MATH_PRELUDE kernel `__<name>` (injected on demand, like the
// string / float-format runtimes) and returns f64.
const MATH_UNARY = new Set([
  'exp', 'expm1', 'ln', 'log2', 'log10', 'log1p',
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan',
  'sinh', 'cosh', 'tanh', 'cbrt',
]);
const MATH_BINARY = new Set(['pow', 'atan2', 'hypot', 'fmod']);

class FnBuilder {
  blocks: PBlock[] = [];
  varType = new Map<string, IRType>();
  usesMemory = false;
  usesStrings = false;
  usesFloatFmt = false;
  usesMath = false;
  private cur!: PBlock;
  private blockCounter = 0;
  private tempCounter = 0;
  private uniqueCounter = 0;
  private scopes: Map<string, string>[] = [];
  private loops: { brk: number; cont: number }[] = [];
  private name: string;
  private params: { name: string; ty: IRType }[];
  private retTy: RetType;
  private body: Block;
  private exported: boolean;
  private pool: StringPool;
  private layouts: Map<string, StructLayout>;
  private userFns: Set<string>;

  constructor(name: string, params: { name: string; ty: IRType }[], retTy: RetType, body: Block, exported: boolean, pool: StringPool, layouts: Map<string, StructLayout>, userFns: Set<string>) {
    this.name = name;
    this.params = params;
    this.retTy = retTy;
    this.body = body;
    this.exported = exported;
    this.pool = pool;
    this.layouts = layouts;
    this.userFns = userFns;
  }

  build(): { fn: PFunc; usesMemory: boolean; usesStrings: boolean; usesFloatFmt: boolean; usesMath: boolean } {
    const entry = this.newBlock();
    this.cur = entry;
    this.scopes = [new Map()];
    // Bind parameters to unique SSA base names so each declaration is distinct.
    this.params = this.params.map((p) => ({ name: this.declareRaw(p.name, p.ty), ty: p.ty }));
    this.lowerBlock(this.body);
    // Implicit return at the end of the body if control falls through.
    if (this.cur.term === null) {
      if (this.retTy === 'void') this.setTerm({ op: 'ret', value: null });
      else this.setTerm({ op: 'ret', value: { tag: 'const', ty: this.retTy, num: 0 } });
    }
    this.computePreds();
    const fn: PFunc = {
      name: this.name,
      params: this.params,
      retTy: this.retTy,
      blocks: this.blocks,
      entry: entry.id,
      varType: this.varType,
      exported: this.exported,
    };
    return { fn, usesMemory: this.usesMemory, usesStrings: this.usesStrings, usesFloatFmt: this.usesFloatFmt, usesMath: this.usesMath };
  }

  // --- block & scope plumbing ---

  private newBlock(): PBlock {
    const b: PBlock = { id: this.blockCounter++, insts: [], term: null, preds: [] };
    this.blocks.push(b);
    return b;
  }
  private setTerm(t: PTerm): void {
    if (this.cur.term === null) this.cur.term = t;
  }
  private switchTo(b: PBlock): void {
    this.cur = b;
  }
  private temp(ty: IRType): string {
    const n = `%${this.tempCounter++}`;
    this.varType.set(n, ty);
    return n;
  }
  private declare(name: string, ty: Ty): string {
    return this.declareRaw(name, irTypeOf(ty));
  }
  private declareRaw(name: string, ty: IRType): string {
    const u = `${name}.${this.uniqueCounter++}`;
    this.scopes[this.scopes.length - 1].set(name, u);
    this.varType.set(u, ty);
    return u;
  }
  private resolve(name: string): string | null {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const u = this.scopes[i].get(name);
      if (u) return u;
    }
    return null;
  }
  private emit(inst: PInst): void {
    if (this.cur.term !== null) {
      // Unreachable code after a terminator: route it into a dead block.
      this.switchTo(this.newBlock());
    }
    this.cur.insts.push(inst);
  }
  private def(ty: IRType, kind: PInst['kind'], sub: string, args: POperand[]): POperand {
    const dest = this.temp(ty);
    this.emit({ dest, ty, kind, sub, args });
    return VAR(dest);
  }

  // --- statements ---

  private lowerBlock(b: Block): void {
    this.scopes.push(new Map());
    for (const s of b.stmts) this.lowerStmt(s);
    this.scopes.pop();
  }

  private lowerStmt(s: Stmt): void {
    switch (s.node) {
      case 'let': {
        const v = this.lowerExpr(s.init)!;
        const u = this.declare(s.name, s.resolvedTy!);
        this.emit({ dest: u, ty: irTypeOf(s.resolvedTy!), kind: 'copy', sub: '', args: [v] });
        break;
      }
      case 'assign': {
        const v = this.lowerExpr(s.value)!;
        const u = this.resolve(s.name);
        if (u) {
          this.emit({ dest: u, ty: this.varType.get(u)!, kind: 'copy', sub: '', args: [v] });
        } else {
          this.emit({ dest: null, ty: 'void', kind: 'gset', sub: s.name, args: [v] });
        }
        break;
      }
      case 'index-assign': {
        const addr = this.elemAddr(s.target, s.index);
        const v = this.lowerExpr(s.value)!;
        const elem = this.arrayElemIR(s.target);
        this.emit({ dest: null, ty: 'void', kind: 'store', sub: elem, args: [addr, v] });
        break;
      }
      case 'member-assign': {
        const fl = this.fieldLayout(s.target, s.field);
        const addr = this.fieldAddr(s.target, fl.offset);
        const v = this.lowerExpr(s.value)!;
        this.emit({ dest: null, ty: 'void', kind: 'store', sub: fl.irType, args: [addr, v] });
        break;
      }
      case 'expr':
        this.lowerExpr(s.expr);
        break;
      case 'if':
        this.lowerIf(s);
        break;
      case 'while':
        this.lowerWhile(s);
        break;
      case 'switch':
        this.lowerSwitch(s);
        break;
      case 'for':
        this.lowerFor(s);
        break;
      case 'return':
        this.setTerm({ op: 'ret', value: s.value ? this.lowerExpr(s.value)! : null });
        break;
      case 'break':
        if (this.loops.length) this.setTerm({ op: 'br', target: this.loops[this.loops.length - 1].brk });
        break;
      case 'continue':
        if (this.loops.length) this.setTerm({ op: 'br', target: this.loops[this.loops.length - 1].cont });
        break;
      case 'block':
        this.lowerBlock(s.block);
        break;
    }
  }

  private lowerIf(s: Extract<Stmt, { node: 'if' }>): void {
    const cond = this.lowerExpr(s.cond)!;
    const thenB = this.newBlock();
    const elseB = s.otherwise ? this.newBlock() : null;
    const join = this.newBlock();
    this.setTerm({ op: 'condbr', cond, t: thenB.id, f: (elseB ?? join).id });

    this.switchTo(thenB);
    this.lowerBlock(s.then);
    this.setTerm({ op: 'br', target: join.id });

    if (elseB) {
      this.switchTo(elseB);
      this.lowerBlock(s.otherwise!);
      this.setTerm({ op: 'br', target: join.id });
    }
    this.switchTo(join);
  }

  private lowerWhile(s: Extract<Stmt, { node: 'while' }>): void {
    const header = this.newBlock();
    this.setTerm({ op: 'br', target: header.id });
    this.switchTo(header);
    const cond = this.lowerExpr(s.cond)!;
    const bodyB = this.newBlock();
    const exit = this.newBlock();
    this.setTerm({ op: 'condbr', cond, t: bodyB.id, f: exit.id });

    this.switchTo(bodyB);
    this.loops.push({ brk: exit.id, cont: header.id });
    this.lowerBlock(s.body);
    this.loops.pop();
    this.setTerm({ op: 'br', target: header.id });

    this.switchTo(exit);
  }

  // switch lowers to a chain of equality tests (no fallthrough). The
  // discriminant is evaluated once into a temp; each case tests `disc == label`
  // (OR-ed for multi-label cases), branching to the case body or the next test.
  private lowerSwitch(s: Extract<Stmt, { node: 'switch' }>): void {
    const dv = this.temp('i32');
    const d = this.lowerExpr(s.disc)!;
    this.emit({ dest: dv, ty: 'i32', kind: 'copy', sub: '', args: [d] });

    const join = this.newBlock();
    const bodies = s.cases.map(() => this.newBlock());
    const dflt = s.default ? this.newBlock() : null;

    s.cases.forEach((c, i) => {
      const nums = c.nums!;
      let cond = this.def('i32', 'icmp', 'eq', [VAR(dv), CI(nums[0])]);
      for (let k = 1; k < nums.length; k++) {
        const c2 = this.def('i32', 'icmp', 'eq', [VAR(dv), CI(nums[k])]);
        cond = this.def('i32', 'ibin', 'or', [cond, c2]);
      }
      const next = i + 1 < s.cases.length ? this.newBlock() : (dflt ?? join);
      this.setTerm({ op: 'condbr', cond, t: bodies[i].id, f: next.id });
      this.switchTo(next);
    });
    // If there were no cases, `cur` is still the block after the discriminant.
    if (s.cases.length === 0) this.setTerm({ op: 'br', target: (dflt ?? join).id });

    if (dflt) {
      // After the last test we are positioned in `dflt`.
      this.switchTo(dflt);
      this.lowerBlock(s.default!);
      this.setTerm({ op: 'br', target: join.id });
    }

    s.cases.forEach((c, i) => {
      this.switchTo(bodies[i]);
      this.lowerBlock(c.body);
      this.setTerm({ op: 'br', target: join.id });
    });

    this.switchTo(join);
  }

  private lowerFor(s: Extract<Stmt, { node: 'for' }>): void {
    this.scopes.push(new Map());
    if (s.init) this.lowerStmt(s.init);
    const header = this.newBlock();
    this.setTerm({ op: 'br', target: header.id });
    this.switchTo(header);
    const cond = s.cond ? this.lowerExpr(s.cond)! : CI(1);
    const bodyB = this.newBlock();
    const contB = this.newBlock(); // where `continue` and fallthrough run the update
    const exit = this.newBlock();
    this.setTerm({ op: 'condbr', cond, t: bodyB.id, f: exit.id });

    this.switchTo(bodyB);
    this.loops.push({ brk: exit.id, cont: contB.id });
    this.lowerBlock(s.body);
    this.loops.pop();
    this.setTerm({ op: 'br', target: contB.id });

    this.switchTo(contB);
    if (s.update) this.lowerStmt(s.update);
    this.setTerm({ op: 'br', target: header.id });

    this.switchTo(exit);
    this.scopes.pop();
  }

  // --- expressions ---

  private lowerExpr(e: Expr): POperand | null {
    switch (e.node) {
      case 'int':
        return CI(e.value);
      case 'long':
        return CL(e.value);
      case 'bool':
        return CI(e.value ? 1 : 0);
      case 'float':
        return { tag: 'const', ty: 'f64', num: e.value };
      case 'string': {
        // A string literal lowers to a constant pointer into the static data
        // segment (the interned object's address).
        this.usesStrings = true;
        this.usesMemory = true;
        return CI(this.pool.intern(e.value));
      }
      case 'ident': {
        const u = this.resolve(e.name);
        if (u) return VAR(u);
        // A bare function name (not a local/param) is a function pointer: emit its
        // table slot as an i32. (The checker has already typed it as `fn(…)`.)
        if (e.ty!.kind === 'fn') return this.def('i32', 'funcaddr', e.name, []);
        return this.def(irTypeOf(e.ty!), 'gget', e.name, []);
      }
      case 'unary':
        return this.lowerUnary(e);
      case 'binary':
        return this.lowerBinary(e);
      case 'index': {
        if (e.target.ty!.kind === 'str') {
          // string[i] — read the i-th byte (unsigned) at base + header + i.
          this.usesMemory = true;
          const base = this.lowerExpr(e.target)!;
          const idx = this.lowerExpr(e.index)!;
          const dataStart = this.def('i32', 'ibin', 'add', [base, CI(ARRAY_HEADER)]);
          const addr = this.def('i32', 'ibin', 'add', [dataStart, idx]);
          return this.def('i32', 'load', 'i8', [addr]);
        }
        const addr = this.elemAddr(e.target, e.index);
        const elem = this.arrayElemIR(e.target);
        return this.def(elem, 'load', elem, [addr]);
      }
      case 'member': {
        const fl = this.fieldLayout(e.target, e.field);
        const addr = this.fieldAddr(e.target, fl.offset);
        return this.def(fl.irType, 'load', fl.irType, [addr]);
      }
      case 'null':
        // The struct handle that points nowhere.
        return CI(0);
      case 'call':
        return this.lowerCall(e);
      case 'callptr':
        return this.lowerIndirect(this.lowerExpr(e.target)!, e.target.ty as Extract<Ty, { kind: 'fn' }>, e.args);
      case 'ternary':
        return this.lowerTernary(e);
    }
  }

  private lowerTernary(e: Extract<Expr, { node: 'ternary' }>): POperand {
    const ty = irTypeOf(e.ty!);
    const res = this.temp(ty);
    const cond = this.lowerExpr(e.cond)!;
    const thenB = this.newBlock();
    const elseB = this.newBlock();
    const join = this.newBlock();
    this.setTerm({ op: 'condbr', cond, t: thenB.id, f: elseB.id });

    this.switchTo(thenB);
    const tv = this.lowerExpr(e.then)!;
    this.emit({ dest: res, ty, kind: 'copy', sub: '', args: [tv] });
    this.setTerm({ op: 'br', target: join.id });

    this.switchTo(elseB);
    const ev = this.lowerExpr(e.otherwise)!;
    this.emit({ dest: res, ty, kind: 'copy', sub: '', args: [ev] });
    this.setTerm({ op: 'br', target: join.id });

    this.switchTo(join);
    return VAR(res);
  }

  private lowerUnary(e: Extract<Expr, { node: 'unary' }>): POperand {
    const v = this.lowerExpr(e.operand)!;
    const ity = irTypeOf(e.operand.ty!);
    switch (e.op) {
      case '+':
        return v;
      case '-':
        if (ity === 'f64' || ity === 'f32') return this.def(ity, 'fbin', 'sub', [{ tag: 'const', ty: ity, num: 0 }, v]);
        return ity === 'i64'
          ? this.def('i64', 'ibin', 'sub', [CL(0n), v])
          : this.def('i32', 'ibin', 'sub', [CI(0), v]);
      case '!':
        return this.def('i32', 'icmp', 'eq', [v, CI(0)]);
      case '~':
        return ity === 'i64'
          ? this.def('i64', 'ibin', 'xor', [v, CL(-1n)])
          : this.def('i32', 'ibin', 'xor', [v, CI(-1)]);
    }
  }

  private lowerBinary(e: Extract<Expr, { node: 'binary' }>): POperand {
    if (e.op === '&&' || e.op === '||') return this.lowerShortCircuit(e);
    // String operators dispatch to the runtime helpers (written in Strata).
    if (e.left.ty!.kind === 'str') {
      this.usesStrings = true;
      this.usesMemory = true;
      const a = this.lowerExpr(e.left)!;
      const b = this.lowerExpr(e.right)!;
      if (e.op === '+') return this.def('i32', 'call', '__strcat', [a, b]);
      if (e.op === '==') return this.def('i32', 'call', '__streq', [a, b]);
      if (e.op === '!=') return this.def('i32', 'icmp', 'eq', [this.def('i32', 'call', '__streq', [a, b]), CI(0)]);
      // Ordering: __strcmp returns a sign; compare it against 0.
      const cmp = this.def('i32', 'call', '__strcmp', [a, b]);
      const sub: Record<string, string> = { '<': 'lt_s', '<=': 'le_s', '>': 'gt_s', '>=': 'ge_s' };
      return this.def('i32', 'icmp', sub[e.op], [cmp, CI(0)]);
    }
    const a = this.lowerExpr(e.left)!;
    const b = this.lowerExpr(e.right)!;
    // `i32` and `i64` share the same integer opcode names; the backend selects the
    // concrete wasm op from the operand value type, so one `ity` covers both.
    const ity = irTypeOf(e.left.ty!);
    const isInt = ity !== 'f64' && ity !== 'f32';
    const op: BinaryOp = e.op;
    const intArith: Partial<Record<BinaryOp, string>> = {
      '+': 'add', '-': 'sub', '*': 'mul', '/': 'div_s', '%': 'rem_s',
      '&': 'and', '|': 'or', '^': 'xor', '<<': 'shl', '>>': 'shr_s',
    };
    const floatArith: Partial<Record<BinaryOp, string>> = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'div' };
    const icmp: Partial<Record<BinaryOp, string>> = {
      '==': 'eq', '!=': 'ne', '<': 'lt_s', '<=': 'le_s', '>': 'gt_s', '>=': 'ge_s',
    };
    const fcmp: Partial<Record<BinaryOp, string>> = {
      '==': 'eq', '!=': 'ne', '<': 'lt', '<=': 'le', '>': 'gt', '>=': 'ge',
    };
    if (op === '==' || op === '!=' || op === '<' || op === '<=' || op === '>' || op === '>=') {
      return isInt ? this.def('i32', 'icmp', icmp[op]!, [a, b]) : this.def('i32', 'fcmp', fcmp[op]!, [a, b]);
    }
    if (isInt) return this.def(ity, 'ibin', intArith[op]!, [a, b]);
    return this.def(ity, 'fbin', floatArith[op]!, [a, b]);
  }

  private lowerShortCircuit(e: Extract<Expr, { node: 'binary' }>): POperand {
    const res = this.temp('i32');
    const left = this.lowerExpr(e.left)!;
    const rhsB = this.newBlock();
    const shortB = this.newBlock();
    const join = this.newBlock();
    if (e.op === '&&') this.setTerm({ op: 'condbr', cond: left, t: rhsB.id, f: shortB.id });
    else this.setTerm({ op: 'condbr', cond: left, t: shortB.id, f: rhsB.id });

    this.switchTo(rhsB);
    const r = this.lowerExpr(e.right)!;
    this.emit({ dest: res, ty: 'i32', kind: 'copy', sub: '', args: [r] });
    this.setTerm({ op: 'br', target: join.id });

    this.switchTo(shortB);
    this.emit({ dest: res, ty: 'i32', kind: 'copy', sub: '', args: [CI(e.op === '&&' ? 0 : 1)] });
    this.setTerm({ op: 'br', target: join.id });

    this.switchTo(join);
    return VAR(res);
  }

  // Lower an indirect call (`call_indirect`): evaluate the call arguments, then
  // dispatch through the function-pointer operand. The signature key lets the
  // backend intern the wasm type the indirect call references.
  private lowerIndirect(target: POperand, fnTy: Extract<Ty, { kind: 'fn' }>, argExprs: Expr[]): POperand | null {
    const params = fnTy.params.map(irTypeOf);
    const ret = retTypeOf(fnTy.ret);
    const sigKey = params.join(',') + '->' + ret;
    const args: POperand[] = [target, ...argExprs.map((a) => this.lowerExpr(a)!)];
    if (ret === 'void') {
      this.emit({ dest: null, ty: 'void', kind: 'callind', sub: sigKey, args });
      return null;
    }
    return this.def(ret, 'callind', sigKey, args);
  }

  private lowerCall(e: Extract<Expr, { node: 'call' }>): POperand | null {
    const name = e.callee;
    // An indirect call through a function-typed variable named `name` (the checker
    // flagged it). The function pointer is the variable's i32 value.
    if (e.indirect) {
      const target = this.lowerExpr({ node: 'ident', name, ty: e.fnTy, span: e.span } as Expr)!;
      return this.lowerIndirect(target, e.fnTy as Extract<Ty, { kind: 'fn' }>, e.args);
    }
    // A call to a struct name constructs a value: bump-allocate the record and
    // store each (left-to-right evaluated) argument at its field offset.
    if (this.layouts.has(name)) return this.lowerStructNew(name, e.args);
    // Low-level memory intrinsics used by the string-runtime prelude.
    if (name === '__load8' || name === '__load32') {
      this.usesMemory = true;
      return this.def('i32', 'load', name === '__load8' ? 'i8' : 'i32', [this.lowerExpr(e.args[0])!]);
    }
    if (name === '__store8' || name === '__store32') {
      this.usesMemory = true;
      const p = this.lowerExpr(e.args[0])!;
      const v = this.lowerExpr(e.args[1])!;
      this.emit({ dest: null, ty: 'void', kind: 'store', sub: name === '__store8' ? 'i8' : 'i32', args: [p, v] });
      return null;
    }
    if (name === '__alloc') {
      return this.lowerAllocBytes(this.lowerExpr(e.args[0])!);
    }
    // Bump-allocator top save/restore (the heap pointer is a global).
    if (name === '__heap_get') {
      this.usesMemory = true;
      return this.def('i32', 'gget', HEAP_GLOBAL, []);
    }
    if (name === '__heap_set') {
      this.usesMemory = true;
      this.emit({ dest: null, ty: 'void', kind: 'gset', sub: HEAP_GLOBAL, args: [this.lowerExpr(e.args[0])!] });
      return null;
    }
    // Float bit-reinterpretation intrinsics (prelude only).
    if (name === '__f64_bits') return this.def('i64', 'cast', 'reinterp_f2l', [this.lowerExpr(e.args[0])!]);
    if (name === '__f64_from_bits') return this.def('f64', 'cast', 'reinterp_l2f', [this.lowerExpr(e.args[0])!]);
    if (name === 'print') {
      let v = this.lowerExpr(e.args[0])!;
      const k = e.args[0].ty!.kind;
      if (k === 'str') { this.usesStrings = true; this.usesMemory = true; }
      // An f32 promotes losslessly to f64 and reuses the float print import.
      if (k === 'f32') v = this.def('f64', 'cast', 'f32_2f', [v]);
      const psub = k === 'float' || k === 'f32' ? 'float' : k === 'long' ? 'long' : k === 'bool' ? 'bool' : k === 'str' ? 'str' : 'int';
      this.emit({ dest: null, ty: 'void', kind: 'print', sub: psub, args: [v] });
      return null;
    }
    if (name === 'str') {
      const k = e.args[0].ty!.kind;
      let v = this.lowerExpr(e.args[0])!;
      if (k === 'str') return v; // identity
      this.usesStrings = true;
      this.usesMemory = true;
      if (k === 'float' || k === 'f32') {
        // The float formatter is its own (large) prelude, pulled in only here.
        // An f32 promotes losslessly to f64 first, so str(f32) shows the exact
        // value the single-precision number represents.
        if (k === 'f32') v = this.def('f64', 'cast', 'f32_2f', [v]);
        this.usesFloatFmt = true;
        return this.def('i32', 'call', '__float_to_str', [v]);
      }
      const helper = k === 'bool' ? '__bool_to_str' : k === 'long' ? '__long_to_str' : '__int_to_str';
      return this.def('i32', 'call', helper, [v]);
    }
    if (name === 'char') {
      this.usesStrings = true;
      this.usesMemory = true;
      return this.def('i32', 'call', '__char', [this.lowerExpr(e.args[0])!]);
    }
    if (name === 'parse_float') {
      // Correctly-rounded string -> double: lives in the float prelude (reuses the
      // big-integer library), returns f64.
      this.usesStrings = true;
      this.usesMemory = true;
      this.usesFloatFmt = true;
      return this.def('f64', 'call', '__parse_float', [this.lowerExpr(e.args[0])!]);
    }
    if (STRING_HELPERS.has(name)) {
      // Every extended string helper is a prelude function `__<name>` returning
      // an i32 (a string pointer, an int index, or a 0/1 bool).
      this.usesStrings = true;
      this.usesMemory = true;
      const args = e.args.map((a) => this.lowerExpr(a)!);
      return this.def('i32', 'call', '__' + name, args);
    }
    if (name === 'popcount' || name === 'clz' || name === 'ctz') {
      const ity = irTypeOf(e.args[0].ty!);
      const v = this.lowerExpr(e.args[0])!;
      return this.def(ity, 'iunary', name === 'popcount' ? 'popcnt' : name, [v]);
    }
    if (name === 'rotl' || name === 'rotr') {
      const ity = irTypeOf(e.args[0].ty!);
      const a = this.lowerExpr(e.args[0])!;
      const b = this.lowerExpr(e.args[1])!;
      return this.def(ity, 'ibin', name, [a, b]);
    }
    if (name === 'int') {
      const k = e.args[0].ty!.kind;
      const v = this.lowerExpr(e.args[0])!;
      if (k === 'float') return this.def('i32', 'cast', 'f2i', [v]);
      if (k === 'f32') return this.def('i32', 'cast', 'f32_2i', [v]);
      if (k === 'long') return this.def('i32', 'cast', 'l2i', [v]);
      return v; // int/bool are already i32
    }
    if (name === 'float') {
      const k = e.args[0].ty!.kind;
      const v = this.lowerExpr(e.args[0])!;
      if (k === 'float') return v;
      if (k === 'f32') return this.def('f64', 'cast', 'f32_2f', [v]); // promote
      if (k === 'long') return this.def('f64', 'cast', 'l2f', [v]);
      return this.def('f64', 'cast', 'i2f', [v]);
    }
    if (name === 'f32') {
      const k = e.args[0].ty!.kind;
      const v = this.lowerExpr(e.args[0])!;
      if (k === 'f32') return v;
      if (k === 'float') return this.def('f32', 'cast', 'f2f32', [v]); // demote
      if (k === 'long') return this.def('f32', 'cast', 'l2f32', [v]);
      return this.def('f32', 'cast', 'i2f32', [v]); // int/bool -> f32
    }
    if (name === 'long') {
      const k = e.args[0].ty!.kind;
      const v = this.lowerExpr(e.args[0])!;
      if (k === 'long') return v;
      if (k === 'float') return this.def('i64', 'cast', 'f2l', [v]);
      if (k === 'f32') return this.def('i64', 'cast', 'f32_2l', [v]);
      return this.def('i64', 'cast', 'i2l', [v]); // int/bool widen with sign extend
    }
    if (name === 'int_array' || name === 'long_array' || name === 'float_array' || name === 'f32_array' || name === 'str_array') {
      // A `str[]` is an array of i32 string pointers. Its elements are left as
      // zero, which the runtime reads as a pointer to address 0 — whose length
      // word lives in the reserved [0,16) region and is always 0, i.e. the empty
      // string. The interpreter initializes the same elements to "", so the two
      // agree on an uninitialized `str[]` element without any extra fill loop.
      if (name === 'str_array') this.usesStrings = true;
      const elem: IRType = name === 'float_array' ? 'f64' : name === 'f32_array' ? 'f32' : name === 'long_array' ? 'i64' : 'i32';
      return this.lowerAlloc(elem, this.lowerExpr(e.args[0])!);
    }
    if (name === 'struct_array') {
      // Array of i32 struct handles, zero-filled (every element is the null
      // handle until assigned).
      return this.lowerAlloc('i32', this.lowerExpr(e.args[0])!);
    }
    if (name === 'fn_array') {
      // Array of i32 function-table slots, zero-filled. Slot 0 is reserved as a
      // null `funcref` (the backend shifts every real function to slots 1..N), so
      // an unassigned element calls table[0] and the engine traps on the null
      // reference — exactly as the interpreter traps on a null function value.
      return this.lowerAlloc('i32', this.lowerExpr(e.args[0])!);
    }
    if (name === 'len') {
      const base = this.lowerExpr(e.args[0])!;
      return this.def('i32', 'load', 'i32', [base]);
    }
    // Soft float-math builtins (skipped when a user function shadows the name).
    if (name in FLOAT_UNARY_SUB && !this.userFns.has(name)) {
      return this.def('f64', 'cast', FLOAT_UNARY_SUB[name], [this.lowerExpr(e.args[0])!]);
    }
    if (name in FLOAT_BINARY_SUB && !this.userFns.has(name)) {
      const a = this.lowerExpr(e.args[0])!;
      const b = this.lowerExpr(e.args[1])!;
      return this.def('f64', 'fbin', FLOAT_BINARY_SUB[name], [a, b]);
    }
    // Transcendental math builtins lower to a call into the MATH_PRELUDE kernel
    // `__<name>` (pulled in via `usesMath`); the kernel is ordinary Strata that
    // the interpreter runs too, so the two backends agree bit-for-bit.
    if ((MATH_UNARY.has(name) || MATH_BINARY.has(name)) && !this.userFns.has(name)) {
      this.usesMath = true;
      const margs = e.args.map((a) => this.lowerExpr(a)!);
      return this.def('f64', 'call', '__' + name, margs);
    }
    const args = e.args.map((a) => this.lowerExpr(a)!);
    const ret = retTypeOf(e.ty!);
    if (ret === 'void') {
      this.emit({ dest: null, ty: 'void', kind: 'call', sub: name, args });
      return null;
    }
    return this.def(ret, 'call', name, args);
  }

  // --- arrays / linear memory ---

  private lowerAlloc(elem: IRType, count: POperand): POperand {
    this.usesMemory = true;
    const elemSize = elem === 'i32' || elem === 'f32' ? 4 : 8; // i64 and f64 are 8 bytes
    const base = this.def('i32', 'gget', HEAP_GLOBAL, []);
    // header: store the length at base
    this.emit({ dest: null, ty: 'void', kind: 'store', sub: 'i32', args: [base, count] });
    const bytes = this.def('i32', 'ibin', 'mul', [count, CI(elemSize)]);
    const raw = this.def('i32', 'ibin', 'add', [bytes, CI(ARRAY_HEADER + 7)]);
    const aligned = this.def('i32', 'ibin', 'and', [raw, CI(~7)]);
    const next = this.def('i32', 'ibin', 'add', [base, aligned]);
    this.emit({ dest: null, ty: 'void', kind: 'gset', sub: HEAP_GLOBAL, args: [next] });
    return base;
  }

  // Raw bump allocator: reserve `nBytes` (8-byte aligned) from the heap and
  // return the old top. Used by the string runtime (which writes its own header).
  private lowerAllocBytes(nBytes: POperand): POperand {
    this.usesMemory = true;
    const base = this.def('i32', 'gget', HEAP_GLOBAL, []);
    const raw = this.def('i32', 'ibin', 'add', [nBytes, CI(7)]);
    const aligned = this.def('i32', 'ibin', 'and', [raw, CI(~7)]);
    const next = this.def('i32', 'ibin', 'add', [base, aligned]);
    this.emit({ dest: null, ty: 'void', kind: 'gset', sub: HEAP_GLOBAL, args: [next] });
    return base;
  }

  private arrayElemIR(target: Expr): IRType {
    const t = target.ty!;
    if (t.kind !== 'array') throw new Error('not an array');
    return t.elem.kind === 'float' ? 'f64' : t.elem.kind === 'f32' ? 'f32' : t.elem.kind === 'long' ? 'i64' : 'i32';
  }

  // --- structs / linear memory ---

  /** The layout of `target.field`, looked up from the target's static type. */
  private fieldLayout(target: Expr, field: string): { offset: number; irType: IRType } {
    const t = target.ty!;
    if (t.kind !== 'struct') throw new Error('member access on a non-struct');
    const fl = this.layouts.get(t.name)?.byName.get(field);
    if (!fl) throw new Error(`no field ${field} on ${t.name}`);
    return { offset: fl.offset, irType: fl.irType };
  }

  /** Address of a struct field: the base handle plus the field's byte offset. */
  private fieldAddr(target: Expr, offset: number): POperand {
    this.usesMemory = true;
    const base = this.lowerExpr(target)!;
    if (offset === 0) return base;
    return this.def('i32', 'ibin', 'add', [base, CI(offset)]);
  }

  /** Construct a struct: evaluate every argument (left to right), bump-allocate
   * the record, then store each argument at its field offset. Returns the
   * handle. Argument evaluation precedes allocation so side effects observe the
   * same order as the reference interpreter. */
  private lowerStructNew(name: string, args: Expr[]): POperand {
    const layout = this.layouts.get(name)!;
    this.usesMemory = true;
    const vals = args.map((a) => this.lowerExpr(a)!);
    // A first-class `alloc` op (not the raw bump sequence) so escape analysis can
    // recognize this as a fresh record and, when it never escapes, scalarize it
    // away entirely. Surviving allocs are lowered to the bump sequence pre-codegen.
    const base = this.def('i32', 'alloc', '', [CI(layout.size)]);
    layout.fields.forEach((f, i) => {
      const addr = f.offset === 0 ? base : this.def('i32', 'ibin', 'add', [base, CI(f.offset)]);
      this.emit({ dest: null, ty: 'void', kind: 'store', sub: f.irType, args: [addr, vals[i]] });
    });
    return base;
  }

  private elemAddr(target: Expr, index: Expr): POperand {
    this.usesMemory = true;
    const base = this.lowerExpr(target)!;
    const idx = this.lowerExpr(index)!;
    const eir = this.arrayElemIR(target);
    const elemSize = eir === 'i32' || eir === 'f32' ? 4 : 8;
    const off = this.def('i32', 'ibin', 'mul', [idx, CI(elemSize)]);
    const dataStart = this.def('i32', 'ibin', 'add', [base, CI(ARRAY_HEADER)]);
    return this.def('i32', 'ibin', 'add', [dataStart, off]);
  }

  private computePreds(): void {
    const byId = new Map(this.blocks.map((b) => [b.id, b]));
    for (const b of this.blocks) {
      const t = b.term;
      if (!t) continue;
      const succ = t.op === 'br' ? [t.target] : t.op === 'condbr' ? [t.t, t.f] : [];
      for (const s of succ) byId.get(s)?.preds.push(b.id);
    }
  }
}

export function buildPreIR(prog: Program): PModule {
  const funcs: PFunc[] = [];
  const pool = new StringPool();
  const layouts = computeLayouts(prog);
  let usesMemory = false;
  let usesStrings = false;
  let usesFloatFmt = false;
  let usesMath = false;
  // Only the entry point is exported, so the optimizer is free to delete a
  // function once every call to it has been inlined. If a program has no `main`,
  // fall back to exporting everything so it can still be driven externally.
  const hasMain = prog.decls.some((d) => d.kind === 'fn' && d.name === 'main');
  // Names a user function claims (so a soft float-math builtin like `sqrt` yields
  // to a hand-written `fn sqrt`). The prelude's own `__`-functions never collide.
  const userFns = new Set(prog.decls.filter((d) => d.kind === 'fn').map((d) => (d as { name: string }).name));
  for (const d of prog.decls) {
    if (d.kind !== 'fn') continue;
    const params = d.params.map((p) => ({ name: p.name, ty: irTypeOf(p.ty) }));
    const exported = hasMain ? d.name === 'main' : true;
    const fb = new FnBuilder(d.name, params, retTypeOf(d.retTy), d.body, exported, pool, layouts, userFns);
    const { fn, usesMemory: m, usesStrings: s, usesFloatFmt: ff, usesMath: mm } = fb.build();
    usesMemory = usesMemory || m;
    usesStrings = usesStrings || s;
    usesFloatFmt = usesFloatFmt || ff;
    usesMath = usesMath || mm;
    funcs.push(fn);
  }

  const globals: PModule['globals'] = [];
  for (const d of prog.decls) {
    if (d.kind !== 'global') continue;
    let init: ConstNum;
    if (d.init.node === 'string') {
      usesMemory = usesStrings = true;
      init = pool.intern(d.init.value);
    } else {
      init = constInitValue(d.init);
    }
    globals.push({ name: d.name, ty: irTypeOf(d.resolvedTy!), init, mutable: true });
  }

  // The string runtime is written in Strata and compiled through the same
  // pipeline, so the backend that produces it is differential-tested too. It is
  // only pulled in when a program actually uses strings; unused helpers are then
  // removed by dead-function elimination at -O2+.
  if (usesStrings) {
    usesMemory = true;
    const preludeProg = parse(STRING_PRELUDE);
    typecheck(preludeProg, { lowLevel: true });
    for (const d of preludeProg.decls) {
      if (d.kind !== 'fn') continue;
      const params = d.params.map((p) => ({ name: p.name, ty: irTypeOf(p.ty) }));
      const fb = new FnBuilder(d.name, params, retTypeOf(d.retTy), d.body, false, pool, layouts, userFns);
      funcs.push(fb.build().fn);
    }
  }

  // The float formatter is a second, self-contained prelude — a big-integer
  // Dragon4 — injected only when a program actually formats a float (`str(float)`),
  // and pruned by dead-function elimination at -O2+ if it ends up unreachable.
  if (usesFloatFmt) {
    usesMemory = true;
    const floatProg = parse(FLOAT_PRELUDE);
    typecheck(floatProg, { lowLevel: true });
    for (const d of floatProg.decls) {
      if (d.kind !== 'fn') continue;
      const params = d.params.map((p) => ({ name: p.name, ty: irTypeOf(p.ty) }));
      const fb = new FnBuilder(d.name, params, retTypeOf(d.retTy), d.body, false, pool, layouts, userFns);
      funcs.push(fb.build().fn);
    }
  }

  // The transcendental math library is a third self-contained prelude, written in
  // Strata and compiled through this very pipeline (so it is differential-tested
  // too), injected only when a program calls a math builtin and pruned by
  // dead-function elimination at -O2+. Its kernels are built with an *empty*
  // user-function set so their internal `sqrt`/`floor`/… always resolve to the
  // native single-op builtins — exactly as the isolated interpreter kernel does —
  // even if the user program happens to define `fn sqrt`.
  if (usesMath) {
    const mathProg = parse(MATH_PRELUDE);
    typecheck(mathProg, { lowLevel: true });
    const noUserFns = new Set<string>();
    for (const d of mathProg.decls) {
      if (d.kind !== 'fn') continue;
      const params = d.params.map((p) => ({ name: p.name, ty: irTypeOf(p.ty) }));
      const fb = new FnBuilder(d.name, params, retTypeOf(d.retTy), d.body, false, pool, layouts, noUserFns);
      funcs.push(fb.build().fn);
    }
  }

  if (usesMemory) {
    globals.push({ name: HEAP_GLOBAL, ty: 'i32', init: pool.heapStart(), mutable: true });
  }

  const staticData = pool.bytes.length ? { offset: STR_DATA_BASE, bytes: pool.bytes } : undefined;
  return { funcs, globals, usesMemory, memPages: MEM_PAGES, staticData };
}

// Globals must have constant initializers; fold the (already type-checked)
// initializer expression to a literal here. `long` initializers fold with BigInt
// (64-bit wrapping) so the wasm `i64.const` and the interpreter agree.
function constInitValue(e: Expr): ConstNum {
  switch (e.node) {
    case 'int':
      return e.value | 0;
    case 'long':
      return BigInt.asIntN(64, e.value);
    case 'bool':
      return e.value ? 1 : 0;
    case 'float':
      return e.value;
    case 'unary': {
      const v = constInitValue(e.operand);
      if (typeof v === 'bigint') {
        if (e.op === '-') return BigInt.asIntN(64, -v);
        if (e.op === '~') return BigInt.asIntN(64, ~v);
        return v; // unary '+'
      }
      if (e.op === '-') return -v;
      if (e.op === '~') return ~v;
      return v;
    }
    case 'binary': {
      const a = constInitValue(e.left);
      const b = constInitValue(e.right);
      if (typeof a === 'bigint' && typeof b === 'bigint') {
        switch (e.op) {
          case '+': return BigInt.asIntN(64, a + b);
          case '-': return BigInt.asIntN(64, a - b);
          case '*': return BigInt.asIntN(64, a * b);
          case '/': return b === 0n ? 0n : BigInt.asIntN(64, a / b);
          default: return 0n;
        }
      }
      const an = Number(a);
      const bn = Number(b);
      switch (e.op) {
        case '+': return an + bn;
        case '-': return an - bn;
        case '*': return an * bn;
        case '/': return e.left.ty!.kind === 'float' ? an / bn : Math.trunc(an / bn) | 0;
        default: return 0;
      }
    }
    case 'call': {
      // Constant-folded numeric conversions in a global initializer (e.g.
      // `let g: f32 = f32(1.5);`), matching the interpreter's callBuiltin exactly
      // so the wasm global and the oracle agree.
      const a = e.args.length ? constInitValue(e.args[0]) : 0;
      const k = e.args[0]?.ty!.kind;
      switch (e.callee) {
        case 'f32': return Math.fround(Number(a));
        case 'float': return Number(a);
        case 'int':
          if (k === 'float' || k === 'f32') return satTruncI32C(Number(a));
          if (k === 'long') return Number(BigInt.asIntN(32, a as bigint));
          return Number(a) | 0;
        case 'long':
          if (k === 'float' || k === 'f32') return satTruncI64C(Number(a));
          if (k === 'long') return BigInt.asIntN(64, a as bigint);
          return BigInt.asIntN(64, BigInt(Number(a) | 0));
        default:
          return 0;
      }
    }
    default:
      return 0;
  }
}

// Saturating float->int truncation for constant folding (mirrors the wasm
// trunc_sat ops and the interpreter's satTruncI32/I64).
function satTruncI32C(x: number): number {
  if (Number.isNaN(x)) return 0;
  if (x >= 2147483647) return 2147483647;
  if (x <= -2147483648) return -2147483648;
  return Math.trunc(x);
}
function satTruncI64C(x: number): bigint {
  if (Number.isNaN(x)) return 0n;
  if (x >= 9223372036854775808) return 2n ** 63n - 1n;
  if (x < -9223372036854775808) return -(2n ** 63n);
  return BigInt(Math.trunc(x));
}
