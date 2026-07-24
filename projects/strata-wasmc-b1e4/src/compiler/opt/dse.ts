import type { Block, IRFunc, Inst, Operand } from '../ir/ir';
import { computeDom, succOfTerm } from '../ir/cfg';

// =====================================================================
// Global (cross-block) dead-store elimination — backward liveness of memory
// =====================================================================
//
// `opt/memopt.ts` runs a *forward* available-memory dataflow (store→load
// forwarding, redundant-load elimination) and, as a bonus, removes stores that a
// later store overwrites **within the same basic block**. This pass is its
// *backward* dual: a proper liveness-of-memory analysis over the whole control-flow
// graph that removes a store whose written bytes are **never read on any path to
// the function's exit** — because every such path overwrites the location first.
//
//     A: arr[0] = 999          ← dead: on *every* path to the read, arr[0] is
//        condbr(c, T, F)          overwritten by the block-D store before it is
//     T: … (no read of arr[0])    ever read, so the 999 write is unobservable
//     F: … (no read of arr[0])
//     D: arr[0] = 1            ← the killing store (dominates the read on all paths)
//        print(arr[0])
//
// memopt's intra-block DSE cannot see this — the dead store and its killer live in
// different blocks. This pass closes exactly that gap, the "cross-block / partial
// dead-store elimination" long noted as the next step in JOURNAL.
//
// --- The lattice ---------------------------------------------------------------
// A **may-live** analysis over the finite set of *store locations* the function
// mentions (a candidate is a `(base, byte-offset, width)` triple — exactly what a
// store could later be proven to overwrite). At every program point a location is
// "live" if some forward path reads it before the next full overwrite. Meet is
// **union** over successors (live on *any* successor path ⇒ live), so a location is
// dead at a store only when it is dead on *all* paths — the safe direction.
//
//   * a `load [A]` (and any `may-read-anything` op: call / print / vload / vstore)
//     **gens** every candidate it may-alias — the bytes might be observed, so keep
//     the stores feeding them.
//   * a `store [L]` **kills** exactly location `L` — from here backward the old
//     contents of `L` are gone. It reads nothing, so it gens nothing.
//   * at a function exit (a `ret`/`unreachable` block) **every** candidate is live:
//     memory can escape to the caller (a returned handle into a heap allocation),
//     so we conservatively assume all of it may still be read. A store is proven
//     dead only when a *later store on every path* overwrites it before exit.
//
// --- Soundness -----------------------------------------------------------------
// The alias model is byte-identical to memopt's, and deliberately conservative: two
// addresses are disjoint only when they share the same base SSA value with
// non-overlapping `[off, off+width)` ranges, or root at two distinct `alloc`s (each
// `alloc` is a fresh region aliasing no other). Any other pair may-alias. A killing
// store must **exactly** cover the candidate (same base, offset *and* width) — a
// partial or merely-may-aliasing store neither kills nor reads, so a store it only
// half-covers stays live and survives. Because the dead store and its killer target
// the *identical* address, a trap the dead store would raise (out-of-bounds) is
// raised identically by the killer, so removal preserves trap behaviour for the
// non-trapping programs the differential oracle pins. Any read that *might* observe
// the bytes — including `print`, which reads memory — gens the location and blocks
// removal, matching memopt's own DSE conservatism. When nothing is provably dead the
// IR is untouched, so the three-engine oracle proves the pass never changes output.

type AccWidth = 1 | 4 | 8;
function widthOf(sub: string): AccWidth {
  return sub === 'i8' ? 1 : sub === 'i64' || sub === 'f64' ? 8 : 4;
}

// An address resolved to a base SSA value (`v<id>`) or a constant address (`c`)
// plus a constant byte offset — the same normal form memopt uses.
interface Addr {
  root: string;
  off: number;
}
interface Loc {
  root: string;
  off: number;
  width: AccWidth;
}
const locKey = (l: Loc): string => `${l.root}#${l.off}#${l.width}`;

function rangesOverlap(aOff: number, aW: number, bOff: number, bW: number): boolean {
  return aOff < bOff + bW && bOff < aOff + aW;
}

