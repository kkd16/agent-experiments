import type { Block, Inst, IRFunc, IRModule, IRType, Operand, RetType, Term } from '../ir/ir';
import { ByteWriter, VT_F64, VT_I32, WASM_MAGIC, WASM_VERSION, section, vec } from './encoder';

// The WebAssembly backend. Three responsibilities:
//   (1) Recover structured control flow (block / loop / if + br) from the SSA
//       control-flow graph. Because Strata only has structured source, the CFG
//       is reducible, so we can translate it directly off the dominator tree
//       (Ramsey, "Beyond Relooper", ICFP 2022).
//   (2) Schedule values onto the wasm operand stack ("stackification"): a pure,
//       non-trapping value with a single use in the same block is *folded*
//       directly into its consumer's operand slot, so it never touches a local.
//       Everything else gets a local, and locals are packed into a dense index
//       space. Phi nodes are resolved by parallel copies on predecessor edges.
//   (3) Emit the module bytes (and a matching WAT listing) from that schedule.

// Structured wasm instruction tree (encoded / pretty-printed below).
type W =
  | { k: 'block'; body: W[] }
  | { k: 'loop'; body: W[] }
  | { k: 'if'; t: W[]; e: W[] }
  | { k: 'br'; d: number }
  | { k: 'ret' }
  | { k: 'unreachable' }
  | { k: 'lget'; i: number }
  | { k: 'lset'; i: number }
  | { k: 'gget'; i: number }
  | { k: 'gset'; i: number }
  | { k: 'i32c'; v: number }
  | { k: 'f64c'; v: number }
  | { k: 'call'; i: number }
  | { k: 'load'; f64: boolean }
  | { k: 'store'; f64: boolean }
  | { k: 'op'; c: number; name: string }
  | { k: 'trunc' }
  | { k: 'convert' };

const I_BIN: Record<string, [number, string]> = {
  add: [0x6a, 'i32.add'], sub: [0x6b, 'i32.sub'], mul: [0x6c, 'i32.mul'],
  div_s: [0x6d, 'i32.div_s'], rem_s: [0x6f, 'i32.rem_s'], and: [0x71, 'i32.and'],
  or: [0x72, 'i32.or'], xor: [0x73, 'i32.xor'], shl: [0x74, 'i32.shl'], shr_s: [0x75, 'i32.shr_s'],
};
const F_BIN: Record<string, [number, string]> = {
  add: [0xa0, 'f64.add'], sub: [0xa1, 'f64.sub'], mul: [0xa2, 'f64.mul'], div: [0xa3, 'f64.div'],
};
const I_CMP: Record<string, [number, string]> = {
  eq: [0x46, 'i32.eq'], ne: [0x47, 'i32.ne'], lt_s: [0x48, 'i32.lt_s'],
  gt_s: [0x4a, 'i32.gt_s'], le_s: [0x4c, 'i32.le_s'], ge_s: [0x4e, 'i32.ge_s'],
};
const F_CMP: Record<string, [number, string]> = {
  eq: [0x61, 'f64.eq'], ne: [0x62, 'f64.ne'], lt: [0x63, 'f64.lt'],
  gt: [0x64, 'f64.gt'], le: [0x65, 'f64.le'], ge: [0x66, 'f64.ge'],
};

interface Frame {
  kind: 'block' | 'loop' | 'if';
  node: number; // -1 for if frames
}

interface Resolvers {
  globalIndex: (name: string) => number;
  printIndex: (kind: string) => number;
  callIndex: (name: string) => number;
}

// Pure value families that produce no side effect and never trap, so they may
// be recomputed at (i.e. sunk to) their single use without changing behavior.
// Integer div_s/rem_s are deliberately absent — they can trap, so sinking them
// past a side effect could reorder an observable trap.
const STACKIFIABLE = new Set(['ibin', 'fbin', 'icmp', 'fcmp', 'cast', 'copy']);

