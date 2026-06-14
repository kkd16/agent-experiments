import type { BinaryOp, Block, Expr, Program, Stmt, Ty } from '../ast';
import type { IRType, RetType } from './ir';

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
}

export const HEAP_GLOBAL = '__hp';
const ARRAY_HEADER = 8; // bytes reserved before element data (length word + padding)
const MEM_PAGES = 256; // 16 MiB linear memory

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

class FnBuilder {
  blocks: PBlock[] = [];
  varType = new Map<string, IRType>();
  usesMemory = false;
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

  constructor(name: string, params: { name: string; ty: IRType }[], retTy: RetType, body: Block, exported: boolean) {
    this.name = name;
    this.params = params;
    this.retTy = retTy;
    this.body = body;
    this.exported = exported;
  }

  build(): { fn: PFunc; usesMemory: boolean } {
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
    return { fn, usesMemory: this.usesMemory };
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
        const addr = this.elemAddr(e.target, e.index);
        const elem = this.arrayElemIR(e.target);
        return this.def(elem, 'load', elem, [addr]);
      }
      case 'call':
        return this.lowerCall(e);
    }
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
    if (name === 'print') {
      const v = this.lowerExpr(e.args[0])!;
      const k = e.args[0].ty!.kind;
      this.emit({ dest: null, ty: 'void', kind: 'print', sub: k === 'float' ? 'float' : k === 'bool' ? 'bool' : 'int', args: [v] });
      return null;
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
  let usesMemory = false;
  // Only the entry point is exported, so the optimizer is free to delete a
  // function once every call to it has been inlined. If a program has no `main`,
  // fall back to exporting everything so it can still be driven externally.
  const hasMain = prog.decls.some((d) => d.kind === 'fn' && d.name === 'main');
  for (const d of prog.decls) {
    if (d.kind !== 'fn') continue;
    const params = d.params.map((p) => ({ name: p.name, ty: irTypeOf(p.ty) }));
    const exported = hasMain ? d.name === 'main' : true;
    const fb = new FnBuilder(d.name, params, retTypeOf(d.retTy), d.body, exported);
    const { fn, usesMemory: m } = fb.build();
    usesMemory = usesMemory || m;
    funcs.push(fn);
  }

  const globals: PModule['globals'] = [];
  for (const d of prog.decls) {
    if (d.kind !== 'global') continue;
    globals.push({ name: d.name, ty: irTypeOf(d.resolvedTy!), init: constInitValue(d.init), mutable: true });
  }
  if (usesMemory) {
    globals.push({ name: HEAP_GLOBAL, ty: 'i32', init: 16, mutable: true });
  }

  return { funcs, globals, usesMemory, memPages: MEM_PAGES };
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
