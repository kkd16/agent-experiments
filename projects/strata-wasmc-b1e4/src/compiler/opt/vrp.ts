import type { Block, Inst, IRFunc, Operand } from '../ir/ir';
import { eachOperand } from '../ir/ir';
import { computeDom, succOfTerm } from '../ir/cfg';
import { findNaturalLoops } from '../ir/loops';

// =====================================================================
// VRP — value-range propagation (sparse conditional range analysis)
// =====================================================================
//
// A flow-sensitive integer *interval* analysis over the SSA CFG. Every i32/i64
// value is assigned a signed range `[lo, hi]` (BigInt bounds, so the reasoning is
// exact and never itself overflows) that is a sound **over-approximation**: on
// every execution reaching the value's definition, its runtime value lies inside
// `[lo, hi]`. Two things then fall out:
//
//   • an `icmp` whose operand ranges make its result **constant** (e.g. `x < 20`
//     where `x ∈ [0, 9]`) is replaced by that `0`/`1` — a comparison SCCP can't
//     fold because neither operand is itself constant;
//   • a `condbr` whose condition value is proven non-zero (or zero) becomes an
//     unconditional `br`, so the following DCE / CFG-simplify delete the dead arm.
//
// This subsumes correlated-branch folding (which only decides a branch from an
// *identical* dominating test) with genuine numeric implication: a mask
// (`(x & 7) < 8`), a remainder (`x % 10 >= 0` for `x ≥ 0`), a bit-count bound
// (`popcount(x) <= 32`), a chained guard (`if (a < b) … if (a < b + 1)`), or any
// range a dominating comparison pins down. It is the classic "correlated value
// propagation" / VRP pass (LLVM's LazyValueInfo, GCC's tree-VRP).
//
// ## Where the precision comes from — edge refinement
//
// The engine is flow-sensitive: it threads an *environment* (value → range) along
// the CFG. At a `condbr(c, T, F)` whose condition `c` is an `icmp x <cmp> y`, the
// environment handed to `T` **assumes the comparison true** and narrows `x`/`y`
// accordingly (`x < y` ⇒ `x ≤ hi(y) − 1`, `y ≥ lo(x) + 1`), and the one handed to
// `F` assumes it false. A block's entry environment is the **hull (union)** of its
// predecessors' refined out-environments — so a value is only ever narrowed at a
// merge when the narrowing holds on *every* incoming path. That hull is exactly
// what makes a single-edge refinement sound at a multi-pred merge (it evaporates)
// while a single-predecessor arm keeps the guard's full strength.
//
// ## Soundness
//
// Every transfer function is a sound over-approximation under wasm's wrapping
// integer semantics: an arithmetic result interval is used only when it provably
// fits its result type (`[i32.MIN, i32.MAX]` / `[i64.MIN, i64.MAX]`) — otherwise
// the value could wrap, so its range collapses to the full type range (⊤). Loop
// headers are pinned to ⊤ (the loop-carried back edge is not modelled), which both
// guarantees termination — the only narrowing is acyclic edge refinement, so a
// single reverse-postorder sweep reaches a fixpoint — and keeps every range a
// safe over-approximation. Because a value's def dominates all its uses, and a
// refinement that tightened a value held on *every* path into the block that
// defines the derived `icmp`, the folded result is valid at every use of it. Every
// rewrite is therefore behaviour-preserving, pinned bit-for-bit by the triple
// differential oracle (interpreter ≡ host wasm ≡ from-scratch VM) at every opt
// level, plus a dedicated seeded range fuzzer (`tools/check-vrp.mjs`).

const I32_MIN = -(2n ** 31n);
const I32_MAX = 2n ** 31n - 1n;
const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;

interface Iv {
  lo: bigint;
  hi: bigint;
}
// `null` is the top element ⊤ (unknown / full range or an untracked, non-integer
// value). A concrete `Iv` is always non-empty (`lo <= hi`) and clamped to bounds.
type Range = Iv | null;