class FuncGen {
  fn: IRFunc;
  private byId: Map<number, Block>;
  private rpoIndex = new Map<number, number>();
  private idom = new Map<number, number>();
  private domChildren = new Map<number, number[]>();
  private nparams: number;
  private res: Resolvers;
  // Stackification state.
  private inlined = new Set<number>(); // value ids folded onto the operand stack
  private defOf = new Map<number, Inst>(); // id -> its (folded) defining instruction
  private localIndex = new Map<number, number>(); // value id -> dense wasm local index
  private localDeclTypes: IRType[] = []; // declared (non-param) local types, in index order
  private nextLocal = 0;
  scratch: IRType[] = []; // extra scratch locals for cyclic phi resolution
  foldedCount = 0; // values kept on the stack (a metric the UI surfaces)
  wtree: W[] = [];

  constructor(fn: IRFunc, res: Resolvers) {
    this.fn = fn;
    this.res = res;
    this.byId = new Map(fn.blocks.map((b) => [b.id, b]));
    this.nparams = fn.params.length;
    this.analyze();
    this.computeStackification();
    this.assignLocals();
    this.wtree = [...this.genTree(fn.entry, []), { k: 'unreachable' }];
  }

  // --- stackification: decide which values live on the operand stack ---
  //
  // A value is folded into its consumer (no local) when it is produced by a
  // pure, non-trapping instruction and has exactly one use, and that use is a
  // later instruction or the terminator of the *same* block. Such a value can be
  // recomputed at the use site: pure ops have no observable order, and SSA
  // guarantees their inputs are unchanged. Uses that flow through a phi (a
  // predecessor-edge copy) are excluded so the parallel-copy resolver keeps
  // seeing plain locals/consts.
  private computeStackification(): void {
    type Use = { block: number; where: 'inst' | 'term' | 'phi'; idx: number };
    const uses = new Map<number, Use[]>();
    const addUse = (id: number, u: Use): void => {
      let l = uses.get(id);
      if (!l) uses.set(id, (l = []));
      l.push(u);
    };
    const addOp = (o: Operand, u: Use): void => {
      if (o.tag === 'val') addUse(o.id, u);
    };
    for (const b of this.fn.blocks) {
      for (const phi of b.phis) for (const inc of phi.incomings) addOp(inc.val, { block: b.id, where: 'phi', idx: -1 });
      b.insts.forEach((inst, i) => {
        for (const a of inst.args) addOp(a, { block: b.id, where: 'inst', idx: i });
      });
      if (b.term.op === 'condbr') addOp(b.term.cond, { block: b.id, where: 'term', idx: Infinity });
      else if (b.term.op === 'ret' && b.term.value) addOp(b.term.value, { block: b.id, where: 'term', idx: Infinity });
    }
    for (const b of this.fn.blocks) {
      b.insts.forEach((inst, i) => {
        if (inst.res === null || !STACKIFIABLE.has(inst.kind)) return;
        if (inst.kind === 'ibin' && (inst.sub === 'div_s' || inst.sub === 'rem_s')) return;
        const us = uses.get(inst.res);
        if (!us || us.length !== 1) return;
        const u = us[0];
        if (u.where === 'phi' || u.block !== b.id) return;
        if (u.where === 'inst' && u.idx <= i) return; // use must follow the def
        this.inlined.add(inst.res);
        this.defOf.set(inst.res, inst);
      });
    }
    this.foldedCount = this.inlined.size;
  }

  // Pack the values that *do* need a local into a dense index space: parameters
  // occupy locals 0..n-1 (they are not re-declared), then every phi result and
  // non-folded instruction result, in id order.
  private assignLocals(): void {
    for (let i = 0; i < this.nparams; i++) this.localIndex.set(i, i);
    this.nextLocal = this.nparams;
    const mat = new Set<number>();
    for (const b of this.fn.blocks) {
      for (const phi of b.phis) mat.add(phi.res);
      for (const inst of b.insts) if (inst.res !== null && !this.inlined.has(inst.res)) mat.add(inst.res);
    }
    for (const id of [...mat].filter((id) => id >= this.nparams).sort((a, b) => a - b)) {
      this.localIndex.set(id, this.nextLocal++);
      this.localDeclTypes.push(this.fn.valueType.get(id) ?? 'i32');
    }
  }

  private li(id: number): number {
    const idx = this.localIndex.get(id);
    if (idx === undefined) throw new Error(`codegen: no local for v${id}`);
    return idx;
  }

