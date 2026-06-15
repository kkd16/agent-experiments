import type { Block, ConstNum, Inst, IRFunc, IRModule, IRType, Operand, Phi } from '../ir/ir';
import { eachOperand, hasSideEffect, isPureValue, zeroOf } from '../ir/ir';
import { computeDom, succOfTerm } from '../ir/cfg';
import { dumpModule } from '../irdump';
import { i32, satTruncI32, rotl32, rotr32, rotl64, rotr64 } from '../interp';

// The optimization pipeline. Every pass works on the SSA IR in place and
// returns the number of changes it made, which the pass manager records so the
// UI can show exactly what each pass accomplished.

export interface PassStat {
  name: string;
  changed: number;
}
export type OptLevel = 0 | 1 | 2 | 3;

// --- cloning (so the UI can keep the unoptimized IR alongside the optimized) ---

export function cloneModule(mod: IRModule): IRModule {
  return {
    funcs: mod.funcs.map(cloneFunc),
    globals: mod.globals.map((g) => ({ ...g })),
    usesMemory: mod.usesMemory,
    memPages: mod.memPages,
    staticData: mod.staticData,
  };
}
function cloneOperand(o: Operand): Operand {
  return o.tag === 'const' ? { tag: 'const', ty: o.ty, num: o.num } : { tag: 'val', id: o.id };
}
function cloneFunc(fn: IRFunc): IRFunc {
  return {
    name: fn.name,
    params: fn.params.map((p) => ({ ...p })),
    retTy: fn.retTy,
    entry: fn.entry,
    exported: fn.exported,
    valueType: new Map(fn.valueType),
    blocks: fn.blocks.map((b) => ({
      id: b.id,
      preds: [...b.preds],
      phis: b.phis.map((p) => ({ res: p.res, ty: p.ty, incomings: p.incomings.map((i) => ({ pred: i.pred, val: cloneOperand(i.val) })) })),
      insts: b.insts.map((i) => ({ res: i.res, ty: i.ty, kind: i.kind, sub: i.sub, args: i.args.map(cloneOperand) })),
      term: cloneTerm(b.term),
    })),
  };
}
function cloneTerm(t: Block['term']): Block['term'] {
  switch (t.op) {
    case 'br':
      return { op: 'br', target: t.target };
    case 'condbr':
      return { op: 'condbr', cond: cloneOperand(t.cond), t: t.t, f: t.f };
    case 'ret':
      return { op: 'ret', value: t.value ? cloneOperand(t.value) : null };
    case 'unreachable':
      return { op: 'unreachable' };
  }
}

// --- generic use rewriting ---

function replaceAllUses(fn: IRFunc, fromId: number, to: Operand): number {
  let n = 0;
  for (const b of fn.blocks) {
    eachOperand(b, (o, set) => {
      if (o.tag === 'val' && o.id === fromId) {
        set(cloneOperand(to));
        n++;
      }
    });
  }
  return n;
}

function countUses(fn: IRFunc): Map<number, number> {
  const counts = new Map<number, number>();
  for (const b of fn.blocks) {
    eachOperand(b, (o) => {
      if (o.tag === 'val') counts.set(o.id, (counts.get(o.id) ?? 0) + 1);
    });
  }
  return counts;
}

// --- constant evaluation (must match interp/wasm semantics exactly) ---