/** The integer kind of an operand, or null for a float / vector / unknown value. */
function intTy(fn: IRFunc, op: Operand): 'i32' | 'i64' | null {
  const t = op.tag === 'const' ? op.ty : fn.valueType.get(op.id);
  return t === 'i32' ? 'i32' : t === 'i64' ? 'i64' : null;
}
function boundsOf(ty: 'i32' | 'i64'): Iv {
  return ty === 'i32' ? { lo: I32_MIN, hi: I32_MAX } : { lo: I64_MIN, hi: I64_MAX };
}
function widthOf(ty: 'i32' | 'i64'): bigint {
  return ty === 'i32' ? 32n : 64n;
}

/** An arithmetic result interval, kept only if it provably fits its type (else ⊤). */
function fit(iv: Iv, ty: 'i32' | 'i64'): Range {
  const b = boundsOf(ty);
  return iv.lo >= b.lo && iv.hi <= b.hi ? iv : null;
}
function clampToTy(iv: Iv, ty: 'i32' | 'i64'): Iv | 'empty' {
  const b = boundsOf(ty);
  const lo = iv.lo < b.lo ? b.lo : iv.lo;
  const hi = iv.hi > b.hi ? b.hi : iv.hi;
  return lo > hi ? 'empty' : { lo, hi };
}

const bmin = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const bmax = (a: bigint, b: bigint): bigint => (a > b ? a : b);
const babs = (a: bigint): bigint => (a < 0n ? -a : a);

/** Hull (union) of two ranges; ⊤ absorbs. */
function hull(a: Range, b: Range): Range {
  if (a === null || b === null) return null;
  return { lo: bmin(a.lo, b.lo), hi: bmax(a.hi, b.hi) };
}
/** Intersection of two ranges; returns 'empty' when disjoint. ⊤ is the identity. */
function meet(a: Range, b: Range): Iv | 'empty' | null {
  if (a === null) return b;
  if (b === null) return a;
  const lo = bmax(a.lo, b.lo);
  const hi = bmin(a.hi, b.hi);
  return lo > hi ? 'empty' : { lo, hi };
}

type Env = Map<number, Iv>;

/** The range of an operand in `env`: a constant is a singleton, a value looks up
 *  (default: its type's full range), a non-integer operand is ⊤. */
function rangeOfOperand(fn: IRFunc, env: Env, op: Operand): Range {
  const ty = intTy(fn, op);
  if (ty === null) return null;
  if (op.tag === 'const') {
    const n = typeof op.num === 'bigint' ? op.num : BigInt(op.num);
    return { lo: n, hi: n };
  }
  return env.get(op.id) ?? boundsOf(ty);
}

// --- integer helpers matching wasm semantics -----------------------------------

/** Floor division (arithmetic shift right divides toward −∞), b > 0. */
function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && a < 0n ? q - 1n : q;
}
/** Fill all bits below the top set bit of a non-negative value: the tightest
 *  power-of-two−1 upper bound for a bitwise `or`/`xor` of non-negative operands. */
function fillBits(n: bigint): bigint {
  if (n <= 0n) return 0n;
  return (1n << BigInt(n.toString(2).length)) - 1n;
}

// --- transfer functions --------------------------------------------------------