  // --- dominators on the SSA CFG ---
  private analyze(): void {
    const rpo = this.reversePostorder();
    rpo.forEach((id, i) => this.rpoIndex.set(id, i));
    this.idom.set(this.fn.entry, this.fn.entry);
    const intersect = (a: number, b: number): number => {
      while (a !== b) {
        while ((this.rpoIndex.get(a) ?? 0) > (this.rpoIndex.get(b) ?? 0)) a = this.idom.get(a)!;
        while ((this.rpoIndex.get(b) ?? 0) > (this.rpoIndex.get(a) ?? 0)) b = this.idom.get(b)!;
      }
      return a;
    };
    let changed = true;
    while (changed) {
      changed = false;
      for (const id of rpo) {
        if (id === this.fn.entry) continue;
        let nd: number | undefined;
        for (const p of this.byId.get(id)!.preds) {
          if (this.idom.has(p)) nd = nd === undefined ? p : intersect(p, nd);
        }
        if (nd !== undefined && this.idom.get(id) !== nd) {
          this.idom.set(id, nd);
          changed = true;
        }
      }
    }
    for (const b of this.fn.blocks) this.domChildren.set(b.id, []);
    for (const b of this.fn.blocks) {
      if (b.id === this.fn.entry) continue;
      const d = this.idom.get(b.id);
      if (d !== undefined && d !== b.id) this.domChildren.get(d)!.push(b.id);
    }
  }

  private reversePostorder(): number[] {
    const post: number[] = [];
    const seen = new Set<number>();
    const visit = (id: number): void => {
      if (seen.has(id)) return;
      seen.add(id);
      for (const s of succOf(this.byId.get(id)!.term)) visit(s);
      post.push(id);
    };
    visit(this.fn.entry);
    return post.reverse();
  }

  private rpoOf(id: number): number {
    return this.rpoIndex.get(id) ?? 0;
  }
  private isLoopHeader(id: number): boolean {
    return this.byId.get(id)!.preds.some((p) => this.rpoOf(p) >= this.rpoOf(id));
  }
  private isMerge(id: number): boolean {
    let fwd = 0;
    for (const p of this.byId.get(id)!.preds) if (this.rpoOf(p) < this.rpoOf(id)) fwd++;
    return fwd >= 2;
  }
  private depthOf(ctx: Frame[], kind: Frame['kind'], node: number): number {
    for (let i = ctx.length - 1; i >= 0; i--) {
      if (ctx[i].kind === kind && ctx[i].node === node) return ctx.length - 1 - i;
    }
    throw new Error(`codegen: no enclosing ${kind} for b${node}`);
  }

  // --- structured translation ---
  private genTree(id: number, ctx: Frame[]): W[] {
    if (this.isLoopHeader(id)) {
      return [{ k: 'loop', body: this.genNode(id, [...ctx, { kind: 'loop', node: id }]) }];
    }
    return this.genNode(id, ctx);
  }

  private genNode(id: number, ctx: Frame[]): W[] {
    const merges = (this.domChildren.get(id) ?? [])
      .filter((c) => this.isMerge(c))
      .sort((a, b) => this.rpoOf(a) - this.rpoOf(b));
    return this.genWithin(id, merges, ctx);
  }

  private genWithin(id: number, ys: number[], ctx: Frame[]): W[] {
    if (ys.length === 0) {
      const out = this.emitStraightLine(id);
      out.push(...this.emitFlow(id, ctx));
      return out;
    }
    const [y, ...rest] = ys;
    const inner = this.genWithin(id, rest, [...ctx, { kind: 'block', node: y }]);
    return [{ k: 'block', body: inner }, ...this.genTree(y, ctx)];
  }

  private emitFlow(id: number, ctx: Frame[]): W[] {
    const t = this.byId.get(id)!.term;
    switch (t.op) {
      case 'ret':
        return t.value ? [...this.pushOperand(t.value), { k: 'ret' }] : [{ k: 'ret' }];
      case 'unreachable':
        return [{ k: 'unreachable' }];
      case 'br':
        return this.doBranch(id, t.target, ctx);
      case 'condbr': {
        const inner: Frame[] = [...ctx, { kind: 'if', node: -1 }];
        return [
          ...this.pushOperand(t.cond),
          { k: 'if', t: this.doBranch(id, t.t, inner), e: this.doBranch(id, t.f, inner) },
        ];
      }
    }
  }