function evalIBin(sub: string, a: number, b: number): number | null {
  switch (sub) {
    case 'add': return i32(a + b);
    case 'sub': return i32(a - b);
    case 'mul': return Math.imul(a, b);
    case 'div_s': return b === 0 || (a === -2147483648 && b === -1) ? null : i32(Math.trunc(a / b));
    case 'rem_s': return b === 0 ? null : a === -2147483648 && b === -1 ? 0 : i32(a % b);
    case 'and': return i32(a & b);
    case 'or': return i32(a | b);
    case 'xor': return i32(a ^ b);
    case 'shl': return i32(a << (b & 31));
    case 'shr_s': return i32(a >> (b & 31));
    case 'rotl': return rotl32(a, b);
    case 'rotr': return rotr32(a, b);
    default: return null;
  }
}
function evalICmp(sub: string, a: number, b: number): number {
  switch (sub) {
    case 'eq': return a === b ? 1 : 0;
    case 'ne': return a !== b ? 1 : 0;
    case 'lt_s': return a < b ? 1 : 0;
    case 'le_s': return a <= b ? 1 : 0;
    case 'gt_s': return a > b ? 1 : 0;
    case 'ge_s': return a >= b ? 1 : 0;
    default: return 0;
  }
}
// JS `number` *is* an IEEE-754 f64 evaluated round-to-nearest, so folding
// +,-,*,/ here matches the wasm f64 op bit-for-bit. `min`/`max`/`copysign` have
// signed-zero / NaN subtleties, so they return `null` (unfoldable) — the real
// wasm op stays their sole authority and a fold can never disagree with it.
function evalFBin(sub: string, a: number, b: number): number | null {
  switch (sub) {
    case 'add': return a + b;
    case 'sub': return a - b;
    case 'mul': return a * b;
    case 'div': return a / b;
    default: return null;
  }
}
function evalFCmp(sub: string, a: number, b: number): number {
  switch (sub) {
    case 'eq': return a === b ? 1 : 0;
    case 'ne': return a !== b ? 1 : 0;
    case 'lt': return a < b ? 1 : 0;
    case 'le': return a <= b ? 1 : 0;
    case 'gt': return a > b ? 1 : 0;
    case 'ge': return a >= b ? 1 : 0;
    default: return 0;
  }
}

// 64-bit integer constant folding. BigInt with explicit `asIntN(64, …)` wrapping
// reproduces wasm i64 semantics exactly: truncating signed division (with the
// `MIN/-1` trap surfaced as `null`), sign-magnitude remainder, and 6-bit-masked
// shifts. Used by SCCP so `long` constants fold just like `int` ones.
const W64 = (x: bigint): bigint => BigInt.asIntN(64, x);
const I64_MIN = -(2n ** 63n);
function evalIBin64(sub: string, a: bigint, b: bigint): bigint | null {
  switch (sub) {
    case 'add': return W64(a + b);
    case 'sub': return W64(a - b);
    case 'mul': return W64(a * b);
    case 'div_s': return b === 0n || (a === I64_MIN && b === -1n) ? null : W64(a / b);
    case 'rem_s': return b === 0n ? null : a === I64_MIN && b === -1n ? 0n : W64(a % b);
    case 'and': return W64(a & b);
    case 'or': return W64(a | b);
    case 'xor': return W64(a ^ b);
    case 'shl': return W64(a << (b & 63n));
    case 'shr_s': return W64(a >> (b & 63n));
    case 'rotl': return rotl64(a, b);
    case 'rotr': return rotr64(a, b);
    default: return null;
  }
}
function evalICmp64(sub: string, a: bigint, b: bigint): number {
  switch (sub) {
    case 'eq': return a === b ? 1 : 0;
    case 'ne': return a !== b ? 1 : 0;
    case 'lt_s': return a < b ? 1 : 0;
    case 'le_s': return a <= b ? 1 : 0;
    case 'gt_s': return a > b ? 1 : 0;
    case 'ge_s': return a >= b ? 1 : 0;
    default: return 0;
  }
}

const C = (ty: IRType, num: ConstNum): Operand => ({ tag: 'const', ty, num: ty === 'i32' ? i32(num as number) : num });

// =====================================================================
// SCCP — Sparse Conditional Constant Propagation
// =====================================================================

type Lat = { t: 'undef' } | { t: 'const'; ty: IRType; num: ConstNum } | { t: 'nac' };
const UNDEF: Lat = { t: 'undef' };
const NAC: Lat = { t: 'nac' };

function meet(a: Lat, b: Lat): Lat {
  if (a.t === 'undef') return b;
  if (b.t === 'undef') return a;
  if (a.t === 'nac' || b.t === 'nac') return NAC;
  return a.ty === b.ty && Object.is(a.num, b.num) ? a : NAC;
}
function lower(prev: Lat, next: Lat): boolean {
  return prev.t !== next.t || (prev.t === 'const' && next.t === 'const' && !(prev.ty === next.ty && Object.is(prev.num, next.num)));
}