function transferIBin(sub: string, X: Range, Y: Range, ty: 'i32' | 'i64'): Range {
  if (X === null || Y === null) {
    // A couple of ops pin a range from *one* operand even when the other is ⊤.
    if (sub === 'and' && Y !== null && Y.lo >= 0n) return { lo: 0n, hi: Y.hi };
    if (sub === 'and' && X !== null && X.lo >= 0n) return { lo: 0n, hi: X.hi };
    if (sub === 'rem_s' && Y !== null && (Y.lo > 0n || Y.hi < 0n)) {
      const m = bmax(babs(Y.lo), babs(Y.hi)) - 1n;
      return fit({ lo: -m, hi: m }, ty);
    }
    return null;
  }
  switch (sub) {
    case 'add':
      return fit({ lo: X.lo + Y.lo, hi: X.hi + Y.hi }, ty);
    case 'sub':
      return fit({ lo: X.lo - Y.hi, hi: X.hi - Y.lo }, ty);
    case 'mul': {
      const p = [X.lo * Y.lo, X.lo * Y.hi, X.hi * Y.lo, X.hi * Y.hi];
      return fit({ lo: p.reduce(bmin), hi: p.reduce(bmax) }, ty);
    }
    case 'and': {
      if (X.lo >= 0n && Y.lo >= 0n) return { lo: 0n, hi: bmin(X.hi, Y.hi) };
      if (Y.lo >= 0n) return { lo: 0n, hi: Y.hi }; // non-negative mask forces sign + bound
      if (X.lo >= 0n) return { lo: 0n, hi: X.hi };
      return null;
    }
    case 'or':
      if (X.lo >= 0n && Y.lo >= 0n) return { lo: bmax(X.lo, Y.lo), hi: fillBits(X.hi | Y.hi) };
      return null;
    case 'xor':
      if (X.lo >= 0n && Y.lo >= 0n) return { lo: 0n, hi: fillBits(X.hi | Y.hi) };
      return null;
    case 'shl': {
      if (Y.lo !== Y.hi) return null; // variable shift
      const k = Y.lo;
      if (k < 0n || k >= widthOf(ty)) return null;
      const f = 1n << k;
      return fit({ lo: X.lo * f, hi: X.hi * f }, ty);
    }
    case 'shr_s': {
      if (Y.lo !== Y.hi) return null;
      const k = Y.lo;
      if (k < 0n || k >= widthOf(ty)) return null;
      const f = 1n << k;
      return { lo: floorDiv(X.lo, f), hi: floorDiv(X.hi, f) }; // shrinks magnitude — always fits
    }
    case 'div_s': {
      if (Y.lo !== Y.hi) return null;
      const c = Y.lo;
      if (c === 0n || c === -1n) return null; // −1 can overflow at MIN; 0 traps
      // Signed division truncates toward zero and is monotonic in the dividend.
      const q = (x: bigint): bigint => x / c;
      return c > 0n ? { lo: q(X.lo), hi: q(X.hi) } : { lo: q(X.hi), hi: q(X.lo) };
    }
    case 'rem_s': {
      if (Y.lo !== Y.hi || Y.lo === 0n) return null;
      const m = babs(Y.lo) - 1n; // |x % c| <= |c| − 1, and sign(result) = sign(x)
      if (X.lo >= 0n) return { lo: 0n, hi: bmin(m, X.hi) };
      if (X.hi <= 0n) return { lo: bmax(-m, X.lo), hi: 0n };
      return { lo: -m, hi: m };
    }
    default:
      return null;
  }
}

function transferICmp(sub: string, X: Range, Y: Range): Iv {
  const T: Iv = { lo: 1n, hi: 1n };
  const F: Iv = { lo: 0n, hi: 0n };
  const U: Iv = { lo: 0n, hi: 1n };
  if (X === null || Y === null) return U;
  switch (sub) {
    case 'lt_s':
      return X.hi < Y.lo ? T : X.lo >= Y.hi ? F : U;
    case 'le_s':
      return X.hi <= Y.lo ? T : X.lo > Y.hi ? F : U;
    case 'gt_s':
      return X.lo > Y.hi ? T : X.hi <= Y.lo ? F : U;
    case 'ge_s':
      return X.lo >= Y.hi ? T : X.hi < Y.lo ? F : U;
    case 'eq':
      if (X.hi < Y.lo || Y.hi < X.lo) return F; // disjoint
      if (X.lo === X.hi && Y.lo === Y.hi && X.lo === Y.lo) return T;
      return U;
    case 'ne':
      if (X.hi < Y.lo || Y.hi < X.lo) return T;
      if (X.lo === X.hi && Y.lo === Y.hi && X.lo === Y.lo) return F;
      return U;
    default:
      return U;
  }
}

