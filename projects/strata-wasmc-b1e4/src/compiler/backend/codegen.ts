import type { Block, Inst, IRFunc, IRModule, IRType, Operand, RetType, Term } from '../ir/ir';
import { operandType } from '../ir/ir';
import type { Span } from '../diagnostics';
import { ByteWriter, VT_F32, VT_F64, VT_I32, VT_I64, VT_V128, WASM_MAGIC, WASM_VERSION, section, vec } from './encoder';

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

// Structured wasm instruction tree (encoded / pretty-printed below). Every node
// also carries an optional source `s`pan (stamped during emission) so the encoder
// can build a line table mapping each wasm instruction back to the source that
// produced it — the debug info behind the source-level VM debugger.
type WKind =
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
  | { k: 'i64c'; v: bigint }
  | { k: 'f64c'; v: number }
  | { k: 'f32c'; v: number }
  | { k: 'call'; i: number }
  // A function reference: an i32.const of the function's table slot (carries the
  // name purely so the WAT printer can annotate it).
  | { k: 'fref'; v: number; name: string }
  // call_indirect through table 0 with the interned signature type index `t`.
  | { k: 'callind'; t: number }
  | { k: 'load'; mem: 'i32' | 'i64' | 'f64' | 'f32' | 'i8' }
  | { k: 'store'; mem: 'i32' | 'i64' | 'f64' | 'f32' | 'i8' }
  | { k: 'op'; c: number; name: string }
  // A 128-bit SIMD instruction: the 0xfd prefix, a single-byte sub-opcode `op`,
  // and (for lane-indexed ops) an immediate `lane` byte. `name` is the mnemonic
  // for the WAT printer.
  | { k: 'simd'; op: number; lane?: number; name: string }
  // 128-bit SIMD memory access: `v128.load` (0xfd 0x00) / `v128.store` (0xfd 0x0b),
  // each followed by a memarg (align, offset). `align` is only a hint, so 0 is always
  // valid even for unaligned array element data.
  | { k: 'vload' }
  | { k: 'vstore' }
  | { k: 'select' }
  | { k: 'tselect'; ty: IRType }
  | { k: 'cast'; sub: string };
type W = WKind & { s?: Span };

// SIMD sub-opcodes (after the 0xfd prefix). Keyed by the full wasm mnemonic so
// the IR's `sub` string selects directly. Every value here is < 0x80, so its
// unsigned-LEB encoding is a single byte. Lane-indexed ops (`*_lane`) are
// followed by one immediate lane byte.
const SIMD: Record<string, number> = {
  // splat: scalar -> v128
  'i32x4.splat': 0x11, 'i64x2.splat': 0x12, 'f32x4.splat': 0x13, 'f64x2.splat': 0x14,
  // extract_lane / replace_lane (carry a lane immediate)
  'i32x4.extract_lane': 0x1b, 'i32x4.replace_lane': 0x1c,
  'i64x2.extract_lane': 0x1d, 'i64x2.replace_lane': 0x1e,
  'f32x4.extract_lane': 0x1f, 'f32x4.replace_lane': 0x20,
  'f64x2.extract_lane': 0x21, 'f64x2.replace_lane': 0x22,
  // i32x4 integer arithmetic (no SIMD integer divide exists)
  'i32x4.abs': 0xa0, 'i32x4.neg': 0xa1, 'i32x4.add': 0xae, 'i32x4.sub': 0xb1, 'i32x4.mul': 0xb5,
  'i32x4.min_s': 0xb6, 'i32x4.max_s': 0xb8,
  // i64x2 integer arithmetic (no lanewise min/max in the SIMD spec)
  'i64x2.abs': 0xc0, 'i64x2.neg': 0xc1, 'i64x2.add': 0xce, 'i64x2.sub': 0xd1, 'i64x2.mul': 0xd5,
  // f32x4 floating-point arithmetic
  'f32x4.abs': 0xe0, 'f32x4.neg': 0xe1, 'f32x4.sqrt': 0xe3,
  'f32x4.add': 0xe4, 'f32x4.sub': 0xe5, 'f32x4.mul': 0xe6, 'f32x4.div': 0xe7, 'f32x4.min': 0xe8, 'f32x4.max': 0xe9,
  // f64x2 floating-point arithmetic
  'f64x2.abs': 0xec, 'f64x2.neg': 0xed, 'f64x2.sqrt': 0xef,
  'f64x2.add': 0xf0, 'f64x2.sub': 0xf1, 'f64x2.mul': 0xf2, 'f64x2.div': 0xf3, 'f64x2.min': 0xf4, 'f64x2.max': 0xf5,
  // whole-vector bitwise (lane-agnostic; backs &/|/^/~ on integer vectors)
  'v128.not': 0x4d, 'v128.and': 0x4e, 'v128.or': 0x50, 'v128.xor': 0x51,
  // v128.bitselect: lanewise (bitwise) `mask ? a : b`
  'v128.bitselect': 0x52,
  // lanewise comparisons (each true lane is all-ones, false is all-zero)
  'i32x4.eq': 0x37, 'i32x4.ne': 0x38, 'i32x4.lt_s': 0x39, 'i32x4.gt_s': 0x3b, 'i32x4.le_s': 0x3d, 'i32x4.ge_s': 0x3f,
  'i64x2.eq': 0xd6, 'i64x2.ne': 0xd7, 'i64x2.lt_s': 0xd8, 'i64x2.gt_s': 0xd9, 'i64x2.le_s': 0xda, 'i64x2.ge_s': 0xdb,
  'f32x4.eq': 0x41, 'f32x4.ne': 0x42, 'f32x4.lt': 0x43, 'f32x4.gt': 0x44, 'f32x4.le': 0x45, 'f32x4.ge': 0x46,
  'f64x2.eq': 0x47, 'f64x2.ne': 0x48, 'f64x2.lt': 0x49, 'f64x2.gt': 0x4a, 'f64x2.le': 0x4b, 'f64x2.ge': 0x4c,
  // lanewise int<->float conversions (signed, saturating truncation)
  'f32x4.convert_i32x4_s': 0xfa, 'i32x4.trunc_sat_f32x4_s': 0xf8,
};