  private doBranch(src: number, tgt: number, ctx: Frame[]): W[] {
    const copies = this.emitPhiCopies(src, tgt);
    if (this.rpoOf(tgt) <= this.rpoOf(src)) {
      return [...copies, { k: 'br', d: this.depthOf(ctx, 'loop', tgt) }];
    }
    if (this.isMerge(tgt)) {
      return [...copies, { k: 'br', d: this.depthOf(ctx, 'block', tgt) }];
    }
    return [...copies, ...this.genTree(tgt, ctx)];
  }

  // --- value emission ---
  // Pushing an operand may recursively expand a folded subtree (post-order, so
  // it lands on the stack exactly where the consumer needs it).
  private pushOperand(o: Operand): W[] {
    if (o.tag === 'const') return o.ty === 'f64' ? [{ k: 'f64c', v: o.num }] : [{ k: 'i32c', v: o.num | 0 }];
    if (this.inlined.has(o.id)) {
      const out: W[] = [];
      this.emitValue(this.defOf.get(o.id)!, out);
      return out;
    }
    return [{ k: 'lget', i: this.li(o.id) }];
  }

  // Emit an instruction's operands followed by its opcode, leaving its result on
  // the operand stack (no local.set). Shared by straight-line emission and by
  // folded-subtree expansion.
  private emitValue(inst: Inst, out: W[]): void {
    switch (inst.kind) {
      case 'ibin': {
        const [c, name] = I_BIN[inst.sub];
        out.push(...this.pushOperand(inst.args[0]), ...this.pushOperand(inst.args[1]), { k: 'op', c, name });
        break;
      }
      case 'fbin': {
        const [c, name] = F_BIN[inst.sub];
        out.push(...this.pushOperand(inst.args[0]), ...this.pushOperand(inst.args[1]), { k: 'op', c, name });
        break;
      }
      case 'icmp': {
        const [c, name] = I_CMP[inst.sub];
        out.push(...this.pushOperand(inst.args[0]), ...this.pushOperand(inst.args[1]), { k: 'op', c, name });
        break;
      }
      case 'fcmp': {
        const [c, name] = F_CMP[inst.sub];
        out.push(...this.pushOperand(inst.args[0]), ...this.pushOperand(inst.args[1]), { k: 'op', c, name });
        break;
      }
      case 'cast':
        out.push(...this.pushOperand(inst.args[0]), inst.sub === 'i2f' ? { k: 'convert' } : { k: 'trunc' });
        break;
      case 'copy':
        out.push(...this.pushOperand(inst.args[0]));
        break;
      case 'gget':
        out.push({ k: 'gget', i: this.res.globalIndex(inst.sub) });
        break;
      case 'gset':
        out.push(...this.pushOperand(inst.args[0]), { k: 'gset', i: this.res.globalIndex(inst.sub) });
        break;
      case 'load':
        out.push(...this.pushOperand(inst.args[0]), { k: 'load', f64: inst.sub === 'f64' });
        break;
      case 'store':
        out.push(...this.pushOperand(inst.args[0]), ...this.pushOperand(inst.args[1]), { k: 'store', f64: inst.sub === 'f64' });
        break;
      case 'print':
        out.push(...this.pushOperand(inst.args[0]), { k: 'call', i: this.res.printIndex(inst.sub) });
        break;
      case 'call':
        for (const a of inst.args) out.push(...this.pushOperand(a));
        out.push({ k: 'call', i: this.res.callIndex(inst.sub) });
        break;
    }
  }

  private emitStraightLine(id: number): W[] {
    const out: W[] = [];
    for (const inst of this.byId.get(id)!.insts) {
      if (inst.res !== null && this.inlined.has(inst.res)) continue; // folded into its single use
      this.emitValue(inst, out);
      if (inst.res !== null) out.push({ k: 'lset', i: this.li(inst.res) });
    }
    return out;
  }