/** Result range of `inst` given operand ranges in `env`; null (⊤) when untracked. */
function transfer(fn: IRFunc, env: Env, inst: Inst): Range {
  switch (inst.kind) {
    case 'copy':
      return rangeOfOperand(fn, env, inst.args[0]);
    case 'select':
      return hull(rangeOfOperand(fn, env, inst.args[0]), rangeOfOperand(fn, env, inst.args[1]));
    case 'ibin': {
      const ty = intTy(fn, inst.args[0]);
      if (ty === null) return null;
      return transferIBin(inst.sub, rangeOfOperand(fn, env, inst.args[0]), rangeOfOperand(fn, env, inst.args[1]), ty);
    }
    case 'iunary': {
      // clz / ctz / popcnt all land in [0, bit-width]; result type = operand type.
      const ty = intTy(fn, inst.args[0]);
      if (ty === null) return null;
      return { lo: 0n, hi: widthOf(ty) };
    }
    case 'icmp':
      return transferICmp(inst.sub, rangeOfOperand(fn, env, inst.args[0]), rangeOfOperand(fn, env, inst.args[1]));
    case 'cast':
      // i2l widens sign-extending (numeric value unchanged, always fits i64);
      // l2i wraps — keep the range only when the source already fits i32.
      if (inst.sub === 'i2l') return rangeOfOperand(fn, env, inst.args[0]);
      if (inst.sub === 'l2i') return fit(rangeOfOperand(fn, env, inst.args[0]) ?? boundsOf('i64'), 'i32');
      return null;
    default:
      return null; // load / gget / call / float / vector: unknown
  }
}

// --- edge refinement (narrow operands under an assumed comparison) -------------

const NEGATE: Record<string, string> = {
  eq: 'ne',
  ne: 'eq',
  lt_s: 'ge_s',
  ge_s: 'lt_s',
  le_s: 'gt_s',
  gt_s: 'le_s',
};

/** Narrow `env` (a fresh clone) assuming `icmp sub x,y` evaluated to `want`. */
function refineCmp(fn: IRFunc, env: Env, sub: string, ax: Operand, ay: Operand, want: boolean): void {
  const pred = want ? sub : NEGATE[sub];
  if (!pred) return;
  const tyx = intTy(fn, ax);
  const tyy = intTy(fn, ay);
  if (tyx === null || tyy === null) return;
  const X = rangeOfOperand(fn, env, ax)!;
  const Y = rangeOfOperand(fn, env, ay)!;
  let nx: Iv = { ...X };
  let ny: Iv = { ...Y };
  switch (pred) {
    case 'lt_s':
      nx.hi = bmin(nx.hi, Y.hi - 1n);
      ny.lo = bmax(ny.lo, X.lo + 1n);
      break;
    case 'le_s':
      nx.hi = bmin(nx.hi, Y.hi);
      ny.lo = bmax(ny.lo, X.lo);
      break;
    case 'gt_s':
      nx.lo = bmax(nx.lo, Y.lo + 1n);
      ny.hi = bmin(ny.hi, X.hi - 1n);
      break;
    case 'ge_s':
      nx.lo = bmax(nx.lo, Y.lo);
      ny.hi = bmin(ny.hi, X.hi);
      break;
    case 'eq': {
      const m = meet(X, Y);
      if (m !== 'empty' && m !== null) {
        nx = { ...m };
        ny = { ...m };
      }
      break;
    }
    case 'ne': {
      // Can only clip an endpoint against a singleton on the other side.
      if (Y.lo === Y.hi) {
        if (nx.lo === Y.lo) nx.lo += 1n;
        if (nx.hi === Y.lo) nx.hi -= 1n;
      }
      if (X.lo === X.hi) {
        if (ny.lo === X.lo) ny.lo += 1n;
        if (ny.hi === X.lo) ny.hi -= 1n;
      }
      break;
    }
  }
  if (ax.tag === 'val') {
    const c = clampToTy(nx, tyx);
    if (c !== 'empty') env.set(ax.id, c);
  }
  if (ay.tag === 'val') {
    const c = clampToTy(ny, tyy);
    if (c !== 'empty') env.set(ay.id, c);
  }
}