export function sccp(fn: IRFunc): number {
  const val = new Map<number, Lat>();
  // Parameters are unknown on entry — seed them as overdefined (NAC), otherwise
  // they would stay UNDEF and falsely make conditions/loops look unreachable.
  for (let i = 0; i < fn.params.length; i++) val.set(i, NAC);
  const exec = new Set<number>([fn.entry]);
  const edge = new Set<string>();
  const latOf = (o: Operand): Lat => (o.tag === 'const' ? { t: 'const', ty: o.ty, num: o.num } : val.get(o.id) ?? UNDEF);
  const setVal = (id: number, l: Lat): boolean => {
    const prev = val.get(id) ?? UNDEF;
    const m = meet(prev, l);
    if (lower(prev, m)) {
      val.set(id, m);
      return true;
    }
    return false;
  };
  const evalInst = (inst: Inst): Lat => {
    const a = inst.args.map(latOf);
    switch (inst.kind) {
      case 'copy':
        return a[0];
      case 'cast': {
        if (a[0].t !== 'const') return a[0];
        const n = a[0].num;
        switch (inst.sub) {
          case 'i2f': return { t: 'const', ty: 'f64', num: n as number };
          case 'f2i': return { t: 'const', ty: 'i32', num: satTruncI32(n as number) };
          case 'i2l': return { t: 'const', ty: 'i64', num: BigInt(n as number) }; // i32 widen, sign-extended
          case 'l2i': return { t: 'const', ty: 'i32', num: Number(BigInt.asIntN(32, n as bigint)) };
          // l2f / f2l involve float rounding; leave them unfolded (overdefined) so
          // the result can only ever come from the real wasm op — never a mismatch.
          default: return NAC;
        }
      }
      case 'ibin':
      case 'icmp':
      case 'fbin':
      case 'fcmp': {
        if (a[0].t === 'nac' || a[1].t === 'nac') return NAC;
        if (a[0].t !== 'const' || a[1].t !== 'const') return UNDEF;
        const i64 = a[0].ty === 'i64'; // both integer operands share a type
        if (inst.kind === 'ibin') {
          if (i64) {
            const r = evalIBin64(inst.sub, a[0].num as bigint, a[1].num as bigint);
            return r === null ? NAC : { t: 'const', ty: 'i64', num: r };
          }
          const r = evalIBin(inst.sub, a[0].num as number, a[1].num as number);
          return r === null ? NAC : { t: 'const', ty: 'i32', num: r };
        }
        if (inst.kind === 'icmp') {
          const r = i64
            ? evalICmp64(inst.sub, a[0].num as bigint, a[1].num as bigint)
            : evalICmp(inst.sub, a[0].num as number, a[1].num as number);
          return { t: 'const', ty: 'i32', num: r };
        }
        if (inst.kind === 'fbin') {
          const r = evalFBin(inst.sub, a[0].num as number, a[1].num as number);
          return r === null ? NAC : { t: 'const', ty: 'f64', num: r };
        }
        return { t: 'const', ty: 'i32', num: evalFCmp(inst.sub, a[0].num as number, a[1].num as number) };
      }
      default:
        return NAC; // load / gget / call produce unknown values
    }
  };

  let changed = true;
  let guard = 0;
  while (changed && guard++ < 10000) {
    changed = false;
    for (const b of fn.blocks) {
      if (!exec.has(b.id)) continue;
      for (const phi of b.phis) {
        let l: Lat = UNDEF;
        for (const inc of phi.incomings) {
          if (edge.has(`${inc.pred}->${b.id}`)) l = meet(l, latOf(inc.val));
        }
        if (setVal(phi.res, l)) changed = true;
      }
      for (const inst of b.insts) {
        if (inst.res === null) continue;
        if (setVal(inst.res, evalInst(inst))) changed = true;
      }
      // executability of outgoing edges
      const t = b.term;
      const take = (succ: number): void => {
        const key = `${b.id}->${succ}`;
        if (!edge.has(key)) {
          edge.add(key);
          changed = true;
        }
        if (!exec.has(succ)) {
          exec.add(succ);
          changed = true;
        }
      };
      if (t.op === 'br') take(t.target);
      else if (t.op === 'condbr') {
        const c = latOf(t.cond);
        if (c.t === 'const') take(c.num !== 0 ? t.t : t.f);
        else if (c.t === 'nac') {
          take(t.t);
          take(t.f);
        }
      }
    }
  }

  // apply results
  let mutations = 0;
  for (const [id, l] of val) {
    if (l.t === 'const') mutations += replaceAllUses(fn, id, C(l.ty, l.num));
  }
  for (const b of fn.blocks) {
    if (b.term.op === 'condbr') {
      const c = latOf(b.term.cond);
      if (c.t === 'const') {
        b.term = { op: 'br', target: c.num !== 0 ? b.term.t : b.term.f };
        mutations++;
      }
    }
  }
  // After folding constant branches, CFG reachability captures executability.
  mutations += pruneUnreachable(fn);
  return mutations;
}

