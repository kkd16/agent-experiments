import type { Block, IRFunc, Inst, Operand } from '../ir/ir';
import { eachOperand } from '../ir/ir';
import { computeDom } from '../ir/cfg';

// =====================================================================
// Memory optimization — alias analysis · store→load forwarding ·
// redundant-load elimination · dead-store elimination
// =====================================================================
//
// The mid-end is strong on register-like SSA values but, until this pass, every
// access to linear memory (a `struct` field, an array element, the string/array
// runtime's raw `__load`/`__store`) survived verbatim: a value written to a
// field and read back a line later did a real round-trip through memory. This
// pass closes that gap with the three classic memory optimizations, all built on
// one shared **alias analysis**:
//
//   * **store→load forwarding (SLF)** — a `load [A]` that a prior `store [A]=v`
//     dominates, with no aliasing write in between, becomes just `v`.
//   * **redundant-load elimination (RLE)** — a `load [A]` dominated by an earlier
//     `load [A]`, no aliasing write between, reuses the earlier loaded value.
//   * **dead-store elimination (DSE)** — a `store [A]=v` fully overwritten by a
//     later `store [A]=w` before any aliasing read is removed.
//
// **Soundness model.** Strata's reference oracle is a tree-walking interpreter
// over the typed AST; the compiled wasm is what actually runs. Correctness means
// the *optimized* wasm behaves identically to the *unoptimized* wasm (which the
// differential harness already pins to the interpreter). So the alias analysis
// only has to be sound for the flat-memory program the backend emits. It is
// deliberately conservative: two addresses are proven **disjoint** only when they
// reduce to the *same base SSA value* plus *constant byte offsets* whose
// `[off, off+width)` ranges do not overlap. Any pair of *different* base values
// is assumed to may-alias — so a write through one base conservatively kills every
// fact about the other. (A real escape/allocation analysis that proves two
// distinct heap allocations disjoint is documented as the next step in JOURNAL.)
// A `call`/`call_indirect` may read and write anywhere, so it clears all facts;
// `print` reads memory but never writes it, so it is transparent to forwarding
// (yet still blocks DSE, since a removed store could be the bytes it reads).
//
// **Forwarding is a global available-memory dataflow** (a forward MUST analysis,
// meet = intersection over predecessors), iterated to a fixpoint so a value
// stored before a branch is still forwardable past the merge. A converged
// available fact `(location → value)` holds on *every* path to the use, which
// means the value's definition dominates the use — so substituting it is always
// SSA-valid. A defensive dominator check backs that up before any rewrite.

type AccWidth = 1 | 4 | 8;
function widthOf(sub: string): AccWidth {
  return sub === 'i8' ? 1 : sub === 'i64' || sub === 'f64' ? 8 : 4;
}

// An address resolved to a base SSA value (or a constant address) plus a constant
// byte offset. `root` is `v<id>` for a value base, or `c` for a constant address
// (then `off` is the absolute byte address).
interface Addr {
  root: string;
  off: number;
}

interface Fact {
  root: string;
  off: number;
  width: AccWidth;
  sub: string; // the access type — must match for a clean forward (no reinterpret)
  val: Operand; // the value the location currently holds
}

const locKey = (f: { root: string; off: number; width: AccWidth }): string => `${f.root}#${f.off}#${f.width}`;
const sameOperand = (a: Operand, b: Operand): boolean =>
  a.tag === 'const' && b.tag === 'const'
    ? a.ty === b.ty && Object.is(a.num, b.num)
    : a.tag === 'val' && b.tag === 'val' && a.id === b.id;

function rangesOverlap(aOff: number, aW: number, bOff: number, bW: number): boolean {
  return aOff < bOff + bW && bOff < aOff + aW;
}