// --- the pass ------------------------------------------------------------------

function recomputePreds(fn: IRFunc): void {
  const byId = new Map(fn.blocks.map((b) => [b.id, b]));
  for (const b of fn.blocks) b.preds = [];
  for (const b of fn.blocks) for (const s of succOfTerm(b.term)) byId.get(s)?.preds.push(b.id);
}

export function vrp(fn: IRFunc): number {
  recomputePreds(fn);
  const dom = computeDom(fn);
  const byId = new Map(fn.blocks.map((b) => [b.id, b]));
  const headers = new Set(findNaturalLoops(fn, dom).map((l) => l.header));

  // Defining `icmp` of a value, so a branch condition can be traced to a comparison.
  const icmpDef = new Map<number, Inst>();
  for (const b of fn.blocks) for (const i of b.insts) if (i.kind === 'icmp' && i.res !== null) icmpDef.set(i.res, i);

  const exitEnv = new Map<number, Env>();
  // Over-approximate range at each value's definition — valid at every use of it,
  // since the def dominates all uses and any refinement it embeds held on every
  // path into its def block.
  const defRange = new Map<number, Iv>();
  const record = (id: number, r: Range): void => {
    if (r !== null) defRange.set(id, r);
  };

  /** `exitEnv[p]` refined for the edge p → succ (assume the taken comparison). */
  const edgeEnv = (p: Block, succ: number): Env => {
    const base = exitEnv.get(p.id);
    if (!base) return new Map();
    const t = p.term;
    if (t.op !== 'condbr' || t.t === t.f || t.cond.tag !== 'val') return base;
    const cmp = icmpDef.get(t.cond.id);
    if (!cmp) return base;
    const want = succ === t.t; // succ is either the true or the false arm here
    const env: Env = new Map(base);
    refineCmp(fn, env, cmp.sub, cmp.args[0], cmp.args[1], want);
    return env;
  };

  for (const id of dom.rpo) {
    const b = byId.get(id)!;
    let env: Env;
    const processedPreds = b.preds.filter((p) => exitEnv.has(p));
    // A loop header (or any block whose full pred set is not yet available —
    // an irreducible back edge) starts at ⊤: the back edge is unmodelled, which
    // both keeps ranges sound and makes this one RPO sweep a fixpoint.
    if (id === fn.entry || headers.has(id) || processedPreds.length !== b.preds.length || b.preds.length === 0) {
      env = new Map();
    } else {
      const predEnvs = b.preds.map((p) => edgeEnv(byId.get(p)!, id));
      // Base env = pointwise hull over predecessors: keep a value only where every
      // incoming edge bounds it (a single-edge refinement evaporates at a merge).
      env = new Map();
      const keys = new Set<number>();
      for (const e of predEnvs) for (const k of e.keys()) keys.add(k);
      for (const k of keys) {
        const ty = intTy(fn, { tag: 'val', id: k });
        if (ty === null) continue;
        const full = boundsOf(ty);
        let acc: Range = predEnvs[0].get(k) ?? full;
        for (let i = 1; i < predEnvs.length; i++) acc = hull(acc, predEnvs[i].get(k) ?? full);
        if (acc !== null && !(acc.lo <= full.lo && acc.hi >= full.hi)) env.set(k, acc); // omit ⊤
      }
      // Phi results: hull the incoming operand's range in each predecessor edge env.
      for (const phi of b.phis) {
        let acc: Range | undefined;
        let top = false;
        for (const inc of phi.incomings) {
          const pi = b.preds.indexOf(inc.pred);
          if (pi < 0) {
            top = true;
            break;
          }
          const r = rangeOfOperand(fn, predEnvs[pi], inc.val);
          acc = acc === undefined ? r : hull(acc, r);
          if (acc === null) {
            top = true;
            break;
          }
        }
        if (!top && acc != null) {
          env.set(phi.res, acc);
          record(phi.res, acc);
        }
      }
    }

    // Straight-line transfer through the block's instructions.
    for (const inst of b.insts) {
      if (inst.res === null) continue;
      const r = transfer(fn, env, inst);
      if (r !== null) {
        env.set(inst.res, r);
        record(inst.res, r);
      } else {
        env.delete(inst.res);
      }
    }
    exitEnv.set(id, env);
  }

  // --- apply: fold branches, then constant-fold proven comparisons -------------
  let changed = 0;
  let branchFolded = false;
  for (const b of fn.blocks) {
    if (b.term.op !== 'condbr' || b.term.t === b.term.f) continue;
    const c = b.term.cond;
    if (c.tag !== 'val') continue; // a constant condition is SCCP's job
    const r = defRange.get(c.id);
    if (!r) continue;
    let decided: number | null = null;
    if (r.lo > 0n || r.hi < 0n) decided = b.term.t; // provably non-zero → true
    else if (r.lo === 0n && r.hi === 0n) decided = b.term.f; // provably zero → false
    if (decided === null) continue;
    const dead = decided === b.term.t ? b.term.f : b.term.t;
    b.term = { op: 'br', target: decided };
    const db = byId.get(dead);
    if (db) for (const phi of db.phis) phi.incomings = phi.incomings.filter((i) => i.pred !== b.id);
    changed++;
    branchFolded = true;
  }

  const replaceUses = (fromId: number, to: Operand): number => {
    let n = 0;
    for (const blk of fn.blocks)
      eachOperand(blk, (o, set) => {
        if (o.tag === 'val' && o.id === fromId) {
          set(to.tag === 'const' ? { tag: 'const', ty: to.ty, num: to.num } : { tag: 'val', id: to.id });
          n++;
        }
      });
    return n;
  };

  // Replace an `icmp` whose result range is a singleton {0}/{1} with that constant.
  for (const b of fn.blocks) {
    for (const inst of b.insts) {
      if (inst.kind !== 'icmp' || inst.res === null) continue;
      const r = defRange.get(inst.res);
      if (!r || r.lo !== r.hi) continue;
      changed += replaceUses(inst.res, { tag: 'const', ty: 'i32', num: Number(r.lo) });
    }
  }

  // Range-based remainder / division elimination: a dividend proven to lie in
  // `[0, |c| − 1]` makes `x % c` an identity (its remainder *is* `x`, whatever the
  // sign of the constant divisor `c`) and `x / c` exactly zero. This is a rewrite
  // the constant-divisor strength reducer (`opt/divrem.ts`) cannot make — it never
  // learns the dividend's range — so VRP owns it. The now-dead op is swept by DCE.
  for (const b of fn.blocks) {
    for (const inst of b.insts) {
      if (inst.kind !== 'ibin' || inst.res === null) continue;
      if (inst.sub !== 'rem_s' && inst.sub !== 'div_s') continue;
      const x = inst.args[0];
      const cOp = inst.args[1];
      if (x.tag !== 'val' || cOp.tag !== 'const') continue;
      const xr = defRange.get(x.id);
      if (!xr || xr.lo < 0n) continue; // need a non-negative dividend
      const c = typeof cOp.num === 'bigint' ? cOp.num : BigInt(cOp.num);
      if (c === 0n) continue;
      const absC = c < 0n ? -c : c;
      if (xr.hi >= absC) continue; // dividend must be strictly smaller in magnitude
      if (inst.sub === 'rem_s') {
        changed += replaceUses(inst.res, { tag: 'val', id: x.id });
      } else {
        const zero: Operand = inst.ty === 'i64' ? { tag: 'const', ty: 'i64', num: 0n } : { tag: 'const', ty: 'i32', num: 0 };
        changed += replaceUses(inst.res, zero);
      }
    }
  }

  if (branchFolded) recomputePreds(fn);
  return changed;
}
