import type { BinaryOp, Block, Expr, Program, Stmt, Ty } from '../ast';
import type { IRType, RetType } from './ir';
import { parse } from '../parser';
import { typecheck } from '../types';
import { STRING_PRELUDE } from './prelude';

// Stage 1 of lowering: the typed AST is translated into a control-flow graph of
// basic blocks where local variables are still referenced *by name* and may be
// assigned more than once ("pre-SSA"). Stage 2 (ssa.ts) renames these into pure
// SSA with phi nodes. Keeping the two stages separate makes both far simpler.

export type POperand = { tag: 'var'; name: string } | { tag: 'const'; ty: IRType; num: number };

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
  globals: { name: string; ty: IRType; init: number; mutable: boolean }[];
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
    default:
      return 'i32'; // int, bool, and array handles are all i32
  }
}
function retTypeOf(t: Ty): RetType {
  return t.kind === 'void' ? 'void' : irTypeOf(t);
}

const VAR = (name: string): POperand => ({ tag: 'var', name });
const CI = (n: number): POperand => ({ tag: 'const', ty: 'i32', num: n | 0 });

// String builtins that lower 1:1 to a prelude function `__<name>` taking string
// pointers / ints and returning an i32. The result's user-visible type (str/int/
// bool) is decided by the type checker; at the IR level it is always i32.
const STRING_HELPERS = new Set([
  'substr', 'index_of', 'to_upper', 'to_lower',
  'repeat', 'trim', 'replace', 'find', 'contains', 'starts_with', 'ends_with', 'parse_int',
]);

class FnBuilder {
  blocks: PBlock[] = [];
  varType = new Map<string, IRType>();
  usesMemory = false;
  usesStrings = false;
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

  constructor(name: string, params: { name: string; ty: IRType }[], retTy: RetType, body: Block, exported: boolean, pool: StringPool) {
    this.name = name;
    this.params = params;
    this.retTy = retTy;
    this.body = body;
    this.exported = exported;
    this.pool = pool;
  }