// =====================================================================
// CFG cleanup: remove unreachable blocks, fix phis, fold trivial phis
// =====================================================================

function pruneUnreachable(fn: IRFunc): number {
  const reachable = new Set<number>();
  const byId = new Map(fn.blocks.map((b) => [b.id, b]));
  const stack = [fn.entry];
  while (stack.length) {
    const id = stack.pop()!;
    if (reachable.has(id) || !byId.has(id)) continue;
    reachable.add(id);
    for (const s of succOfTerm(byId.get(id)!.term)) stack.push(s);
  }
  const before = fn.blocks.length;
  fn.blocks = fn.blocks.filter((b) => reachable.has(b.id));
  let changed = before - fn.blocks.length;

  // recompute preds from terminators
  const live = new Set(fn.blocks.map((b) => b.id));
  for (const b of fn.blocks) b.preds = [];
  for (const b of fn.blocks) for (const s of succOfTerm(b.term)) if (live.has(s)) byId.get(s)!.preds.push(b.id);

  // fix phi incomings to match preds; fold trivial phis
  for (const b of fn.blocks) {
    const predSet = new Set(b.preds);
    const survivors: Phi[] = [];
    for (const phi of b.phis) {
      phi.incomings = phi.incomings.filter((inc) => predSet.has(inc.pred));
      const uniq = dedupeOperands(phi.incomings.map((i) => i.val));
      if (phi.incomings.length <= 1 || uniq.length === 1) {
        const v = phi.incomings.length ? phi.incomings[0].val : C(phi.ty, zeroOf(phi.ty));
        changed += replaceAllUses(fn, phi.res, uniq.length === 1 ? uniq[0] : v);
        changed++;
      } else {
        survivors.push(phi);
      }
    }
    b.phis = survivors;
  }
  return changed;
}
function dedupeOperands(ops: Operand[]): Operand[] {
  const keys = new Set<string>();
  const out: Operand[] = [];
  for (const o of ops) {
    const k = o.tag === 'const' ? `c${o.ty}:${o.num}` : `v${o.id}`;
    if (!keys.has(k)) {
      keys.add(k);
      out.push(o);
    }
  }
  return out;
}

// =====================================================================
// Copy propagation
// =====================================================================

export function copyProp(fn: IRFunc): number {
  let changed = 0;
  let again = true;
  while (again) {
    again = false;
    for (const b of fn.blocks) {
      for (const inst of b.insts) {
        if (inst.kind === 'copy' && inst.res !== null) {
          const n = replaceAllUses(fn, inst.res, inst.args[0]);
          if (n > 0) {
            changed += n;
            again = true;
          }
        }
      }
    }
  }
  return changed;
}

// =====================================================================
// Algebraic simplification (identities not requiring both args constant)
// =====================================================================

export function algebraic(fn: IRFunc): number {
  let changed = 0;
  // Type-aware constant test: an i64 constant carries a bigint, so compare with
  // the matching literal kind. The identity rewrites then hold for `int` and
  // `long` alike, and the produced zero matches the instruction's value type.
  const isC = (o: Operand, n: number): boolean =>
    o.tag === 'const' && (o.ty === 'i64' ? o.num === BigInt(n) : o.num === n);
  for (const b of fn.blocks) {
    for (const inst of b.insts) {
      if (inst.res === null) continue;
      let repl: Operand | null = null;
      if (inst.kind === 'ibin') {
        const [x, y] = inst.args;
        const zero = C(inst.ty as IRType, zeroOf(inst.ty as IRType));
        switch (inst.sub) {
          case 'add': repl = isC(y, 0) ? x : isC(x, 0) ? y : null; break;
          case 'sub': repl = isC(y, 0) ? x : sameVal(x, y) ? zero : null; break;
          case 'mul': repl = isC(y, 1) ? x : isC(x, 1) ? y : isC(y, 0) || isC(x, 0) ? zero : null; break;
          case 'div_s': repl = isC(y, 1) ? x : null; break;
          case 'and': repl = isC(y, 0) || isC(x, 0) ? zero : sameVal(x, y) ? x : null; break;
          case 'or': repl = isC(y, 0) ? x : isC(x, 0) ? y : sameVal(x, y) ? x : null; break;
          case 'xor': repl = isC(y, 0) ? x : isC(x, 0) ? y : sameVal(x, y) ? zero : null; break;
          case 'shl':
          case 'shr_s': repl = isC(y, 0) ? x : null; break;
        }
      } else if (inst.kind === 'icmp' && sameVal(inst.args[0], inst.args[1])) {
        if (inst.sub === 'eq' || inst.sub === 'le_s' || inst.sub === 'ge_s') repl = C('i32', 1);
        else if (inst.sub === 'ne' || inst.sub === 'lt_s' || inst.sub === 'gt_s') repl = C('i32', 0);
      }
      if (repl) {
        changed += replaceAllUses(fn, inst.res, repl);
      }
    }
  }
  return changed;
}
function sameVal(a: Operand, b: Operand): boolean {
  if (a.tag === 'val' && b.tag === 'val') return a.id === b.id;
  if (a.tag === 'const' && b.tag === 'const') return a.ty === b.ty && Object.is(a.num, b.num);
  return false;
}