export function memOpt(fn: IRFunc): number {
  // Nothing to do for a function that never touches linear memory.
  let touchesMem = false;
  for (const b of fn.blocks) {
    for (const i of b.insts)
      if (i.kind === 'load' || i.kind === 'store') {
        touchesMem = true;
        break;
      }
    if (touchesMem) break;
  }
  if (!touchesMem) return 0;

  // Every `alloc` yields a *fresh* region that overlaps no other allocation, so
  // two addresses rooted at two distinct alloc results are provably disjoint —
  // the allocation reasoning the conservative same-base test could not do. (A
  // fresh root vs. any non-alloc base, e.g. a handle reloaded from memory, is
  // still treated as may-alias.) This lets a store to one record forward across
  // a write to an unrelated record.
  const allocIds = new Set<number>();
  for (const b of fn.blocks) for (const i of b.insts) if (i.kind === 'alloc' && i.res !== null) allocIds.add(i.res);
  const freshDistinct = (ra: string, rb: string): boolean =>
    ra !== rb && ra[0] === 'v' && rb[0] === 'v' && allocIds.has(+ra.slice(1)) && allocIds.has(+rb.slice(1));
  const mayAlias = (a: { root: string; off: number; width: AccWidth }, b: { root: string; off: number; width: AccWidth }): boolean => {
    if (a.root === b.root) return rangesOverlap(a.off, a.width, b.off, b.width);
    if (freshDistinct(a.root, b.root)) return false;
    return true;
  };

  const byId = new Map(fn.blocks.map((b) => [b.id, b]));
  const defOf = new Map<number, Inst>();
  const defBlock = new Map<number, number>();
  for (const b of fn.blocks)
    for (const inst of b.insts)
      if (inst.res !== null) {
        defOf.set(inst.res, inst);
        defBlock.set(inst.res, b.id);
      }

  // Resolve an address operand to `{ base, constant offset }` by peeling
  // `copy` and `add(x, const)` chains. Offsets are accumulated exactly and the
  // peel stops at the first non-foldable base, so the result is the true byte
  // address `base + off` (modulo 2^32, but the small non-negative offsets struct
  // fields and folded array indices produce never wrap an aliasing decision).
  const resolveAddr = (op: Operand): Addr => {
    let off = 0;
    let cur: Operand = op;
    for (let guard = 0; guard < 64; guard++) {
      if (cur.tag === 'const') return { root: 'c', off: off + (cur.num as number) };
      const inst = defOf.get(cur.id);
      if (!inst) return { root: `v${cur.id}`, off };
      if (inst.kind === 'copy') {
        cur = inst.args[0];
        continue;
      }
      if (inst.kind === 'ibin' && inst.sub === 'add') {
        const [a, b] = inst.args;
        if (b.tag === 'const' && b.ty === 'i32') {
          off += b.num as number;
          cur = a;
          continue;
        }
        if (a.tag === 'const' && a.ty === 'i32') {
          off += a.num as number;
          cur = b;
          continue;
        }
      }
      return { root: `v${cur.id}`, off };
    }
    return { root: cur.tag === 'val' ? `v${cur.id}` : 'c', off };
  };

  // --- the available-memory transfer function (shared by the fixpoint and the
  // rewrite pass). State is a map from location key to the fact known there;
  // a `gen` replaces any prior fact at the same location (one value per cell). ---
  type State = Map<string, Fact>;
  const cloneState = (s: State): State => new Map(s);
  const killAlias = (s: State, addr: Addr, width: AccWidth): void => {
    for (const [k, f] of s) if (mayAlias(f, { root: addr.root, off: addr.off, width })) s.delete(k);
  };
  const gen = (s: State, f: Fact): void => {
    // A store/load to a location overwrites whatever value was known there.
    for (const [k, g] of s) if (g.root === f.root && g.off === f.off && g.width === f.width) s.delete(k);
    s.set(locKey(f), f);
  };

  // Apply one instruction's memory effect to `s`. Loads gen their result so a
  // later identical load is redundant; full-width stores gen the stored value;
  // an i8 store only kills (a byte store then byte load is a truncating
  // round-trip, so its value is *not* forwardable — RLE on two i8 loads still
  // works because each load yields the already-extended value).
  const step = (s: State, inst: Inst): void => {
    switch (inst.kind) {
      case 'load': {
        const width = widthOf(inst.sub);
        const addr = resolveAddr(inst.args[0]);
        if (inst.res !== null) gen(s, { root: addr.root, off: addr.off, width, sub: inst.sub, val: { tag: 'val', id: inst.res } });
        break;
      }
      case 'store': {
        const width = widthOf(inst.sub);
        const addr = resolveAddr(inst.args[0]);
        killAlias(s, addr, width);
        if (inst.sub !== 'i8') gen(s, { root: addr.root, off: addr.off, width, sub: inst.sub, val: inst.args[1] });
        break;
      }
      case 'call':
      case 'callind':
        s.clear(); // a callee may read or write any memory
        break;
      // print reads but never writes linear memory ⇒ transparent.
      // gget/gset touch globals, not the tracked memory cells ⇒ transparent.
      default:
        break;
    }
  };

  const transfer = (b: Block, inState: State): State => {
    const s = cloneState(inState);
    for (const inst of b.insts) step(s, inst);
    return s;
  };

  const stateEq = (a: State, b: State): boolean => {
    if (a.size !== b.size) return false;
    for (const [k, f] of a) {
      const g = b.get(k);
      if (!g || g.sub !== f.sub || !sameOperand(f.val, g.val)) return false;
    }
    return true;
  };
  const intersect = (a: State, b: State): State => {
    const out: State = new Map();
    for (const [k, f] of a) {
      const g = b.get(k);
      if (g && g.sub === f.sub && sameOperand(f.val, g.val)) out.set(k, f);
    }
    return out;
  };

  // --- fixpoint: OUT[b] = transfer(b, IN[b]); IN[b] = ⋂ OUT[pred]. Blocks whose
  // OUT is not yet computed (a back edge on the first sweep) are treated as the
  // universal set ⊤ and simply skipped from the intersection; iterating to a
  // fixpoint then folds in the back edge. ---
  const dom = computeDom(fn);
  const rpo = dom.rpo;
  const out = new Map<number, State>();
  let iters = 0;
  let changed = true;
  while (changed && iters++ < 1000) {
    changed = false;
    for (const id of rpo) {
      const b = byId.get(id);
      if (!b) continue;
      let inState: State | null = null;
      if (id !== fn.entry) {
        for (const p of b.preds) {
          const po = out.get(p);
          if (!po) continue; // ⊤ (uncomputed) — skip
          inState = inState === null ? cloneState(po) : intersect(inState, po);
        }
      }
      const o = transfer(b, inState ?? new Map());
      const prev = out.get(id);
      if (!prev || !stateEq(prev, o)) {
        out.set(id, o);
        changed = true;
      }
    }
  }

  // --- dominance helper: does block `a` dominate block `b`? ---
  const dominates = (a: number, b: number): boolean => {
    let x = b;
    for (let guard = 0; guard < 100000; guard++) {
      if (x === a) return true;
      const id = dom.idom.get(x);
      if (id === undefined || id === x) return false;
      x = id;
    }
    return false;
  };
  // A forwarded value must be defined where the use can see it: a constant, a
  // parameter, a same-block earlier definition (guaranteed by the forward walk),
  // or a definition whose block strictly dominates the use's block.
  const valValidAt = (val: Operand, blockId: number): boolean => {
    if (val.tag === 'const') return true;
    if (val.id < fn.params.length) return true; // a parameter dominates everything
    const db = defBlock.get(val.id);
    if (db === undefined) return false;
    return db === blockId || (db !== blockId && dominates(db, blockId));
  };

  // --- rewrite: re-walk each block from its converged IN state, forwarding loads
  // and recording silent stores. A `store [A]=v` where the available state
  // already proves `A` holds exactly `v` (same base, offset, width, value) writes
  // the same bytes that are already there — a no-op, so it is removed. This is
  // sound regardless of aliasing: if anything *might* have written `A` since `v`
  // was established, the fact would have been killed (an aliasing store) or
  // cleared (a call), so a surviving fact means the bytes are unchanged. ---
  const forwards = new Map<number, Operand>(); // load result id -> value to replace it with
  const silentStores = new Set<Inst>();
  const effVal = (o: Operand): Operand => (o.tag === 'val' ? forwards.get(o.id) ?? o : o);
  for (const id of rpo) {
    const b = byId.get(id);
    if (!b) continue;
    let inState: State | null = null;
    if (id !== fn.entry) {
      for (const p of b.preds) {
        const po = out.get(p);
        if (!po) continue;
        inState = inState === null ? cloneState(po) : intersect(inState, po);
      }
    }
    // Seed the running state, dropping any incoming fact whose value does not
    // dominate this block (defensive — a converged fact always should).
    const cur: State = new Map();
    if (inState)
      for (const [k, f] of inState) if (valValidAt(f.val, id)) cur.set(k, f);

    for (const inst of b.insts) {
      if (inst.kind === 'load' && inst.res !== null) {
        const width = widthOf(inst.sub);
        const addr = resolveAddr(inst.args[0]);
        const f = cur.get(locKey({ root: addr.root, off: addr.off, width }));
        if (f && f.sub === inst.sub && valValidAt(f.val, id)) {
          forwards.set(inst.res, f.val);
          // The load now yields `f.val`; keep that as the available value.
          gen(cur, { root: addr.root, off: addr.off, width, sub: inst.sub, val: f.val });
          continue;
        }
        step(cur, inst);
        continue;
      }
      if (inst.kind === 'store' && inst.sub !== 'i8') {
        const width = widthOf(inst.sub);
        const addr = resolveAddr(inst.args[0]);
        const v = effVal(inst.args[1]);
        const f = cur.get(locKey({ root: addr.root, off: addr.off, width }));
        if (f && f.sub === inst.sub && sameOperand(f.val, v) && valValidAt(v, id)) {
          silentStores.add(inst); // memory already holds `v` here — redundant write
          continue; // leave `cur` unchanged (the value is the same)
        }
        killAlias(cur, addr, width);
        gen(cur, { root: addr.root, off: addr.off, width, sub: inst.sub, val: v });
        continue;
      }
      step(cur, inst);
    }
  }

  // --- dead-store elimination (intra-block): a store fully overwritten by a
  // later store to the same location, with no aliasing read (load/print/call) in
  // between, is dead. ---
  const deadStores = new Set<Inst>();
  for (const b of fn.blocks) {
    // pending[k] = the latest not-yet-read store instruction at location k.
    const pending = new Map<string, { inst: Inst; addr: Addr; width: AccWidth }>();
    const readAll = (): void => pending.clear();
    const readAlias = (addr: Addr, width: AccWidth): void => {
      for (const [k, p] of pending) if (mayAlias({ root: p.addr.root, off: p.addr.off, width: p.width }, { root: addr.root, off: addr.off, width })) pending.delete(k);
    };
    for (const inst of b.insts) {
      switch (inst.kind) {
        case 'store': {
          const width = widthOf(inst.sub);
          const addr = resolveAddr(inst.args[0]);
          // An exact full overwrite of a still-pending store makes it dead.
          const k = locKey({ root: addr.root, off: addr.off, width });
          const prev = pending.get(k);
          if (prev) {
            deadStores.add(prev.inst);
            pending.delete(k);
          }
          pending.set(k, { inst, addr, width });
          break;
        }
        case 'load': {
          const width = widthOf(inst.sub);
          readAlias(resolveAddr(inst.args[0]), width);
          break;
        }
        case 'call':
        case 'callind':
        case 'print':
          readAll(); // may read any memory
          break;
        default:
          break;
      }
    }
  }

  // --- apply: rewrite forwarded uses, drop dead stores. (Forwarded loads become
  // unused and are removed by the following DCE.) ---
  let count = 0;
  if (forwards.size > 0) {
    for (const b of fn.blocks)
      eachOperand(b, (o, set) => {
        if (o.tag === 'val') {
          const r = forwards.get(o.id);
          if (r) {
            set(r.tag === 'const' ? { tag: 'const', ty: r.ty, num: r.num } : { tag: 'val', id: r.id });
            count++;
          }
        }
      });
  }
  if (deadStores.size > 0 || silentStores.size > 0) {
    for (const b of fn.blocks) {
      const before = b.insts.length;
      b.insts = b.insts.filter((i) => !deadStores.has(i) && !silentStores.has(i));
      count += before - b.insts.length;
    }
  }
  return count;
}