  build(): { fn: PFunc; usesMemory: boolean; usesStrings: boolean } {
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
    return { fn, usesMemory: this.usesMemory, usesStrings: this.usesStrings };
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
      case 'call':
        return this.lowerCall(e);
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
    const isInt = irTypeOf(e.operand.ty!) === 'i32';
    switch (e.op) {
      case '+':
        return v;
      case '-':
        return isInt
          ? this.def('i32', 'ibin', 'sub', [CI(0), v])
          : this.def('f64', 'fbin', 'sub', [{ tag: 'const', ty: 'f64', num: 0 }, v]);
      case '!':
        return this.def('i32', 'icmp', 'eq', [v, CI(0)]);
      case '~':
        return this.def('i32', 'ibin', 'xor', [v, CI(-1)]);
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
    const isInt = irTypeOf(e.left.ty!) === 'i32';
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
    if (op in icmp && (op === '==' || op === '!=' || op === '<' || op === '<=' || op === '>' || op === '>=')) {
      return isInt ? this.def('i32', 'icmp', icmp[op]!, [a, b]) : this.def('i32', 'fcmp', fcmp[op]!, [a, b]);
    }
    if (isInt) return this.def('i32', 'ibin', intArith[op]!, [a, b]);
    return this.def('f64', 'fbin', floatArith[op]!, [a, b]);
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

  private lowerCall(e: Extract<Expr, { node: 'call' }>): POperand | null {
    const name = e.callee;
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
    if (name === 'print') {
      const v = this.lowerExpr(e.args[0])!;
      const k = e.args[0].ty!.kind;
      if (k === 'str') { this.usesStrings = true; this.usesMemory = true; }
      this.emit({ dest: null, ty: 'void', kind: 'print', sub: k === 'float' ? 'float' : k === 'bool' ? 'bool' : k === 'str' ? 'str' : 'int', args: [v] });
      return null;
    }
    if (name === 'str') {
      const k = e.args[0].ty!.kind;
      const v = this.lowerExpr(e.args[0])!;
      if (k === 'str') return v; // identity
      this.usesStrings = true;
      this.usesMemory = true;
      return this.def('i32', 'call', k === 'bool' ? '__bool_to_str' : '__int_to_str', [v]);
    }
    if (name === 'char') {
      this.usesStrings = true;
      this.usesMemory = true;
      return this.def('i32', 'call', '__char', [this.lowerExpr(e.args[0])!]);
    }
    if (STRING_HELPERS.has(name)) {
      // Every extended string helper is a prelude function `__<name>` returning
      // an i32 (a string pointer, an int index, or a 0/1 bool).
      this.usesStrings = true;
      this.usesMemory = true;
      const args = e.args.map((a) => this.lowerExpr(a)!);
      return this.def('i32', 'call', '__' + name, args);
    }
    if (name === 'int') {
      const v = this.lowerExpr(e.args[0])!;
      return e.args[0].ty!.kind === 'float' ? this.def('i32', 'cast', 'f2i', [v]) : v;
    }
    if (name === 'float') {
      const v = this.lowerExpr(e.args[0])!;
      return e.args[0].ty!.kind === 'float' ? v : this.def('f64', 'cast', 'i2f', [v]);
    }
    if (name === 'int_array' || name === 'float_array') {
      return this.lowerAlloc(name === 'int_array' ? 'i32' : 'f64', this.lowerExpr(e.args[0])!);
    }
    if (name === 'len') {
      const base = this.lowerExpr(e.args[0])!;
      return this.def('i32', 'load', 'i32', [base]);
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
    const elemSize = elem === 'f64' ? 8 : 4;
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
    return t.elem.kind === 'float' ? 'f64' : 'i32';
  }

  private elemAddr(target: Expr, index: Expr): POperand {
    this.usesMemory = true;
    const base = this.lowerExpr(target)!;
    const idx = this.lowerExpr(index)!;
    const elemSize = this.arrayElemIR(target) === 'f64' ? 8 : 4;
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
  let usesMemory = false;
  let usesStrings = false;
  // Only the entry point is exported, so the optimizer is free to delete a
  // function once every call to it has been inlined. If a program has no `main`,
  // fall back to exporting everything so it can still be driven externally.
  const hasMain = prog.decls.some((d) => d.kind === 'fn' && d.name === 'main');
  for (const d of prog.decls) {
    if (d.kind !== 'fn') continue;
    const params = d.params.map((p) => ({ name: p.name, ty: irTypeOf(p.ty) }));
    const exported = hasMain ? d.name === 'main' : true;
    const fb = new FnBuilder(d.name, params, retTypeOf(d.retTy), d.body, exported, pool);
    const { fn, usesMemory: m, usesStrings: s } = fb.build();
    usesMemory = usesMemory || m;
    usesStrings = usesStrings || s;
    funcs.push(fn);
  }

  const globals: PModule['globals'] = [];
  for (const d of prog.decls) {
    if (d.kind !== 'global') continue;
    let init: number;
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
      const fb = new FnBuilder(d.name, params, retTypeOf(d.retTy), d.body, false, pool);
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
// initializer expression to a literal here.
function constInitValue(e: Expr): number {
  switch (e.node) {
    case 'int':
      return e.value | 0;
    case 'bool':
      return e.value ? 1 : 0;
    case 'float':
      return e.value;
    case 'unary':
      if (e.op === '-') return -constInitValue(e.operand);
      if (e.op === '+') return constInitValue(e.operand);
      if (e.op === '~') return ~constInitValue(e.operand);
      return 0;
    case 'binary': {
      const a = constInitValue(e.left);
      const b = constInitValue(e.right);
      switch (e.op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/': return e.left.ty!.kind === 'float' ? a / b : Math.trunc(a / b) | 0;
        default: return 0;
      }
    }
    default:
      return 0;
  }
}