// =====================================================================
// GVN / CSE — dominator-scoped global value numbering
// =====================================================================

const COMMUTATIVE = new Set(['add', 'mul', 'and', 'or', 'xor', 'eq', 'ne']);

export function gvn(fn: IRFunc): number {
  const dom = computeDom(fn);
  const byId = new Map(fn.blocks.map((b) => [b.id, b]));
  let changed = 0;

  const keyOf = (inst: Inst): string | null => {
    if (!isPureValue(inst) || inst.kind === 'copy') return null;
    const ops = inst.args.map((o) => (o.tag === 'const' ? `c${o.ty}:${o.num}` : `v${o.id}`));
    if (COMMUTATIVE.has(inst.sub) && ops.length === 2) ops.sort();
    return `${inst.kind}/${inst.sub}/${ops.join(',')}`;
  };

  const table = new Map<string, number>(); // expr key -> value id
  const walk = (id: number): void => {
    const b = byId.get(id)!;
    const added: string[] = [];
    for (const inst of b.insts) {
      if (inst.res === null) continue;
      const k = keyOf(inst);
      if (k === null) continue;
      const existing = table.get(k);
      if (existing !== undefined) {
        changed += replaceAllUses(fn, inst.res, { tag: 'val', id: existing });
      } else {
        table.set(k, inst.res);
        added.push(k);
      }
    }
    for (const c of dom.domChildren.get(id) ?? []) walk(c);
    for (const k of added) table.delete(k);
  };
  walk(fn.entry);
  return changed;
}

// =====================================================================
// Dead code elimination
// =====================================================================

export function dce(fn: IRFunc): number {
  let changed = 0;
  let again = true;
  while (again) {
    again = false;
    const counts = countUses(fn);
    for (const b of fn.blocks) {
      const keptPhis = b.phis.filter((p) => (counts.get(p.res) ?? 0) > 0);
      if (keptPhis.length !== b.phis.length) {
        changed += b.phis.length - keptPhis.length;
        b.phis = keptPhis;
        again = true;
      }
      const keptInsts = b.insts.filter((i) => i.res === null || hasSideEffect(i) || (counts.get(i.res) ?? 0) > 0);
      if (keptInsts.length !== b.insts.length) {
        changed += b.insts.length - keptInsts.length;
        b.insts = keptInsts;
        again = true;
      }
    }
  }
  return changed;
}

// =====================================================================
// LICM — loop-invariant code motion
// =====================================================================
//
// Detect natural loops from back edges, materialize a single preheader that
// dominates each loop header, and hoist pure, non-trapping, loop-invariant
// instructions into it. Only side-effect-free, non-trapping ops are hoisted:
// the preheader runs once whenever the loop is entered (even for a zero-trip
// loop), so speculating a trapping op there could invent a trap that the
// original program never raised.

const HOISTABLE = new Set(['ibin', 'iunary', 'fbin', 'icmp', 'fcmp', 'cast', 'copy']);

function dominates(idom: Map<number, number>, a: number, b: number): boolean {
  let n: number | undefined = b;
  while (n !== undefined) {
    if (n === a) return true;
    const d = idom.get(n);
    if (d === n) break; // reached entry
    n = d;
  }
  return false;
}

function maxValueId(fn: IRFunc): number {
  let m = -1;
  for (const k of fn.valueType.keys()) if (k > m) m = k;
  for (const b of fn.blocks) {
    for (const p of b.phis) if (p.res > m) m = p.res;
    for (const i of b.insts) if (i.res !== null && i.res > m) m = i.res;
  }
  return m;
}