  private emitPhiCopies(pred: number, succ: number): W[] {
    const phis = this.byId.get(succ)!.phis;
    if (phis.length === 0) return [];
    const copies: { dst: number; src: Operand; ty: IRType }[] = [];
    for (const phi of phis) {
      const inc = phi.incomings.find((x) => x.pred === pred);
      if (!inc) continue;
      if (inc.val.tag === 'val' && inc.val.id === phi.res) continue; // trivial self-copy
      copies.push({ dst: phi.res, src: inc.val, ty: phi.ty });
    }
    const dstSet = new Set(copies.map((c) => c.dst));
    const conflict = copies.some((c) => c.src.tag === 'val' && dstSet.has(c.src.id));
    const out: W[] = [];
    if (!conflict) {
      for (const c of copies) out.push(...this.pushOperand(c.src), { k: 'lset', i: this.li(c.dst) });
      return out;
    }
    // Break cyclic/overlapping copies through scratch locals.
    const temps = copies.map((c) => this.allocScratch(c.ty));
    copies.forEach((c, i) => out.push(...this.pushOperand(c.src), { k: 'lset', i: temps[i] }));
    copies.forEach((c, i) => out.push({ k: 'lget', i: temps[i] }, { k: 'lset', i: this.li(c.dst) }));
    return out;
  }

  private allocScratch(ty: IRType): number {
    this.scratch.push(ty);
    return this.nextLocal++;
  }

  /** Extra local declarations (everything beyond the parameters), in index order. */
  localTypes(): IRType[] {
    return [...this.localDeclTypes, ...this.scratch];
  }
}

function succOf(t: Term): number[] {
  if (t.op === 'br') return [t.target];
  if (t.op === 'condbr') return t.t === t.f ? [t.t] : [t.t, t.f];
  return [];
}

// --- encoding the structured tree ---

function encodeBody(w: ByteWriter, tree: W[]): void {
  for (const n of tree) {
    switch (n.k) {
      case 'block':
        w.u8(0x02); w.u8(0x40); encodeBody(w, n.body); w.u8(0x0b);
        break;
      case 'loop':
        w.u8(0x03); w.u8(0x40); encodeBody(w, n.body); w.u8(0x0b);
        break;
      case 'if':
        w.u8(0x04); w.u8(0x40); encodeBody(w, n.t);
        if (n.e.length) { w.u8(0x05); encodeBody(w, n.e); }
        w.u8(0x0b);
        break;
      case 'br': w.u8(0x0c); w.u32(n.d); break;
      case 'ret': w.u8(0x0f); break;
      case 'unreachable': w.u8(0x00); break;
      case 'lget': w.u8(0x20); w.u32(n.i); break;
      case 'lset': w.u8(0x21); w.u32(n.i); break;
      case 'gget': w.u8(0x23); w.u32(n.i); break;
      case 'gset': w.u8(0x24); w.u32(n.i); break;
      case 'i32c': w.u8(0x41); w.i32(n.v); break;
      case 'f64c': w.u8(0x44); w.f64(n.v); break;
      case 'call': w.u8(0x10); w.u32(n.i); break;
      case 'load': w.u8(n.f64 ? 0x2b : 0x28); w.u32(n.f64 ? 3 : 2); w.u32(0); break;
      case 'store': w.u8(n.f64 ? 0x39 : 0x36); w.u32(n.f64 ? 3 : 2); w.u32(0); break;
      case 'op': w.u8(n.c); break;
      case 'trunc': w.u8(0xfc); w.u32(0x02); break; // i32.trunc_sat_f64_s
      case 'convert': w.u8(0xb7); break; // f64.convert_i32_s
    }
  }
}

const vt = (t: IRType): number => (t === 'f64' ? VT_F64 : VT_I32);

interface PrintImport {
  kind: string;
  field: string;
  param: IRType;
}

export interface CodegenResult {
  bytes: Uint8Array;
  wat: string;
  funcInstrCount: number;
  localCount: number; // total declared locals across all functions (lower = better)
  stackFolded: number; // values kept on the operand stack (no local at all)
}