export function globalDSE(fn: IRFunc): number {
  // Fast out: a function that never stores has nothing to eliminate.
  let hasStore = false;
  for (const b of fn.blocks) {
    for (const i of b.insts)
      if (i.kind === 'store') {
        hasStore = true;
        break;
      }
    if (hasStore) break;
  }
  if (!hasStore) return 0;

  const defOf = new Map<number, Inst>();
  for (const b of fn.blocks) for (const inst of b.insts) if (inst.res !== null) defOf.set(inst.res, inst);

  // Peel `copy` and `add(x, const)` chains to the true `base + off` (memopt's
  // resolver, verbatim in behaviour) so field/element addresses normalize.
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

  // Distinct `alloc` results name provably-disjoint regions (memopt's reasoning).
  const allocIds = new Set<number>();
  for (const b of fn.blocks) for (const i of b.insts) if (i.kind === 'alloc' && i.res !== null) allocIds.add(i.res);
  const freshDistinct = (ra: string, rb: string): boolean =>
    ra !== rb && ra[0] === 'v' && rb[0] === 'v' && allocIds.has(+ra.slice(1)) && allocIds.has(+rb.slice(1));
  const mayAlias = (a: Loc, b: Loc): boolean => {
    if (a.root === b.root) return rangesOverlap(a.off, a.width, b.off, b.width);
    if (freshDistinct(a.root, b.root)) return false;
    return true;
  };

  // --- candidate universe: every store's exact target location. Only these can
  // ever be killed, so liveness only has to track this finite set. ---
  interface StoreSite {
    inst: Inst;
    loc: Loc;
    key: string;
  }
  const stores: StoreSite[] = [];
  const candidateKeys = new Set<string>();
  const candidates: Loc[] = [];
  for (const b of fn.blocks)
    for (const inst of b.insts)
      if (inst.kind === 'store') {
        const addr = resolveAddr(inst.args[0]);
        const loc: Loc = { root: addr.root, off: addr.off, width: widthOf(inst.sub) };
        const key = locKey(loc);
        stores.push({ inst, loc, key });
        if (!candidateKeys.has(key)) {
          candidateKeys.add(key);
          candidates.push(loc);
        }
      }

  const byId = new Map(fn.blocks.map((b) => [b.id, b]));
  type Live = Set<string>; // set of live candidate location keys
  const ALL = (): Live => new Set(candidateKeys);

  // Apply one instruction's *backward* effect to the running live set.
  const step = (live: Live, inst: Inst): void => {
    switch (inst.kind) {
      case 'load': {
        const a = resolveAddr(inst.args[0]);
        const rl: Loc = { root: a.root, off: a.off, width: widthOf(inst.sub) };
        for (const c of candidates) if (mayAlias(c, rl)) live.add(c.root + '#' + c.off + '#' + c.width);
        break;
      }
      case 'store': {
        const a = resolveAddr(inst.args[0]);
        const key = a.root + '#' + a.off + '#' + widthOf(inst.sub);
        live.delete(key); // exact overwrite ⇒ old contents dead from here backward
        break;
      }
      // A callee, or a vector memory op, may read anywhere; `print` reads memory to
      // format its argument. All keep every candidate live (block removal past them).
      case 'call':
      case 'callind':
      case 'print':
      case 'vload':
      case 'vstore':
        for (const c of candidates) live.add(c.root + '#' + c.off + '#' + c.width);
        break;
      default:
        break;
    }
  };

  const transfer = (b: Block, out: Live): Live => {
    const live = new Set(out);
    for (let i = b.insts.length - 1; i >= 0; i--) step(live, b.insts[i]);
    return live;
  };

  const eqSet = (a: Live, b: Live): boolean => {
    if (a.size !== b.size) return false;
    for (const k of a) if (!b.has(k)) return false;
    return true;
  };

  // --- backward fixpoint: LIVE_in[b] = transfer(b, LIVE_out[b]);
  //     LIVE_out[b] = ⋃ LIVE_in[succ]  (⋃ = union; exit blocks seed ALL). ---
  const dom = computeDom(fn);
  const order = [...dom.rpo].reverse(); // postorder: process users before defs
  const liveIn = new Map<number, Live>();
  for (const b of fn.blocks) liveIn.set(b.id, new Set());
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 10000) {
    changed = false;
    for (const id of order) {
      const b = byId.get(id);
      if (!b) continue;
      const succs = succOfTerm(b.term);
      let out: Live;
      if (succs.length === 0) {
        out = ALL(); // ret / unreachable: memory may escape to the caller
      } else {
        out = new Set();
        for (const s of succs) {
          const si = liveIn.get(s);
          if (si) for (const k of si) out.add(k);
        }
      }
      const nin = transfer(b, out);
      if (!eqSet(nin, liveIn.get(id)!)) {
        liveIn.set(id, nin);
        changed = true;
      }
    }
  }

  // --- mark: re-walk each block backward from its converged LIVE_out; a store
  // whose location is not live at that point writes bytes no path ever reads. ---
  const dead = new Set<Inst>();
  for (const b of fn.blocks) {
    const succs = succOfTerm(b.term);
    let live: Live;
    if (succs.length === 0) live = ALL();
    else {
      live = new Set();
      for (const s of succs) {
        const si = liveIn.get(s);
        if (si) for (const k of si) live.add(k);
      }
    }
    for (let i = b.insts.length - 1; i >= 0; i--) {
      const inst = b.insts[i];
      if (inst.kind === 'store') {
        const a = resolveAddr(inst.args[0]);
        const key = a.root + '#' + a.off + '#' + widthOf(inst.sub);
        if (!live.has(key)) dead.add(inst);
        // Whether or not this store is dead, it overwrites `key`: kill it so an
        // *earlier* store to the same location (also then dead) is caught too.
        live.delete(key);
      } else {
        step(live, inst);
      }
    }
  }

  if (dead.size === 0) return 0;
  let removed = 0;
  for (const b of fn.blocks) {
    const before = b.insts.length;
    b.insts = b.insts.filter((i) => !dead.has(i));
    removed += before - b.insts.length;
  }
  return removed;
}