function redirectTerm(t: Block['term'], from: number, to: number): Block['term'] {
  if (t.op === 'br') return t.target === from ? { op: 'br', target: to } : t;
  if (t.op === 'condbr') return { op: 'condbr', cond: t.cond, t: t.t === from ? to : t.t, f: t.f === from ? to : t.f };
  return t;
}

/** Find an existing single preheader for `header`, or splice a fresh one in. */
function getPreheader(fn: IRFunc, header: Block, loop: Set<number>, idCtr: { n: number }): Block | null {
  const byId = new Map(fn.blocks.map((b) => [b.id, b]));
  const outside = header.preds.filter((p) => !loop.has(p));
  const latch = header.preds.filter((p) => loop.has(p));
  if (outside.length === 0) return null;
  if (outside.length === 1) {
    const p = byId.get(outside[0]);
    if (p && p.term.op === 'br' && p.term.target === header.id) return p; // already a preheader
  }
  // Create a new preheader carrying all outside entry edges.
  const ph: Block = { id: idCtr.n++, phis: [], insts: [], term: { op: 'br', target: header.id }, preds: [...outside] };
  for (const phi of header.phis) {
    const outsideIncs = phi.incomings.filter((inc) => outside.includes(inc.pred));
    const latchIncs = phi.incomings.filter((inc) => latch.includes(inc.pred));
    const distinct = dedupeOperands(outsideIncs.map((i) => i.val));
    let phVal: Operand;
    if (distinct.length <= 1) {
      phVal = distinct[0] ?? C(phi.ty, zeroOf(phi.ty));
    } else {
      const res = idCtr.n++;
      fn.valueType.set(res, phi.ty);
      ph.phis.push({ res, ty: phi.ty, incomings: outsideIncs.map((i) => ({ pred: i.pred, val: i.val })) });
      phVal = { tag: 'val', id: res };
    }
    phi.incomings = [{ pred: ph.id, val: phVal }, ...latchIncs];
  }
  header.preds = [ph.id, ...latch];
  for (const pid of outside) {
    const p = byId.get(pid)!;
    p.term = redirectTerm(p.term, header.id, ph.id);
  }
  const hi = fn.blocks.indexOf(header);
  fn.blocks.splice(hi, 0, ph);
  return ph;
}

export function licm(fn: IRFunc): number {
  const dom = computeDom(fn);
  const byId = new Map(fn.blocks.map((b) => [b.id, b]));

  // Collect natural loops (header -> set of body block ids), unioning back edges.
  const loops = new Map<number, Set<number>>();
  for (const b of fn.blocks) {
    for (const s of succOfTerm(b.term)) {
      if (!dominates(dom.idom, s, b.id)) continue; // not a back edge
      let body = loops.get(s);
      if (!body) loops.set(s, (body = new Set([s])));
      const stack = [b.id];
      while (stack.length) {
        const n = stack.pop()!;
        if (body.has(n)) continue;
        body.add(n);
        for (const p of byId.get(n)?.preds ?? []) if (!body.has(p)) stack.push(p);
      }
    }
  }
  if (loops.size === 0) return 0;

  const idCtr = { n: maxValueId(fn) + 1 };
  // Block ids and value ids share no namespace requirement for codegen, but to
  // avoid any collision we seed the block-id counter past existing block ids.
  for (const b of fn.blocks) if (b.id >= idCtr.n) idCtr.n = b.id + 1;

  let changed = 0;
  // Process headers outer-to-inner is unnecessary: we iterate each loop to a
  // fixpoint, and the multi-round pass manager re-runs LICM so nested invariants
  // bubble all the way out across rounds.
  for (const [headerId, loop] of loops) {
    const header = byId.get(headerId);
    if (!header) continue;
    const ph = getPreheader(fn, header, loop, idCtr);
    if (!ph) continue;

    // Values defined inside the loop are variant until proven hoistable.
    const loopDefs = new Set<number>();
    for (const id of loop) {
      const b = byId.get(id)!;
      for (const p of b.phis) loopDefs.add(p.res);
      for (const i of b.insts) if (i.res !== null) loopDefs.add(i.res);
    }
    const invariant = (o: Operand): boolean => o.tag === 'const' || !loopDefs.has(o.id);

    let again = true;
    while (again) {
      again = false;
      for (const id of loop) {
        if (id === ph.id) continue;
        const b = byId.get(id)!;
        const keep: Inst[] = [];
        for (const inst of b.insts) {
          const hoistable =
            inst.res !== null &&
            HOISTABLE.has(inst.kind) &&
            !(inst.kind === 'ibin' && (inst.sub === 'div_s' || inst.sub === 'rem_s')) &&
            inst.args.every(invariant);
          if (hoistable) {
            ph.insts.push(inst);
            loopDefs.delete(inst.res!); // now defined in the preheader (outside the loop)
            changed++;
            again = true;
          } else {
            keep.push(inst);
          }
        }
        b.insts = keep;
      }
    }
  }
  return changed;
}