export function codegen(mod: IRModule): CodegenResult {
  // discover which print imports are used
  const usedPrints = new Set<string>();
  for (const fn of mod.funcs) for (const b of fn.blocks) for (const i of b.insts) if (i.kind === 'print') usedPrints.add(i.sub);
  const imports: PrintImport[] = (['int', 'float', 'bool'] as const)
    .filter((k) => usedPrints.has(k))
    .map((k) => ({ kind: k, field: `print_${k}`, param: k === 'float' ? 'f64' : 'i32' }));
  const printIndexMap = new Map<string, number>();
  imports.forEach((im, i) => printIndexMap.set(im.kind, i));
  const importCount = imports.length;

  const funcIndexMap = new Map<string, number>();
  mod.funcs.forEach((fn, i) => funcIndexMap.set(fn.name, importCount + i));
  const globalIndexMap = new Map<string, number>();
  mod.globals.forEach((g, i) => globalIndexMap.set(g.name, i));

  // --- type section (dedup signatures) ---
  const typeKeys: string[] = [];
  const typeIndex = new Map<string, number>();
  const typeBytes: number[][] = [];
  const internType = (params: IRType[], results: RetType[]): number => {
    const key = params.join(',') + '->' + results.join(',');
    if (typeIndex.has(key)) return typeIndex.get(key)!;
    const w = new ByteWriter();
    w.u8(0x60);
    w.u32(params.length);
    for (const p of params) w.u8(vt(p));
    const res = results.filter((r) => r !== 'void') as IRType[];
    w.u32(res.length);
    for (const r of res) w.u8(vt(r));
    const idx = typeKeys.length;
    typeKeys.push(key);
    typeIndex.set(key, idx);
    typeBytes.push(w.bytes);
    return idx;
  };

  const importTypeIdx = imports.map((im) => internType([im.param], []));
  const funcTypeIdx = mod.funcs.map((fn) => internType(fn.params.map((p) => p.ty), [fn.retTy]));

  // --- codegen each function (also yields WAT + metrics) ---
  const resolvers = {
    globalIndex: (name: string) => globalIndexMap.get(name)!,
    printIndex: (kind: string) => printIndexMap.get(kind)!,
    callIndex: (name: string) => funcIndexMap.get(name)!,
  };
  const gens = mod.funcs.map((fn) => new FuncGen(fn, resolvers));

  // --- assemble sections ---
  const sections: number[][] = [];
  sections.push(section(1, vec(typeBytes)));

  // import section
  if (importCount > 0) {
    const items = imports.map((im, i) => {
      const w = new ByteWriter();
      w.name('env');
      w.name(im.field);
      w.u8(0x00); // func import
      w.u32(importTypeIdx[i]);
      return w.bytes;
    });
    sections.push(section(2, vec(items)));
  }

  // function section
  sections.push(
    section(
      3,
      vec(
        funcTypeIdx.map((ti) => {
          const w = new ByteWriter();
          w.u32(ti);
          return w.bytes;
        }),
      ),
    ),
  );

  // memory section
  if (mod.usesMemory) {
    const w = new ByteWriter();
    w.u32(1); // one memory
    w.u8(0x00); // limits: min only
    w.u32(mod.memPages);
    sections.push(section(5, w.bytes));
  }

  // global section
  if (mod.globals.length) {
    const items = mod.globals.map((g) => {
      const w = new ByteWriter();
      w.u8(vt(g.ty));
      w.u8(g.mutable ? 0x01 : 0x00);
      if (g.ty === 'f64') { w.u8(0x44); w.f64(g.init); } else { w.u8(0x41); w.i32(g.init | 0); }
      w.u8(0x0b);
      return w.bytes;
    });
    sections.push(section(6, vec(items)));
  }

  // export section: every function + memory
  {
    const items: number[][] = [];
    for (const fn of mod.funcs) {
      const w = new ByteWriter();
      w.name(fn.name);
      w.u8(0x00);
      w.u32(funcIndexMap.get(fn.name)!);
      items.push(w.bytes);
    }
    if (mod.usesMemory) {
      const w = new ByteWriter();
      w.name('memory');
      w.u8(0x02);
      w.u32(0);
      items.push(w.bytes);
    }
    sections.push(section(7, vec(items)));
  }

  // code section
  let funcInstrCount = 0;
  let localCount = 0;
  let stackFolded = 0;
  const codeItems = gens.map((g) => {
    const body = new ByteWriter();
    const locals = g.localTypes();
    // run-length encode locals by type
    const rle: { count: number; ty: IRType }[] = [];
    for (const ty of locals) {
      const last = rle[rle.length - 1];
      if (last && last.ty === ty) last.count++;
      else rle.push({ count: 1, ty });
    }
    body.u32(rle.length);
    for (const r of rle) { body.u32(r.count); body.u8(vt(r.ty)); }
    encodeBody(body, g.wtree);
    body.u8(0x0b);
    funcInstrCount += countInstrs(g.wtree);
    localCount += locals.length;
    stackFolded += g.foldedCount;
    const w = new ByteWriter();
    w.u32(body.bytes.length);
    w.raw(body.bytes);
    return w.bytes;
  });
  sections.push(section(10, vec(codeItems)));

  const all = new ByteWriter();
  all.raw(WASM_MAGIC);
  all.raw(WASM_VERSION);
  for (const s of sections) all.raw(s);

  return {
    bytes: new Uint8Array(all.bytes),
    wat: emitWAT(mod, gens, imports),
    funcInstrCount,
    localCount,
    stackFolded,
  };
}