const I_BIN: Record<string, [number, string]> = {
  add: [0x6a, 'i32.add'], sub: [0x6b, 'i32.sub'], mul: [0x6c, 'i32.mul'],
  div_s: [0x6d, 'i32.div_s'], rem_s: [0x6f, 'i32.rem_s'], and: [0x71, 'i32.and'],
  or: [0x72, 'i32.or'], xor: [0x73, 'i32.xor'], shl: [0x74, 'i32.shl'], shr_s: [0x75, 'i32.shr_s'],
  rotl: [0x77, 'i32.rotl'], rotr: [0x78, 'i32.rotr'],
};
// The i64 counterparts, selected when an integer op's operands are i64.
const I_BIN64: Record<string, [number, string]> = {
  add: [0x7c, 'i64.add'], sub: [0x7d, 'i64.sub'], mul: [0x7e, 'i64.mul'],
  div_s: [0x7f, 'i64.div_s'], rem_s: [0x81, 'i64.rem_s'], and: [0x83, 'i64.and'],
  or: [0x84, 'i64.or'], xor: [0x85, 'i64.xor'], shl: [0x86, 'i64.shl'], shr_s: [0x87, 'i64.shr_s'],
  rotl: [0x89, 'i64.rotl'], rotr: [0x8a, 'i64.rotr'],
};
// Unary integer ops (count leading/trailing zeros, population count).
const I_UN: Record<string, [number, string]> = {
  clz: [0x67, 'i32.clz'], ctz: [0x68, 'i32.ctz'], popcnt: [0x69, 'i32.popcnt'],
};
const I_UN64: Record<string, [number, string]> = {
  clz: [0x79, 'i64.clz'], ctz: [0x7a, 'i64.ctz'], popcnt: [0x7b, 'i64.popcnt'],
};
const F_BIN: Record<string, [number, string]> = {
  add: [0xa0, 'f64.add'], sub: [0xa1, 'f64.sub'], mul: [0xa2, 'f64.mul'], div: [0xa3, 'f64.div'],
  // f64.min / f64.max / f64.copysign back the fmin/fmax/copysign builtins. They
  // are never constant-folded by SCCP (see evalFBin), so the real wasm op is the
  // sole authority on their NaN/signed-zero edge cases.
  min: [0xa4, 'f64.min'], max: [0xa5, 'f64.max'], copysign: [0xa6, 'f64.copysign'],
};
// The f32 (single-precision) counterparts, selected when an fbin/fcmp's operands
// are f32. The IR keeps one generic `add`/`sub`/… sub; the operand value type
// chooses the table — exactly like the i32/i64 integer split above.
const F_BIN32: Record<string, [number, string]> = {
  add: [0x92, 'f32.add'], sub: [0x93, 'f32.sub'], mul: [0x94, 'f32.mul'], div: [0x95, 'f32.div'],
  min: [0x96, 'f32.min'], max: [0x97, 'f32.max'], copysign: [0x98, 'f32.copysign'],
};
const I_CMP: Record<string, [number, string]> = {
  eq: [0x46, 'i32.eq'], ne: [0x47, 'i32.ne'], lt_s: [0x48, 'i32.lt_s'],
  gt_s: [0x4a, 'i32.gt_s'], le_s: [0x4c, 'i32.le_s'], ge_s: [0x4e, 'i32.ge_s'],
};
const I_CMP64: Record<string, [number, string]> = {
  eq: [0x51, 'i64.eq'], ne: [0x52, 'i64.ne'], lt_s: [0x53, 'i64.lt_s'],
  gt_s: [0x55, 'i64.gt_s'], le_s: [0x57, 'i64.le_s'], ge_s: [0x59, 'i64.ge_s'],
};
// Conversion opcodes keyed by IR cast sub. f2i/f2l use the saturating-truncation
// prefix (0xfc), so they never trap on NaN/overflow — matching the interpreter.
const CAST_OP: Record<string, { bytes: number[]; name: string }> = {
  i2f: { bytes: [0xb7], name: 'f64.convert_i32_s' },
  f2i: { bytes: [0xfc, 0x02], name: 'i32.trunc_sat_f64_s' },
  i2l: { bytes: [0xac], name: 'i64.extend_i32_s' },
  l2i: { bytes: [0xa7], name: 'i32.wrap_i64' },
  l2f: { bytes: [0xb9], name: 'f64.convert_i64_s' },
  f2l: { bytes: [0xfc, 0x06], name: 'i64.trunc_sat_f64_s' },
  // Bit-pattern reinterpretation (no value conversion): used by the float-format
  // runtime to pull the IEEE-754 bits of a double into a `long` and back. These
  // are the only way the language's own code can inspect a float's representation.
  reinterp_f2l: { bytes: [0xbd], name: 'i64.reinterpret_f64' },
  reinterp_l2f: { bytes: [0xbf], name: 'f64.reinterpret_i64' },
  // f32 (single-precision) conversions. demote/promote move between f32 and f64;
  // the int conversions use the saturating-truncation prefix (0xfc) like f2i/f2l.
  i2f32: { bytes: [0xb2], name: 'f32.convert_i32_s' },
  l2f32: { bytes: [0xb4], name: 'f32.convert_i64_s' },
  f2f32: { bytes: [0xb6], name: 'f32.demote_f64' },
  f32_2f: { bytes: [0xbb], name: 'f64.promote_f32' },
  f32_2i: { bytes: [0xfc, 0x00], name: 'i32.trunc_sat_f32_s' },
  f32_2l: { bytes: [0xfc, 0x04], name: 'i64.trunc_sat_f32_s' },
  // Unary f64 math, modeled as single-operand "casts" (f64 -> f64). Each is a
  // pure, non-trapping wasm opcode, so SCCP leaves them unfolded (default NAC),
  // and the stackifier / LICM / if-conversion treat them like any pure value.
  f_sqrt: { bytes: [0x9f], name: 'f64.sqrt' },
  f_floor: { bytes: [0x9c], name: 'f64.floor' },
  f_ceil: { bytes: [0x9b], name: 'f64.ceil' },
  f_trunc: { bytes: [0x9d], name: 'f64.trunc' },
  f_nearest: { bytes: [0x9e], name: 'f64.nearest' },
  f_abs: { bytes: [0x99], name: 'f64.abs' },
};
const F_CMP: Record<string, [number, string]> = {
  eq: [0x61, 'f64.eq'], ne: [0x62, 'f64.ne'], lt: [0x63, 'f64.lt'],
  gt: [0x64, 'f64.gt'], le: [0x65, 'f64.le'], ge: [0x66, 'f64.ge'],
};
const F_CMP32: Record<string, [number, string]> = {
  eq: [0x5b, 'f32.eq'], ne: [0x5c, 'f32.ne'], lt: [0x5d, 'f32.lt'],
  gt: [0x5e, 'f32.gt'], le: [0x5f, 'f32.le'], ge: [0x60, 'f32.ge'],
};