// =====================================================================
// Strength reduction / peephole
// =====================================================================
//
// Integer-exact local rewrites that don't need both operands constant. `* 2^k`
// becomes `<< k` (wrapping multiply by a power of two equals the shift mod 2^32),
// and a handful of shift identities are normalized so later GVN/DCE can act.

function log2Exact(n: number): number | null {
  if (n <= 0 || (n & (n - 1)) !== 0) return null;
  return Math.log2(n >>> 0) | 0;
}
// Exact base-2 log of a positive power-of-two i64 constant, else null. Works on
// the full 64-bit range (`n` is a BigInt), so `long` multiplies strength-reduce
// to shifts just like `int` ones. The shift amount itself is a small integer.
function log2Exact64(n: bigint): number | null {
  if (n <= 0n || (n & (n - 1n)) !== 0n) return null;
  return n.toString(2).length - 1;
}

export function peephole(fn: IRFunc): number {
  let changed = 0;
  for (const b of fn.blocks) {
    for (const inst of b.insts) {
      if (inst.kind !== 'ibin' || inst.res === null || inst.sub !== 'mul') continue;
      const [x, y] = inst.args;
      // x * 2^k -> x << k  (the shift count is a constant of the operand's type).
      const isI64 = inst.ty === 'i64';
      const powOf = (o: Operand): number | null =>
        o.tag !== 'const' ? null : isI64 ? log2Exact64(o.num as bigint) : log2Exact(o.num as number);
      const shiftCount = (k: number): Operand => ({ tag: 'const', ty: isI64 ? 'i64' : 'i32', num: isI64 ? BigInt(k) : k });
      let k = powOf(y);
      if (k !== null) { inst.sub = 'shl'; inst.args = [x, shiftCount(k)]; changed++; continue; }
      k = powOf(x);
      if (k !== null) { inst.sub = 'shl'; inst.args = [y, shiftCount(k)]; changed++; }
    }
  }
  return changed;
}

// =====================================================================
// If-conversion — collapse a control-flow diamond into a `select`
// =====================================================================
//
// A side-effect-free diamond
//
//        C: condbr(cond, T, F)
//        T: <pure>  br J         F: <pure>  br J
//        J: phi(T:vt, F:vf), …
//
// becomes a single straight-line block: T's and F's (pure, non-trapping)
// instructions are hoisted into C — they now run unconditionally, which is
// sound precisely because they cannot trap or have side effects — and each phi
// in J turns into `select(vt, vf, cond)`. Two blocks and a branch disappear,
// and the wasm backend emits a branchless `select`. This is the shape ternaries
// and simple if/else assignments lower to, so it fires often.

const SPECULABLE = new Set(['ibin', 'iunary', 'fbin', 'icmp', 'fcmp', 'cast', 'copy', 'select']);

function isSpeculable(b: Block): boolean {
  if (b.phis.length > 0) return false;
  return b.insts.every(
    (i) => SPECULABLE.has(i.kind) && !(i.kind === 'ibin' && (i.sub === 'div_s' || i.sub === 'rem_s')),
  );
}