function countInstrs(tree: W[]): number {
  let n = 0;
  for (const node of tree) {
    n++;
    if (node.k === 'block' || node.k === 'loop') n += countInstrs(node.body);
    else if (node.k === 'if') n += countInstrs(node.t) + countInstrs(node.e);
  }
  return n;
}

// --- WAT pretty-printer (textual form, for display) ---

function emitWAT(mod: IRModule, gens: FuncGen[], imports: PrintImport[]): string {
  const lines: string[] = ['(module'];
  for (const im of imports) {
    lines.push(`  (import "env" "${im.field}" (func $${im.field} (param ${im.param})))`);
  }
  if (mod.usesMemory) lines.push(`  (memory (export "memory") ${mod.memPages})`);
  for (const g of mod.globals) {
    const init = g.ty === 'f64' ? `(f64.const ${g.init})` : `(i32.const ${g.init | 0})`;
    lines.push(`  (global $${g.name} (mut ${g.ty}) ${init})`);
  }
  for (const g of gens) {
    const fn = g.fn;
    const ps = fn.params.map((p) => `(param ${p.ty})`).join(' ');
    const rs = fn.retTy === 'void' ? '' : ` (result ${fn.retTy})`;
    lines.push(`  (func $${fn.name} (export "${fn.name}")${ps ? ' ' + ps : ''}${rs}`);
    const locals = g.localTypes();
    if (locals.length) lines.push(`    (local ${locals.join(' ')})`);
    watBody(g.wtree, lines, 2);
    lines.push('  )');
  }
  lines.push(')');
  return lines.join('\n');
}

function watBody(tree: W[], lines: string[], depth: number): void {
  const pad = '  '.repeat(depth);
  for (const n of tree) {
    switch (n.k) {
      case 'block': lines.push(`${pad}block`); watBody(n.body, lines, depth + 1); lines.push(`${pad}end`); break;
      case 'loop': lines.push(`${pad}loop`); watBody(n.body, lines, depth + 1); lines.push(`${pad}end`); break;
      case 'if':
        lines.push(`${pad}if`); watBody(n.t, lines, depth + 1);
        if (n.e.length) { lines.push(`${pad}else`); watBody(n.e, lines, depth + 1); }
        lines.push(`${pad}end`);
        break;
      case 'br': lines.push(`${pad}br ${n.d}`); break;
      case 'ret': lines.push(`${pad}return`); break;
      case 'unreachable': lines.push(`${pad}unreachable`); break;
      case 'lget': lines.push(`${pad}local.get ${n.i}`); break;
      case 'lset': lines.push(`${pad}local.set ${n.i}`); break;
      case 'gget': lines.push(`${pad}global.get ${n.i}`); break;
      case 'gset': lines.push(`${pad}global.set ${n.i}`); break;
      case 'i32c': lines.push(`${pad}i32.const ${n.v | 0}`); break;
      case 'f64c': lines.push(`${pad}f64.const ${n.v}`); break;
      case 'call': lines.push(`${pad}call ${n.i}`); break;
      case 'load': lines.push(`${pad}${n.f64 ? 'f64' : 'i32'}.load`); break;
      case 'store': lines.push(`${pad}${n.f64 ? 'f64' : 'i32'}.store`); break;
      case 'op': lines.push(`${pad}${n.name}`); break;
      case 'trunc': lines.push(`${pad}i32.trunc_sat_f64_s`); break;
      case 'convert': lines.push(`${pad}f64.convert_i32_s`); break;
    }
  }
}
