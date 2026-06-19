import type { Block, Inst, IRFunc, IRType, Operand, Phi } from '../ir/ir';
import { eachOperand } from '../ir/ir';
import { computeDom } from '../ir/cfg';

// =====================================================================
// SROA — escape analysis + scalar replacement of aggregates
// =====================================================================
//
// The memory optimizer (`memopt.ts`) makes accesses to a record cheaper; this
// pass makes the record *disappear*. A struct is a bump-allocated block of
// linear memory addressed by an i32 handle; its fields are `store`/`load`s at
// constant offsets off that handle. When the handle never **escapes** — it is
// only ever used as the base address of its own field loads/stores, never
// stored into memory, returned, compared, passed to a call, or merged through a
// phi — the whole allocation is private and provably aliases nothing else. Such
// a record can be promoted out of memory entirely: each field becomes an SSA
// value, and the `alloc` + every `store`/`load` against it is deleted.
//
// **Escape analysis.** For each `alloc`, we trace the handle and every address
// derived from it by adding a *constant* (`add base, C` — the exact shape field
// access lowers to). The allocation is promotable iff every use of every such
// address value is the address operand (`args[0]`) of a `load`/`store`. Any
// other use — as a store *value*, a call/print argument, a return value, a
// comparison operand, a phi incoming, or pointer arithmetic with a non-constant
// — marks it escaped, and we leave it untouched in memory. (A handle compared to
// `null`, returned, or stored into another record therefore stays a real
// allocation; only genuinely local records are scalarized.)
//
// **Promotion is full SSA construction** (Cytron et al.): each `(alloc, offset)`
// field is a variable; we place phi nodes at the iterated dominance frontier of
// its store sites and rename loads to the reaching value. A field written before
// a branch and read after the merge becomes a `select`/phi, not a memory
// round-trip. Because the handle is proven non-escaping, a `call` between a store
// and a load cannot touch the field — so, unlike the conservative memory pass,
// promotion forwards straight across calls. Every promotion is an exact rewrite,
// pinned bit-for-bit to the reference interpreter by the differential harness.
//
// A field that is ever loaded with no reaching store (an uninitialized read)
// would force an undefined phi operand; rather than invent a value, we abort that
// one allocation's promotion and leave it in memory. Records built with the
// constructor (which writes every field at the dominating allocation site) never
// hit that case, so the common record melts away completely.

type AccWidth = 1 | 4 | 8;
function widthOf(sub: string): AccWidth {
  return sub === 'i8' ? 1 : sub === 'i64' || sub === 'f64' ? 8 : 4;
}
function irTypeOfSub(sub: string): IRType {
  return sub === 'i64' ? 'i64' : sub === 'f64' ? 'f64' : sub === 'f32' ? 'f32' : 'i32';
}

// Where a value is consumed, so escape analysis can classify every use.
type UseRef =
  | { in: 'inst'; inst: Inst; i: number }
  | { in: 'phi' }
  | { in: 'term' };

interface Slot {
  offset: number;
  sub: string;
  width: AccWidth;
  ty: IRType;
}

interface Promotable {
  alloc: Inst;
  base: number; // the alloc's result id
  slots: Map<number, Slot>; // offset -> slot
  loads: Set<Inst>; // every load to delete
  stores: Set<Inst>; // every store to delete
  addrAdds: Set<Inst>; // `add base,const` address computations (become dead)
  // For each load/store inst, the field offset it touches.
  offsetOf: Map<Inst, number>;
}

