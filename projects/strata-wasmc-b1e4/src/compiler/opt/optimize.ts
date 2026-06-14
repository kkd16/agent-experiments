import type { Block, Inst, IRFunc, IRModule, Operand, Phi } from '../ir/ir';
import { eachOperand, hasSideEffect, isPureValue } from '../ir/ir';
import { computeDom, succOfTerm } from '../ir/cfg';
import { i32, satTruncI32 } from '../interp';

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
function evalFBin(sub: string, a: number, b: number): number {
  switch (sub) {
    case 'add': return a + b;
    case 'sub': return a - b;
    case 'mul': return a * b;
    case 'div': return a / b;
    default: return 0;
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

const C = (ty: 'i32' | 'f64', num: number): Operand => ({ tag: 'const', ty, num: ty === 'i32' ? i32(num) : num });

// =====================================================================
// SCCP — Sparse Conditional Constant Propagation
// =====================================================================

type Lat = { t: 'undef' } | { t: 'const'; ty: 'i32' | 'f64'; num: number } | { t: 'nac' };
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
        return inst.sub === 'i2f' ? { t: 'const', ty: 'f64', num: a[0].num } : { t: 'const', ty: 'i32', num: satTruncI32(a[0].num) };
      }
      case 'ibin':
      case 'icmp':
      case 'fbin':
      case 'fcmp': {
        if (a[0].t === 'nac' || a[1].t === 'nac') return NAC;
        if (a[0].t !== 'const' || a[1].t !== 'const') return UNDEF;
        if (inst.kind === 'ibin') {
          const r = evalIBin(inst.sub, a[0].num, a[1].num);
          return r === null ? NAC : { t: 'const', ty: 'i32', num: r };
        }
        if (inst.kind === 'icmp') return { t: 'const', ty: 'i32', num: evalICmp(inst.sub, a[0].num, a[1].num) };
        if (inst.kind === 'fbin') return { t: 'const', ty: 'f64', num: evalFBin(inst.sub, a[0].num, a[1].num) };
        return { t: 'const', ty: 'i32', num: evalFCmp(inst.sub, a[0].num, a[1].num) };
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
        const v = phi.incomings.length ? phi.incomings[0].val : C(phi.ty, 0);
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
  const isC = (o: Operand, n: number): boolean => o.tag === 'const' && o.num === n;
  for (const b of fn.blocks) {
    for (const inst of b.insts) {
      if (inst.res === null) continue;
      let repl: Operand | null = null;
      if (inst.kind === 'ibin') {
        const [x, y] = inst.args;
        switch (inst.sub) {
          case 'add': repl = isC(y, 0) ? x : isC(x, 0) ? y : null; break;
          case 'sub': repl = isC(y, 0) ? x : sameVal(x, y) ? C('i32', 0) : null; break;
          case 'mul': repl = isC(y, 1) ? x : isC(x, 1) ? y : isC(y, 0) || isC(x, 0) ? C('i32', 0) : null; break;
          case 'div_s': repl = isC(y, 1) ? x : null; break;
          case 'and': repl = isC(y, 0) || isC(x, 0) ? C('i32', 0) : sameVal(x, y) ? x : null; break;
          case 'or': repl = isC(y, 0) ? x : isC(x, 0) ? y : sameVal(x, y) ? x : null; break;
          case 'xor': repl = isC(y, 0) ? x : isC(x, 0) ? y : sameVal(x, y) ? C('i32', 0) : null; break;
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
// Pass manager
// =====================================================================

export function optimize(mod: IRModule, level: OptLevel): { mod: IRModule; log: PassStat[] } {
  const out = cloneModule(mod);
  const log: PassStat[] = [];
  if (level === 0) return { mod: out, log };

  const record = (name: string, fnOp: (fn: IRFunc) => number) => {
    let total = 0;
    for (const fn of out.funcs) total += fnOp(fn);
    log.push({ name, changed: total });
  };

  const rounds = level >= 2 ? 4 : 1;
  for (let r = 0; r < rounds; r++) {
    const suffix = rounds > 1 ? ` (round ${r + 1})` : '';
    record('copy-propagation' + suffix, copyProp);
    record('sccp' + suffix, sccp);
    if (level >= 2) record('gvn/cse' + suffix, gvn);
    record('algebraic-simplify' + suffix, algebraic);
    record('dead-code-elim' + suffix, dce);
  }
  // a final cleanup pass that always runs
  record('cfg-cleanup', (fn) => pruneUnreachable(fn));
  record('dead-code-elim (final)', dce);
  return { mod: out, log };
}