export function ifConvert(fn: IRFunc): number {
  let changed = 0;
  let again = true;
  while (again) {
    again = false;
    const byId = new Map(fn.blocks.map((b) => [b.id, b]));
    for (const c of fn.blocks) {
      if (c.term.op !== 'condbr' || c.term.t === c.term.f) continue;
      const T = byId.get(c.term.t);
      const F = byId.get(c.term.f);
      if (!T || !F) continue;
      // T and F must each be reached only from C and fall through to one join J.
      if (T.preds.length !== 1 || T.preds[0] !== c.id) continue;
      if (F.preds.length !== 1 || F.preds[0] !== c.id) continue;
      if (T.term.op !== 'br' || F.term.op !== 'br' || T.term.target !== F.term.target) continue;
      const J = byId.get(T.term.target);
      if (!J || J.id === c.id || J.id === T.id || J.id === F.id) continue;
      // J must merge exactly the two diamond arms.
      if (J.preds.length !== 2 || !J.preds.includes(T.id) || !J.preds.includes(F.id)) continue;
      if (!isSpeculable(T) || !isSpeculable(F)) continue;
      if (T.insts.length + F.insts.length > 8) continue; // bound code growth

      const cond = c.term.cond;
      const selects: Inst[] = [];
      let ok = true;
      for (const phi of J.phis) {
        const incT = phi.incomings.find((i) => i.pred === T.id);
        const incF = phi.incomings.find((i) => i.pred === F.id);
        if (!incT || !incF) { ok = false; break; }
        selects.push({
          res: phi.res,
          ty: phi.ty,
          kind: 'select',
          sub: '',
          args: [cloneOperand(incT.val), cloneOperand(incF.val), cloneOperand(cond)],
        });
      }
      if (!ok) continue;

      // Hoist both arms into C (order-independent: all pure), append the selects,
      // and rewire C -> J directly. The phi results are reused as the select
      // results, so every existing use keeps working untouched.
      c.insts.push(...T.insts, ...F.insts, ...selects);
      c.term = { op: 'br', target: J.id };
      J.phis = [];
      J.preds = [c.id];
      fn.blocks = fn.blocks.filter((b) => b.id !== T.id && b.id !== F.id);
      changed += 1 + selects.length;
      again = true;
      break; // CFG mutated — rebuild byId and rescan
    }
  }
  return changed;
}

// =====================================================================
// Whole-module dead-function elimination
// =====================================================================
//
// After inlining, a callee can become unreachable: nothing calls it and it is
// not exported. Drop such functions (transitively) so inlining is a net code-
// size win rather than leaving an orphaned copy behind.

function pruneFunctions(mod: IRModule): number {
  const byName = new Map(mod.funcs.map((f) => [f.name, f]));
  const live = new Set<string>();
  const stack = mod.funcs.filter((f) => f.exported).map((f) => f.name);
  while (stack.length) {
    const name = stack.pop()!;
    if (live.has(name)) continue;
    live.add(name);
    const fn = byName.get(name);
    if (!fn) continue;
    for (const b of fn.blocks) for (const i of b.insts) if (i.kind === 'call' && !live.has(i.sub)) stack.push(i.sub);
  }
  const before = mod.funcs.length;
  mod.funcs = mod.funcs.filter((f) => live.has(f.name));
  return before - mod.funcs.length;
}

// =====================================================================
// Pass manager
// =====================================================================

export interface OptResult {
  mod: IRModule;
  log: PassStat[];
  /** Textual IR after each step (snapshots[0] is the input). Aligned so
   *  `snapshots[k + 1]` is the IR after `log[k]`. Empty unless requested. */
  snapshots: string[];
}

export function optimize(mod: IRModule, level: OptLevel, snapshots = false): OptResult {
  const out = cloneModule(mod);
  const log: PassStat[] = [];
  const snaps: string[] = [];
  const snap = (): void => {
    if (snapshots) snaps.push(dumpModule(out));
  };
  snap(); // the input IR
  if (level === 0) return { mod: out, log, snapshots: snaps };

  const record = (name: string, fnOp: (fn: IRFunc) => number) => {
    let total = 0;
    for (const fn of out.funcs) total += fnOp(fn);
    log.push({ name, changed: total });
    snap();
  };

  const rounds = level >= 2 ? 4 : 1;
  for (let r = 0; r < rounds; r++) {
    const suffix = rounds > 1 ? ` (round ${r + 1})` : '';
    record('copy-propagation' + suffix, copyProp);
    record('sccp' + suffix, sccp);
    record('if-convert' + suffix, ifConvert);
    record('strength-reduce' + suffix, peephole);
    if (level >= 2) record('gvn/cse' + suffix, gvn);
    record('algebraic-simplify' + suffix, algebraic);
    if (level >= 2) record('licm' + suffix, licm);
    record('dead-code-elim' + suffix, dce);
  }
  // a final cleanup pass that always runs
  record('cfg-cleanup', (fn) => pruneUnreachable(fn));
  record('dead-code-elim (final)', dce);
  const removed = pruneFunctions(out);
  if (removed > 0) {
    log.push({ name: 'dead-function-elim', changed: removed });
    snap();
  }
  return { mod: out, log, snapshots: snaps };
}