export function sroa(fn: IRFunc): number {
  const allocs: Inst[] = [];
  for (const b of fn.blocks) for (const i of b.insts) if (i.kind === 'alloc' && i.res !== null) allocs.push(i);
  if (allocs.length === 0) return 0;

  // --- one pass to index every use of every value id ---
  const uses = new Map<number, UseRef[]>();
  const addUse = (id: number, ref: UseRef): void => {
    const l = uses.get(id);
    if (l) l.push(ref);
    else uses.set(id, [ref]);
  };
  const defOf = new Map<number, Inst>();
  for (const b of fn.blocks) {
    for (const phi of b.phis) for (const inc of phi.incomings) if (inc.val.tag === 'val') addUse(inc.val.id, { in: 'phi' });
    for (const inst of b.insts) {
      if (inst.res !== null) defOf.set(inst.res, inst);
      inst.args.forEach((a, i) => {
        if (a.tag === 'val') addUse(a.id, { in: 'inst', inst, i });
      });
    }
    if (b.term.op === 'condbr' && b.term.cond.tag === 'val') addUse(b.term.cond.id, { in: 'term' });
    else if (b.term.op === 'ret' && b.term.value && b.term.value.tag === 'val') addUse(b.term.value.id, { in: 'term' });
  }

  // --- escape analysis: which allocs are promotable, and their field slots ---
  const promote: Promotable[] = [];
  for (const alloc of allocs) {
    const base = alloc.res!;
    const offsetOfVal = new Map<number, number>([[base, 0]]);
    const slots = new Map<number, Slot>();
    const loads = new Set<Inst>();
    const stores = new Set<Inst>();
    const addrAdds = new Set<Inst>();
    const offsetOf = new Map<Inst, number>();
    const work = [base];
    let escaped = false;

    while (work.length && !escaped) {
      const v = work.pop()!;
      const off = offsetOfVal.get(v)!;
      for (const u of uses.get(v) ?? []) {
        if (u.in !== 'inst') {
          escaped = true; // a phi incoming or a return / branch condition lets the handle leak
          break;
        }
        const inst = u.inst;
        if ((inst.kind === 'load' || inst.kind === 'store') && u.i === 0) {
          const width = widthOf(inst.sub);
          if (inst.sub === 'i8') { escaped = true; break; } // never promote sub-word fields
          const prev = slots.get(off);
          if (prev && (prev.sub !== inst.sub || prev.width !== width)) { escaped = true; break; }
          slots.set(off, { offset: off, sub: inst.sub, width, ty: irTypeOfSub(inst.sub) });
          offsetOf.set(inst, off);
          if (inst.kind === 'load') loads.add(inst);
          else stores.add(inst);
          continue;
        }
        if (inst.kind === 'copy' && inst.res !== null && u.i === 0) {
          // A copy of the handle is the same address — follow it (and delete it
          // with the rest). This lets promotion fire in a single pass, before the
          // copy would otherwise be propagated away.
          const seen = offsetOfVal.get(inst.res);
          if (seen === undefined) {
            offsetOfVal.set(inst.res, off);
            addrAdds.add(inst);
            work.push(inst.res);
          } else if (seen !== off) {
            escaped = true; break;
          }
          continue;
        }
        if (inst.kind === 'ibin' && inst.sub === 'add' && inst.res !== null) {
          const other = inst.args[1 - u.i];
          if (other.tag === 'const' && other.ty === 'i32') {
            const noff = off + (other.num as number);
            const seen = offsetOfVal.get(inst.res);
            if (seen === undefined) {
              offsetOfVal.set(inst.res, noff);
              addrAdds.add(inst);
              work.push(inst.res);
            } else if (seen !== noff) {
              escaped = true; break;
            }
            continue;
          }
        }
        escaped = true; // any other consumer (store value, call arg, compare, dynamic offset, …)
        break;
      }
    }
    if (escaped) continue;

    // Fields must be disjoint (no partial overlap) for independent scalarization.
    const sorted = [...slots.values()].sort((a, b) => a.offset - b.offset);
    let overlap = false;
    for (let i = 1; i < sorted.length; i++) if (sorted[i - 1].offset + sorted[i - 1].width > sorted[i].offset) overlap = true;
    if (overlap) continue;

    promote.push({ alloc, base, slots, loads, stores, addrAdds, offsetOf });
  }
  if (promote.length === 0) return 0;

  // --- full SSA construction over the promotable fields ---
  const dom = computeDom(fn);
  const byId = new Map(fn.blocks.map((b) => [b.id, b]));
  const df = dominanceFrontiers(fn, dom);

  // Each variable is one (alloc base, field offset) pair.
  const varKey = (base: number, off: number): string => `${base}#${off}`;
  const varTy = new Map<string, IRType>();
  const storesByVar = new Map<string, Set<number>>(); // varKey -> def-site blocks
  const slotOfStore = new Map<Inst, string>();
  const slotOfLoad = new Map<Inst, string>();
  for (const p of promote) {
    for (const slot of p.slots.values()) varTy.set(varKey(p.base, slot.offset), slot.ty);
    for (const b of fn.blocks)
      for (const inst of b.insts) {
        if (p.stores.has(inst)) {
          const k = varKey(p.base, p.offsetOf.get(inst)!);
          slotOfStore.set(inst, k);
          (storesByVar.get(k) ?? storesByVar.set(k, new Set()).get(k)!).add(b.id);
        } else if (p.loads.has(inst)) {
          slotOfLoad.set(inst, varKey(p.base, p.offsetOf.get(inst)!));
        }
      }
  }

  // Place phi nodes at the iterated dominance frontier of each variable's stores.
  let nextId = maxValueId(fn) + 1;
  const phiForVar = new Map<number, Map<string, number>>(); // blockId -> (varKey -> phi res id)
  const insertedPhis: { block: Block; phi: Phi; varKey: string }[] = [];
  for (const [k, defBlocks] of storesByVar) {
    const ty = varTy.get(k)!;
    const worklist = [...defBlocks];
    const placed = new Set<number>();
    while (worklist.length) {
      const x = worklist.pop()!;
      for (const y of df.get(x) ?? []) {
        if (placed.has(y)) continue;
        placed.add(y);
        const block = byId.get(y)!;
        const res = nextId++;
        fn.valueType.set(res, ty);
        const phi: Phi = { res, ty, incomings: [] };
        block.phis.push(phi);
        (phiForVar.get(y) ?? phiForVar.set(y, new Map()).get(y)!).set(k, res);
        insertedPhis.push({ block, phi, varKey: k });
        if (!defBlocks.has(y)) worklist.push(y);
      }
    }
  }

  // Rename: DFS over the dominator tree, tracking each variable's reaching value.
  const forward = new Map<number, Operand>(); // load res id -> the value it now yields
  const resolve = (o: Operand): Operand => {
    let cur = o;
    for (let g = 0; g < 100000 && cur.tag === 'val'; g++) {
      const r = forward.get(cur.id);
      if (!r) break;
      cur = r;
    }
    return cur;
  };
  let bailed = false;
  const succ = (b: Block): number[] =>
    b.term.op === 'br' ? [b.term.target] : b.term.op === 'condbr' ? (b.term.t === b.term.f ? [b.term.t] : [b.term.t, b.term.f]) : [];

  const rename = (blockId: number, parentCur: Map<string, Operand>): void => {
    if (bailed) return;
    const cur = new Map(parentCur);
    const block = byId.get(blockId)!;
    // phis defined here become the reaching value of their variable.
    for (const [k, res] of phiForVar.get(blockId) ?? []) cur.set(k, { tag: 'val', id: res });
    for (const inst of block.insts) {
      const sk = slotOfStore.get(inst);
      if (sk !== undefined) {
        cur.set(sk, resolve(inst.args[1]));
        continue;
      }
      const lk = slotOfLoad.get(inst);
      if (lk !== undefined && inst.res !== null) {
        const val = cur.get(lk);
        if (val === undefined) { bailed = true; return; } // uninitialized read — abort cleanly
        forward.set(inst.res, val);
      }
    }
    // fill successor phi operands with this block's outgoing values.
    for (const s of succ(block)) {
      for (const { phi, varKey: k, block: pb } of insertedPhis) {
        if (pb.id !== s) continue;
        const val = cur.get(k);
        if (val === undefined) { bailed = true; return; }
        phi.incomings.push({ pred: blockId, val });
      }
    }
    for (const c of dom.domChildren.get(blockId) ?? []) rename(c, cur);
  };
  rename(fn.entry, new Map());

  if (bailed) {
    // Undo the speculative phi insertion and forwarding, leaving the IR untouched.
    for (const { block, phi } of insertedPhis) block.phis = block.phis.filter((p) => p !== phi);
    return 0;
  }

  // --- apply: rewrite forwarded uses, then delete promoted memory ops ---
  let count = 0;
  for (const b of fn.blocks)
    eachOperand(b, (o, set) => {
      if (o.tag === 'val' && forward.has(o.id)) {
        set(resolve(o));
        count++;
      }
    });
  const dead = new Set<Inst>();
  for (const p of promote) {
    for (const s of p.stores) dead.add(s);
    for (const l of p.loads) dead.add(l);
    for (const a of p.addrAdds) dead.add(a);
    dead.add(p.alloc);
  }
  for (const b of fn.blocks) {
    const before = b.insts.length;
    b.insts = b.insts.filter((i) => !dead.has(i));
    count += before - b.insts.length;
  }
  return count;
}

// Cooper–Harvey–Kennedy dominance frontiers from the dominator tree.
function dominanceFrontiers(fn: IRFunc, dom: ReturnType<typeof computeDom>): Map<number, number[]> {
  const df = new Map<number, Set<number>>();
  for (const id of dom.rpo) df.set(id, new Set());
  for (const b of fn.blocks) {
    if (b.preds.length < 2) continue;
    const idomB = dom.idom.get(b.id);
    for (const p of b.preds) {
      let runner: number | undefined = p;
      while (runner !== undefined && runner !== idomB) {
        df.get(runner)?.add(b.id);
        const nxt: number | undefined = dom.idom.get(runner);
        if (nxt === runner) break; // entry is its own idom
        runner = nxt;
      }
    }
  }
  return new Map([...df].map(([k, v]) => [k, [...v]]));
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