interface Frame {
  kind: 'block' | 'loop' | 'if';
  node: number; // -1 for if frames
}

interface Resolvers {
  globalIndex: (name: string) => number;
  printIndex: (kind: string) => number;
  callIndex: (name: string) => number;
  /** A function's slot in the wasm function table (the value of a funcaddr). */
  funcSlot: (name: string) => number;
  /** Intern an indirect-call signature key (`p1,p2->ret`) → wasm type index. */
  indirectType: (sigKey: string) => number;
}

// Pure value families that produce no side effect and never trap, so they may
// be recomputed at (i.e. sunk to) their single use without changing behavior.
// Integer div_s/rem_s are deliberately absent — they can trap, so sinking them
// past a side effect could reorder an observable trap.
const STACKIFIABLE = new Set(['ibin', 'iunary', 'fbin', 'icmp', 'fcmp', 'cast', 'select', 'copy', 'vbin', 'vunary', 'vsplat', 'vextract', 'vreplace', 'vselect']);

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
      case 'ret': {
        const out: W[] = t.value ? [...this.pushOperand(t.value), { k: 'ret' }] : [{ k: 'ret' }];
        if (t.span) for (const w of out) if (w.s === undefined) w.s = t.span;
        return out;
      }
      case 'unreachable':
        return [{ k: 'unreachable' }];
      case 'br':
        return this.doBranch(id, t.target, ctx);
      case 'condbr': {
        const inner: Frame[] = [...ctx, { kind: 'if', node: -1 }];
        // Tag the condition's operand pushes + the `if` opener with the branch's
        // source span; the nested arm bodies keep the spans of their own
        // statements (set during their emission), so don't overwrite them.
        const cond = this.pushOperand(t.cond);
        if (t.span) for (const w of cond) if (w.s === undefined) w.s = t.span;
        return [
          ...cond,
          { k: 'if', t: this.doBranch(id, t.t, inner), e: this.doBranch(id, t.f, inner), s: t.span },
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
    if (o.tag === 'const') {
      if (o.ty === 'f64') return [{ k: 'f64c', v: o.num as number }];
      if (o.ty === 'f32') return [{ k: 'f32c', v: Math.fround(o.num as number) }];
      if (o.ty === 'i64') return [{ k: 'i64c', v: o.num as bigint }];
      return [{ k: 'i32c', v: (o.num as number) | 0 }];
    }
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
    // Record where this instruction's wasm begins, so afterwards we can tag every
    // node it emitted (that a nested folded sub-expression didn't already tag)
    // with this instruction's source span — the raw material of the line table.
    const start = out.length;
    this.emitValueInner(inst, out);
    if (inst.span) for (let i = start; i < out.length; i++) if (out[i].s === undefined) out[i].s = inst.span;
  }

  private emitValueInner(inst: Inst, out: W[]): void {
    switch (inst.kind) {
      case 'ibin': {
        const [c, name] = (operandType(this.fn, inst.args[0]) === 'i64' ? I_BIN64 : I_BIN)[inst.sub];
        out.push(...this.pushOperand(inst.args[0]), ...this.pushOperand(inst.args[1]), { k: 'op', c, name });
        break;
      }
      case 'iunary': {
        const [c, name] = (operandType(this.fn, inst.args[0]) === 'i64' ? I_UN64 : I_UN)[inst.sub];
        out.push(...this.pushOperand(inst.args[0]), { k: 'op', c, name });
        break;
      }
      case 'fbin': {
        const [c, name] = (operandType(this.fn, inst.args[0]) === 'f32' ? F_BIN32 : F_BIN)[inst.sub];
        out.push(...this.pushOperand(inst.args[0]), ...this.pushOperand(inst.args[1]), { k: 'op', c, name });
        break;
      }
      case 'icmp': {
        // Comparisons return i32 (bool) but their opcode depends on the operand
        // width, so select the i64 table when the operands are i64.
        const [c, name] = (operandType(this.fn, inst.args[0]) === 'i64' ? I_CMP64 : I_CMP)[inst.sub];
        out.push(...this.pushOperand(inst.args[0]), ...this.pushOperand(inst.args[1]), { k: 'op', c, name });
        break;
      }
      case 'fcmp': {
        const [c, name] = (operandType(this.fn, inst.args[0]) === 'f32' ? F_CMP32 : F_CMP)[inst.sub];
        out.push(...this.pushOperand(inst.args[0]), ...this.pushOperand(inst.args[1]), { k: 'op', c, name });
        break;
      }
      case 'cast':
        out.push(...this.pushOperand(inst.args[0]), { k: 'cast', sub: inst.sub });
        break;
      case 'vsplat':
        out.push(...this.pushOperand(inst.args[0]), { k: 'simd', op: SIMD[inst.sub + '.splat'], name: inst.sub + '.splat' });
        break;
      case 'vunary':
        out.push(...this.pushOperand(inst.args[0]), { k: 'simd', op: SIMD[inst.sub], name: inst.sub });
        break;
      case 'vbin':
        out.push(...this.pushOperand(inst.args[0]), ...this.pushOperand(inst.args[1]), { k: 'simd', op: SIMD[inst.sub], name: inst.sub });
        break;
      case 'vextract': {
        const [mn, ln] = inst.sub.split(':');
        out.push(...this.pushOperand(inst.args[0]), { k: 'simd', op: SIMD[mn], lane: Number(ln), name: `${mn} ${ln}` });
        break;
      }
      case 'vreplace': {
        const [mn, ln] = inst.sub.split(':');
        out.push(...this.pushOperand(inst.args[0]), ...this.pushOperand(inst.args[1]), { k: 'simd', op: SIMD[mn], lane: Number(ln), name: `${mn} ${ln}` });
        break;
      }
      case 'vselect':
        // v128.bitselect pops (a, b, mask) and yields, per bit, mask ? a : b.
        out.push(...this.pushOperand(inst.args[0]), ...this.pushOperand(inst.args[1]), ...this.pushOperand(inst.args[2]),
          { k: 'simd', op: SIMD['v128.bitselect'], name: 'v128.bitselect' });
        break;
      case 'select': {
        // wasm `select`: [a, b, cond] -> a if cond!=0 else b. The bare opcode is
        // untyped (valid for i32/i64/f32/f64); a `v128` result needs the *typed*
        // select form, which carries an explicit result valtype.
        const ty = operandType(this.fn, inst.args[0]);
        out.push(...this.pushOperand(inst.args[0]), ...this.pushOperand(inst.args[1]), ...this.pushOperand(inst.args[2]),
          ty === 'v128' ? { k: 'tselect', ty } : { k: 'select' });
        break;
      }
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
        out.push(...this.pushOperand(inst.args[0]), { k: 'load', mem: inst.sub as 'i32' | 'i64' | 'f64' | 'i8' });
        break;
      case 'store':
        out.push(...this.pushOperand(inst.args[0]), ...this.pushOperand(inst.args[1]), { k: 'store', mem: inst.sub as 'i32' | 'i64' | 'f64' | 'i8' });
        break;
      case 'vload':
        out.push(...this.pushOperand(inst.args[0]), { k: 'vload' });
        break;
      case 'vstore':
        out.push(...this.pushOperand(inst.args[0]), ...this.pushOperand(inst.args[1]), { k: 'vstore' });
        break;
      case 'print':
        out.push(...this.pushOperand(inst.args[0]), { k: 'call', i: this.res.printIndex(inst.sub) });
        break;
      case 'call':
        for (const a of inst.args) out.push(...this.pushOperand(a));
        out.push({ k: 'call', i: this.res.callIndex(inst.sub) });
        break;
      case 'funcaddr':
        out.push({ k: 'fref', v: this.res.funcSlot(inst.sub), name: inst.sub });
        break;
      case 'callind':
        // call_indirect: push the call arguments, then the table index, then the
        // indirect-call opcode (signature type interned from `inst.sub`).
        for (let k = 1; k < inst.args.length; k++) out.push(...this.pushOperand(inst.args[k]));
        out.push(...this.pushOperand(inst.args[0]));
        out.push({ k: 'callind', t: this.res.indirectType(inst.sub) });
        break;
    }
  }

  private emitStraightLine(id: number): W[] {
    const out: W[] = [];
    for (const inst of this.byId.get(id)!.insts) {
      if (inst.res !== null && this.inlined.has(inst.res)) continue; // folded into its single use
      this.emitValue(inst, out);
      if (inst.res !== null) out.push({ k: 'lset', i: this.li(inst.res), s: inst.span });
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

// Encode the instruction tree to bytes. When `spans` is supplied, it is filled
// with exactly one entry per emitted wasm instruction, in the same order the
// disassembler reads them back — so `spans[pc]` is the source location of the
// instruction at index `pc` in the decoded body. Block/loop/if openers, `else`
// and `end` markers are real instructions in that stream and each gets an entry
// (`end`/`else` map to nothing, hence null). This 1:1, encoder-is-the-decoder's-
// inverse alignment is what keeps the line table exact across every opcode.
function encodeBody(w: ByteWriter, tree: W[], spans?: (Span | null)[]): void {
  for (const n of tree) {
    if (n.k !== 'block' && n.k !== 'loop' && n.k !== 'if') spans?.push(n.s ?? null);
    switch (n.k) {
      case 'block':
        spans?.push(n.s ?? null);
        w.u8(0x02); w.u8(0x40); encodeBody(w, n.body, spans); w.u8(0x0b);
        spans?.push(null);
        break;
      case 'loop':
        spans?.push(n.s ?? null);
        w.u8(0x03); w.u8(0x40); encodeBody(w, n.body, spans); w.u8(0x0b);
        spans?.push(null);
        break;
      case 'if':
        spans?.push(n.s ?? null);
        w.u8(0x04); w.u8(0x40); encodeBody(w, n.t, spans);
        if (n.e.length) { spans?.push(null); w.u8(0x05); encodeBody(w, n.e, spans); }
        w.u8(0x0b);
        spans?.push(null);
        break;
      case 'br': w.u8(0x0c); w.u32(n.d); break;
      case 'ret': w.u8(0x0f); break;
      case 'unreachable': w.u8(0x00); break;
      case 'lget': w.u8(0x20); w.u32(n.i); break;
      case 'lset': w.u8(0x21); w.u32(n.i); break;
      case 'gget': w.u8(0x23); w.u32(n.i); break;
      case 'gset': w.u8(0x24); w.u32(n.i); break;
      case 'i32c': w.u8(0x41); w.i32(n.v); break;
      case 'i64c': w.u8(0x42); w.i64(n.v); break;
      case 'f64c': w.u8(0x44); w.f64(n.v); break;
      case 'f32c': w.u8(0x43); w.f32(n.v); break;
      case 'call': w.u8(0x10); w.u32(n.i); break;
      case 'fref': w.u8(0x41); w.i32(n.v); break; // i32.const table-slot
      case 'callind': w.u8(0x11); w.u32(n.t); w.u32(0); break; // call_indirect typeidx table 0
      case 'load': {
        const [op, align] = n.mem === 'i64' ? [0x29, 3] : n.mem === 'f64' ? [0x2b, 3] : n.mem === 'f32' ? [0x2a, 2] : n.mem === 'i8' ? [0x2d, 0] : [0x28, 2];
        w.u8(op); w.u32(align); w.u32(0); break;
      }
      case 'store': {
        const [op, align] = n.mem === 'i64' ? [0x37, 3] : n.mem === 'f64' ? [0x39, 3] : n.mem === 'f32' ? [0x38, 2] : n.mem === 'i8' ? [0x3a, 0] : [0x36, 2];
        w.u8(op); w.u32(align); w.u32(0); break;
      }
      case 'op': w.u8(n.c); break;
      case 'simd': w.u8(0xfd); w.u32(n.op); if (n.lane !== undefined) w.u8(n.lane); break;
      case 'vload': w.u8(0xfd); w.u32(0x00); w.u32(0); w.u32(0); break; // v128.load align=0 offset=0
      case 'vstore': w.u8(0xfd); w.u32(0x0b); w.u32(0); w.u32(0); break; // v128.store align=0 offset=0
      case 'select': w.u8(0x1b); break; // select (untyped — valid for numeric types incl. i64)
      case 'tselect': w.u8(0x1c); w.u32(1); w.u8(vt(n.ty)); break; // typed select (required for v128)
      case 'cast': for (const b of CAST_OP[n.sub].bytes) w.u8(b); break;
    }
  }
}

const vt = (t: IRType): number => (t === 'f64' ? VT_F64 : t === 'f32' ? VT_F32 : t === 'i64' ? VT_I64 : t === 'v128' ? VT_V128 : VT_I32);

interface PrintImport {
  kind: string;
  field: string;
  param: IRType;
}

// A single source location in the line table.
export interface LineEntry {
  line: number; // 1-based source line
  col: number; // 1-based source column
}

// The wasm line table: for each defined function (in code-section order, which is
// the VM's `defIndex` order), one source location per wasm instruction, aligned
// 1:1 with the disassembled instruction stream. `null` entries are structural
// instructions (`end`/`else`) or code with no source origin (e.g. injected
// prelude). This is the project's DWARF-lite — it lets the source-level debugger
// map the program counter of the real, optimized bytecode back to a source line.
export interface DebugInfo {
  funcs: { name: string; spans: (LineEntry | null)[] }[];
}

export interface CodegenResult {
  bytes: Uint8Array;
  wat: string;
  funcInstrCount: number;
  localCount: number; // total declared locals across all functions (lower = better)
  stackFolded: number; // values kept on the operand stack (no local at all)
  debug: DebugInfo; // wasm → source line table for the debugger
}

export function codegen(mod: IRModule): CodegenResult {
  // discover which print imports are used
  const usedPrints = new Set<string>();
  for (const fn of mod.funcs) for (const b of fn.blocks) for (const i of b.insts) if (i.kind === 'print') usedPrints.add(i.sub);
  const imports: PrintImport[] = (['int', 'long', 'float', 'bool', 'str'] as const)
    .filter((k) => usedPrints.has(k))
    .map((k) => ({ kind: k, field: `print_${k}`, param: k === 'float' ? 'f64' : k === 'long' ? 'i64' : 'i32' }));
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

  // Intern the signature an indirect call references (key: `p1,p2->ret`). It
  // deduplicates against the direct functions' types, so a `call_indirect` and a
  // matching direct callee share one type-section entry.
  const indirectType = (sigKey: string): number => {
    const [ps, rs] = sigKey.split('->');
    const params = (ps === '' ? [] : ps.split(',')) as IRType[];
    return internType(params, [rs as RetType]);
  };

  // Does any function take a function's address or call indirectly? If so the
  // module needs a function table + element segment.
  let needsTable = false;
  for (const fn of mod.funcs)
    for (const b of fn.blocks)
      for (const i of b.insts)
        if (i.kind === 'funcaddr' || i.kind === 'callind') needsTable = true;

  // --- codegen each function (also yields WAT + metrics) ---
  const resolvers = {
    globalIndex: (name: string) => globalIndexMap.get(name)!,
    printIndex: (kind: string) => printIndexMap.get(kind)!,
    callIndex: (name: string) => funcIndexMap.get(name)!,
    // Table slot (i+1) ↔ mod.funcs[i]: slot 0 is reserved as a null `funcref` so
    // an unassigned function pointer (the i32 0 that `null` and a fresh `fn_array`
    // element lower to) traps when called. The element segment fills slots 1..N.
    funcSlot: (name: string) => funcIndexMap.get(name)! - importCount + 1,
    indirectType,
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

  // table section (4): a single funcref table holding every function, so any
  // function's address can be taken and dispatched through `call_indirect`. Slot 0
  // is left as the default null `funcref` (a "no function" sentinel that traps on
  // call); the N real functions occupy slots 1..N, hence the size is N+1.
  if (needsTable) {
    const w = new ByteWriter();
    w.u32(1); // one table
    w.u8(0x70); // element type: funcref
    w.u8(0x00); // limits: min only
    w.u32(mod.funcs.length + 1);
    sections.push(section(4, w.bytes));
  }

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
      if (g.ty === 'f64') { w.u8(0x44); w.f64(g.init as number); }
      else if (g.ty === 'f32') { w.u8(0x43); w.f32(Math.fround(g.init as number)); }
      else if (g.ty === 'i64') { w.u8(0x42); w.i64(g.init as bigint); }
      else { w.u8(0x41); w.i32((g.init as number) | 0); }
      w.u8(0x0b);
      return w.bytes;
    });
    sections.push(section(6, vec(items)));
  }

  // export section: exported functions (typically just main) + memory
  {
    const items: number[][] = [];
    for (const fn of mod.funcs) {
      if (!fn.exported) continue;
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

  // element section (9): one active segment filling table[1..N] with the wasm
  // index of every function, so table slot (i+1) resolves to mod.funcs[i]. Slot 0
  // stays the default null `funcref`.
  if (needsTable) {
    const seg = new ByteWriter();
    seg.u8(0x00); // active segment, table 0, offset expression follows
    seg.u8(0x41); seg.i32(1); seg.u8(0x0b); // (i32.const 1) end
    seg.u32(mod.funcs.length);
    for (let i = 0; i < mod.funcs.length; i++) seg.u32(importCount + i);
    const body = new ByteWriter();
    body.u32(1); // one segment
    body.raw(seg.bytes);
    sections.push(section(9, body.bytes));
  }

  // code section
  let funcInstrCount = 0;
  let localCount = 0;
  let stackFolded = 0;
  const lineTables: (Span | null)[][] = [];
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
    const fnSpans: (Span | null)[] = [];
    encodeBody(body, g.wtree, fnSpans);
    body.u8(0x0b);
    fnSpans.push(null); // the trailing function `end` is one decoded instruction too
    lineTables.push(fnSpans);
    funcInstrCount += countInstrs(g.wtree);
    localCount += locals.length;
    stackFolded += g.foldedCount;
    const w = new ByteWriter();
    w.u32(body.bytes.length);
    w.raw(body.bytes);
    return w.bytes;
  });
  sections.push(section(10, vec(codeItems)));

  // data section: one active segment that copies the interned string literals
  // into linear memory at startup (offset = mod.staticData.offset).
  if (mod.staticData && mod.staticData.bytes.length) {
    const seg = new ByteWriter();
    seg.u8(0x00); // active segment, memory 0, offset expression follows
    seg.u8(0x41); seg.i32(mod.staticData.offset); seg.u8(0x0b); // (i32.const off) end
    seg.u32(mod.staticData.bytes.length);
    seg.raw(mod.staticData.bytes);
    const body = new ByteWriter();
    body.u32(1); // one segment
    body.raw(seg.bytes);
    sections.push(section(11, body.bytes));
  }

  const all = new ByteWriter();
  all.raw(WASM_MAGIC);
  all.raw(WASM_VERSION);
  for (const s of sections) all.raw(s);

  const debug: DebugInfo = {
    funcs: mod.funcs.map((fn, i) => ({
      name: fn.name,
      spans: lineTables[i].map((s) => (s ? { line: s.line, col: s.col } : null)),
    })),
  };

  return {
    bytes: new Uint8Array(all.bytes),
    wat: emitWAT(mod, gens, imports),
    funcInstrCount,
    localCount,
    stackFolded,
    debug,
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
  const usesTable = mod.funcs.some((fn) => fn.blocks.some((b) => b.insts.some((i) => i.kind === 'funcaddr' || i.kind === 'callind')));
  if (usesTable) {
    lines.push(`  (table ${mod.funcs.length + 1} funcref)`);
    lines.push(`  (elem (i32.const 1) ${mod.funcs.map((fn) => `$${fn.name}`).join(' ')})`);
  }
  if (mod.staticData && mod.staticData.bytes.length) {
    const esc = mod.staticData.bytes
      .map((b) => (b >= 0x20 && b < 0x7f && b !== 0x22 && b !== 0x5c ? String.fromCharCode(b) : '\\' + b.toString(16).padStart(2, '0')))
      .join('');
    lines.push(`  (data (i32.const ${mod.staticData.offset}) "${esc}")`);
  }
  for (const g of mod.globals) {
    const init = g.ty === 'f64' ? `(f64.const ${g.init})`
      : g.ty === 'f32' ? `(f32.const ${Math.fround(g.init as number)})`
      : g.ty === 'i64' ? `(i64.const ${g.init})`
      : `(i32.const ${(g.init as number) | 0})`;
    lines.push(`  (global $${g.name} (mut ${g.ty}) ${init})`);
  }
  for (const g of gens) {
    const fn = g.fn;
    const ps = fn.params.map((p) => `(param ${p.ty})`).join(' ');
    const rs = fn.retTy === 'void' ? '' : ` (result ${fn.retTy})`;
    const exp = fn.exported ? ` (export "${fn.name}")` : '';
    lines.push(`  (func $${fn.name}${exp}${ps ? ' ' + ps : ''}${rs}`);
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
      case 'i64c': lines.push(`${pad}i64.const ${n.v}`); break;
      case 'f64c': lines.push(`${pad}f64.const ${n.v}`); break;
      case 'f32c': lines.push(`${pad}f32.const ${Math.fround(n.v)}`); break;
      case 'call': lines.push(`${pad}call ${n.i}`); break;
      case 'fref': lines.push(`${pad}i32.const ${n.v}  ;; ref.func $${n.name}`); break;
      case 'callind': lines.push(`${pad}call_indirect (type ${n.t})`); break;
      case 'load': lines.push(`${pad}${n.mem === 'i64' ? 'i64.load' : n.mem === 'f64' ? 'f64.load' : n.mem === 'f32' ? 'f32.load' : n.mem === 'i8' ? 'i32.load8_u' : 'i32.load'}`); break;
      case 'store': lines.push(`${pad}${n.mem === 'i64' ? 'i64.store' : n.mem === 'f64' ? 'f64.store' : n.mem === 'f32' ? 'f32.store' : n.mem === 'i8' ? 'i32.store8' : 'i32.store'}`); break;
      case 'op': lines.push(`${pad}${n.name}`); break;
      case 'simd': lines.push(`${pad}${n.name}`); break;
      case 'vload': lines.push(`${pad}v128.load`); break;
      case 'vstore': lines.push(`${pad}v128.store`); break;
      case 'select': lines.push(`${pad}select`); break;
      case 'tselect': lines.push(`${pad}select (result ${n.ty})`); break;
      case 'cast': lines.push(`${pad}${CAST_OP[n.sub].name}`); break;
    }
  }
}
