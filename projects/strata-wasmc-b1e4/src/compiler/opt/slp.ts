import type { Block, Inst, IRFunc, IRType, Operand } from '../ir/ir';

// =====================================================================
// SLP vectorization — isomorphic straight-line scalar ops → one v128
// =====================================================================
//
// The auto-vectorizer (`opt/vectorize.ts`) finds parallelism *across the
// iterations of a counted loop*. SLP — **superword-level parallelism**
// (Larsen & Amarasinghe, PLDI 2000) — finds the same width in *straight-line
// code within a single basic block*: a run of independent, structurally
// identical scalar statements sitting side by side.
//
//      c[0] = a[0] * b[0];        ┐
//      c[1] = a[1] * b[1];        │  four isomorphic statements, four
//      c[2] = a[2] * b[2];        │  adjacent elements — one v128.load a,
//      c[3] = a[3] * b[3];        ┘  one v128.load b, one i32x4.mul, one v128.store c.
//
// Nothing statement `k` writes is read by statement `k+1`, so the four collapse
// into one 4-wide SIMD chain. This is the natural partner of two passes already
// here: **full loop unrolling** turns a small fixed-trip loop into exactly this
// shape (a straight-line run of `c[0..3] = …`), and SLP then re-widens it — so
// `unroll → SLP` recovers the vector win on loops the counted-loop vectorizer
// skips (an unknown but small trip count, a body the loop form rejected), and
// hand-unrolled kernels vectorize with no loop at all.
//
// --- the algorithm (bottom-up, seeded at adjacent stores) ------------------
//
// SLP builds a **pack tree** rooted at a *seed* — a group of `W` stores to
// contiguous addresses `A, A+E, …, A+(W−1)·E` (element size `E`, lane count `W`
// from the store's element type: i32/f32 → W=4, i64/f64 → W=2, one v128 either
// way). To emit the seed as a single `vstore` we must produce its `W` stored
// values as one v128, so we recurse on them:
//
//   • all `W` are the same constant / SSA value      → **splat**;
//   • all `W` are lanewise constants                 → splat + `replace_lane`;
//   • all `W` are loads from contiguous `B+k·E`       → one **vload**;
//   • all `W` are the same `ibin`/`fbin` op           → **recurse** on each
//                                                        operand column, emit one `vbin`.
//
// Any other shape declines the pack, and a declined pack declines the whole
// seed — SLP widens the entire tree or nothing. Every leaf is thus a splat, a
// const-vector or a vload, every interior node a lanewise `vbin`, so each lane
// runs the *identical* scalar op it replaced. Because `i32x4`/`i64x2`
// `add`/`sub`/`mul` wrap exactly like the scalar ints, `v128.and`/`or`/`xor` are
// bit-exact, and `f32x4`/`f64x2` `add`/`sub`/`mul`/`div`/`min`/`max` round
// per-lane exactly like the scalar floats, a widened tree is **bit-for-bit** the
// straight-line code it replaced — and unlike a reduction (`vectorize.ts`) no
// lanes are ever shuffled, so *float* elementwise trees widen too.
//
// --- why the memory reordering is sound ------------------------------------
//
// Collapsing `W` scalar loads/stores into one vload/vstore reorders memory ops,
// so the pass proves the reordering can't change a result:
//
//   • The `W` seed stores write the `W` *distinct* addresses `A+k·E`, so they
//     never alias each other — one `vstore` writing all `W` lanes leaves memory
//     identical to the `W` scalar stores in any order.
//   • Every load group the tree reads is checked against the store region `[A,
//     A+W·E)`: it must be either **identical** to it (same base, same offset — an
//     in-place `a[k] = f(a[k])` kernel, purely within-lane) or **provably
//     disjoint** (a distinct `alloc`, or the same base ≥ `W·E` bytes away). A
//     *partial* overlap — the shifted `a[k] = a[k+1]` stencil, or a permutation —
//     is neither, so it is declined: those carry a genuine cross-lane dependence.
//   • The span of block instructions the pass touches is scanned for any *other*
//     memory op (a foreign load/store/call) that **may-alias** the tree's
//     regions; one aborts the seed. So the only memory ops ever reordered are the
//     tree's own, whose independence the two rules above already established.
//
// Each rule is checked; on the slightest doubt the seed is declined and the IR is
// left untouched, so a bug can only miss an opportunity. The three-engine
// differential oracle (interpreter = V8 = from-scratch VM, at every −O level)
// proves the widening it *did* do never changed behaviour.

const ARRAY_HEADER = 8; // unused directly, but documents the element-address layout the seeds ride on
void ARRAY_HEADER;

// The four lane shapes, keyed by the element scalar type. Each fixes the lane
// count `W` (how many contiguous elements one v128 holds) and the element byte
// size `E` (the subscript stride). Mirrors `opt/vectorize.ts`.
type VShape = 'i32x4' | 'f32x4' | 'i64x2' | 'f64x2';
type Elem = 'i32' | 'f32' | 'i64' | 'f64';
const SHAPE_OF: Record<Elem, VShape> = { i32: 'i32x4', f32: 'f32x4', i64: 'i64x2', f64: 'f64x2' };
const LANES_OF: Record<VShape, number> = { i32x4: 4, f32x4: 4, i64x2: 2, f64x2: 2 };
const ELEMSIZE_OF: Record<VShape, number> = { i32x4: 4, f32x4: 4, i64x2: 8, f64x2: 8 };

// A scalar integer op promoted to its lanewise form per shape. No SIMD integer
// divide/remainder/shift exists, so a tree using them declines. The bitwise ops
// are whole-register (`v128.*`), lane-shape agnostic.
const IBIN_VEC: Record<VShape, Record<string, string>> = {
  i32x4: { add: 'i32x4.add', sub: 'i32x4.sub', mul: 'i32x4.mul', and: 'v128.and', or: 'v128.or', xor: 'v128.xor' },
  i64x2: { add: 'i64x2.add', sub: 'i64x2.sub', mul: 'i64x2.mul', and: 'v128.and', or: 'v128.or', xor: 'v128.xor' },
  f32x4: {}, f64x2: {},
};
// A scalar float op promoted to its lanewise form per shape. Each lane rounds
// exactly like the scalar op, so an elementwise float tree stays bit-exact.
const FBIN_VEC: Record<VShape, Record<string, string>> = {
  f32x4: { add: 'f32x4.add', sub: 'f32x4.sub', mul: 'f32x4.mul', div: 'f32x4.div', min: 'f32x4.min', max: 'f32x4.max' },
  f64x2: { add: 'f64x2.add', sub: 'f64x2.sub', mul: 'f64x2.mul', div: 'f64x2.div', min: 'f64x2.min', max: 'f64x2.max' },
  i32x4: {}, i64x2: {},
};

// The byte width of a scalar memory access, for the alias model.
function widthOfSub(sub: string): number {
  switch (sub) {
    case 'i8': return 1;
    case 'i32': case 'f32': return 4;
    case 'i64': case 'f64': return 8;
    default: return 8; // an unknown access is treated as the widest — conservative for aliasing
  }
}

// A byte interval `[lo, hi)` rooted at a base. `root` is `v<id>` for an SSA base
// or `c` for a constant (absolute) address.
interface Region {
  root: string;
  lo: number;
  hi: number;
}

export function slp(fn: IRFunc): number {
  // Nothing to do for a function that never stores to linear memory.
  let hasStore = false;
  for (const b of fn.blocks) { for (const i of b.insts) if (i.kind === 'store') { hasStore = true; break; } if (hasStore) break; }
  if (!hasStore) return 0;

  // Whole-function definition map (address resolution and value classification
  // both look up defs that may sit in a dominating block).
  const defOf = new Map<number, Inst>();
  for (const b of fn.blocks) for (const i of b.insts) if (i.res !== null) defOf.set(i.res, i);

  // Every `alloc` yields a region overlapping no other allocation, so two
  // addresses rooted at two distinct alloc results are provably disjoint — the
  // reasoning a plain same-base test can't do. (Same as `opt/memopt.ts`.)
  const allocIds = new Set<number>();
  for (const b of fn.blocks) for (const i of b.insts) if (i.kind === 'alloc' && i.res !== null) allocIds.add(i.res);
  const distinctAllocs = (ra: string, rb: string): boolean =>
    ra !== rb && ra[0] === 'v' && rb[0] === 'v' && allocIds.has(+ra.slice(1)) && allocIds.has(+rb.slice(1));

  // Resolve an address operand to `{ base root, constant byte offset }` by
  // peeling `copy` and `add(x, i32-const)` chains (mirrors `opt/memopt.ts`). The
  // small non-negative offsets folded array subscripts produce never wrap an
  // aliasing decision.
  const resolveAddr = (op: Operand): { root: string; off: number } => {
    let off = 0;
    let cur: Operand = op;
    for (let guard = 0; guard < 64; guard++) {
      if (cur.tag === 'const') return { root: 'c', off: off + Number(cur.num) };
      const inst = defOf.get(cur.id);
      if (!inst) return { root: `v${cur.id}`, off };
      if (inst.kind === 'copy') { cur = inst.args[0]; continue; }
      if (inst.kind === 'ibin' && inst.sub === 'add') {
        const [a, b] = inst.args;
        if (b.tag === 'const' && b.ty === 'i32') { off += Number(b.num); cur = a; continue; }
        if (a.tag === 'const' && a.ty === 'i32') { off += Number(a.num); cur = b; continue; }
      }
      return { root: `v${cur.id}`, off };
    }
    return { root: cur.tag === 'val' ? `v${cur.id}` : 'c', off };
  };

  const overlap = (a: Region, b: Region): boolean => {
    if (a.root === b.root) return a.lo < b.hi && b.lo < a.hi;
    if (distinctAllocs(a.root, b.root)) return false;
    return true; // two unrelated non-alloc bases: assume may-alias
  };

  let changed = 0;
  for (const block of fn.blocks) changed += slpBlock(block, fn, defOf, resolveAddr, overlap);
  return changed;
}

type ResolveAddr = (op: Operand) => { root: string; off: number };
type Overlap = (a: Region, b: Region) => boolean;

// One committed seed: the instructions to delete and the vector instructions to
// splice in at the seed's last store.
interface Action {
  consumed: Set<Inst>; // scalar loads / ibins / seed stores to remove
  emit: Inst[]; // the vector instructions, in dependency order (vstore last)
  atStore: Inst; // the seed store the emit replaces (its slot in the block)
}

function slpBlock(block: Block, fn: IRFunc, defOf: Map<number, Inst>, resolveAddr: ResolveAddr, overlap: Overlap): number {
  // Instruction → position, for the region scan and the "value dominates the
  // insertion point" reasoning.
  const posOf = new Map<Inst, number>();
  block.insts.forEach((inst, i) => posOf.set(inst, i));

  // A block-local use count over the whole function: a scalar tree node is only
  // deletable if *every* use of its result is inside the tree, so SLP is a strict
  // win (it removes instructions, never duplicates them). We compute the total
  // use count once and later check the tree consumes them all.
  const useCount = new Map<number, number>();
  const bump = (o: Operand): void => { if (o.tag === 'val') useCount.set(o.id, (useCount.get(o.id) ?? 0) + 1); };
  for (const b of fn.blocks) {
    for (const p of b.phis) for (const inc of p.incomings) bump(inc.val);
    for (const i of b.insts) for (const a of i.args) bump(a);
    const t = b.term;
    if (t.op === 'condbr') bump(t.cond);
    else if (t.op === 'ret' && t.value) bump(t.value);
  }

  let nextVal = maxValueId(fn) + 1;
  const fresh = (ty: IRType): number => { const id = nextVal++; fn.valueType.set(id, ty); return id; };

  // --- collect candidate seeds: runs of W contiguous stores ------------------
  // Group stores by (base root, element type), then find maximal runs of
  // offsets `off, off+E, …` and cut them into non-overlapping W-wide seeds.
  interface StoreRec { inst: Inst; root: string; off: number; elem: Elem; }
  const storeRecs: StoreRec[] = [];
  for (const inst of block.insts) {
    if (inst.kind !== 'store') continue;
    const elem = inst.sub as Elem;
    if (elem !== 'i32' && elem !== 'f32' && elem !== 'i64' && elem !== 'f64') continue;
    const a = resolveAddr(inst.args[0]);
    storeRecs.push({ inst, root: a.root, off: a.off, elem });
  }
  if (storeRecs.length < 2) return 0;

  const byGroup = new Map<string, StoreRec[]>();
  for (const s of storeRecs) {
    const k = `${s.root}#${s.elem}`;
    (byGroup.get(k) ?? byGroup.set(k, []).get(k)!).push(s);
  }

  const seeds: StoreRec[][] = [];
  for (const recs of byGroup.values()) {
    const elem = recs[0].elem;
    const W = LANES_OF[SHAPE_OF[elem]];
    const E = ELEMSIZE_OF[SHAPE_OF[elem]];
    // Unique by offset (two stores to the same address in one block is not a lane
    // group — keep the later in program order, which is what memory ends up with).
    const byOff = new Map<number, StoreRec>();
    for (const r of recs) { const prev = byOff.get(r.off); if (!prev || posOf.get(r.inst)! > posOf.get(prev.inst)!) byOff.set(r.off, r); }
    const offs = [...byOff.keys()].sort((x, y) => x - y);
    for (let i = 0; i + W <= offs.length; ) {
      let ok = true;
      for (let k = 1; k < W && ok; k++) if (offs[i + k] !== offs[i] + k * E) ok = false;
      if (ok) { seeds.push(Array.from({ length: W }, (_, k) => byOff.get(offs[i + k])!)); i += W; }
      else i += 1;
    }
  }
  if (seeds.length === 0) return 0;

  const actions: Action[] = [];
  const claimed = new Set<Inst>(); // an instruction may back only one seed

  for (const seed of seeds) {
    const action = tryPackSeed(seed, block, defOf, posOf, useCount, resolveAddr, overlap, fresh);
    if (!action) continue;
    // Skip a seed that reuses an instruction another committed seed already took.
    let clash = false;
    for (const c of action.consumed) if (claimed.has(c)) { clash = true; break; }
    if (clash) continue;
    for (const c of action.consumed) claimed.add(c);
    actions.push(action);
  }
  if (actions.length === 0) return 0;

  // --- apply every committed action in one rebuild of the block --------------
  const emitAt = new Map<Inst, Inst[]>();
  const remove = new Set<Inst>();
  for (const a of actions) {
    emitAt.set(a.atStore, a.emit);
    for (const c of a.consumed) remove.add(c);
  }
  const rebuilt: Inst[] = [];
  for (const inst of block.insts) {
    const em = emitAt.get(inst);
    if (em) { rebuilt.push(...em); continue; } // the seed store's slot becomes the vector chain
    if (remove.has(inst)) continue; // a consumed load / ibin / non-last seed store
    rebuilt.push(inst);
  }
  block.insts = rebuilt;
  return actions.length;
}

function tryPackSeed(
  seed: { inst: Inst; root: string; off: number; elem: Elem }[],
  block: Block,
  defOf: Map<number, Inst>,
  posOf: Map<Inst, number>,
  useCount: Map<number, number>,
  resolveAddr: ResolveAddr,
  overlap: Overlap,
  fresh: (ty: IRType) => number,
): Action | null {
  const elem = seed[0].elem;
  const shape = SHAPE_OF[elem];
  const W = LANES_OF[shape];
  const E = ELEMSIZE_OF[shape];
  const storeRegion: Region = { root: seed[0].root, lo: seed[0].off, hi: seed[0].off + W * E };

  const consumed = new Set<Inst>();
  const emit: Inst[] = [];
  const treeLoadRegions: Region[] = [];
  let failed = false;
  const fail = (): null => { failed = true; return null; };

  // A def is "in this block" — only block-local scalar instructions may be
  // consumed / reasoned about positionally. A value defined elsewhere (a
  // dominating block, a param, a phi) is a legal leaf but not part of the tree.
  const localDef = (o: Operand): Inst | null => {
    if (o.tag !== 'val') return null;
    const d = defOf.get(o.id);
    return d && posOf.has(d) ? d : null;
  };

  const sameOp = (a: Operand, b: Operand): boolean =>
    a.tag === 'const' && b.tag === 'const' ? a.ty === b.ty && Object.is(Number(a.num), Number(b.num)) && a.num === b.num
      : a.tag === 'val' && b.tag === 'val' && a.id === b.id;

  const clone = (o: Operand): Operand => (o.tag === 'const' ? { tag: 'const', ty: o.ty, num: o.num } : { tag: 'val', id: o.id });
  const laneIR: IRType = elem;

  // Materialize a v128 from `W` scalar lane operands. Returns the produced v128
  // operand, or null (setting `failed`) if the column isn't packable. Emits into
  // `emit` in dependency order (leaves first). Recurses through isomorphic ops.
  const packColumn = (vals: Operand[]): Operand | null => {
    if (failed) return null;

    // (1) Uniform — every lane the same operand: one splat.
    if (vals.every((v) => sameOp(v, vals[0]))) {
      const id = fresh('v128');
      emit.push({ res: id, ty: 'v128', kind: 'vsplat', sub: shape, args: [clone(vals[0])] });
      return { tag: 'val', id };
    }

    // (2) All constants (lanewise different): splat lane 0, then replace_lane 1…W−1.
    if (vals.every((v) => v.tag === 'const')) {
      let acc = fresh('v128');
      emit.push({ res: acc, ty: 'v128', kind: 'vsplat', sub: shape, args: [clone(vals[0])] });
      for (let k = 1; k < W; k++) {
        const id = fresh('v128');
        emit.push({ res: id, ty: 'v128', kind: 'vreplace', sub: `${shape}.replace_lane:${k}`, args: [{ tag: 'val', id: acc }, clone(vals[k])] });
        acc = id;
      }
      return { tag: 'val', id: acc };
    }

    const defs = vals.map(localDef);
    if (defs.some((d) => d === null)) return fail(); // a non-uniform, non-const, non-local operand — can't widen

    // (3) All loads from contiguous `B+k·E`, same element type as the shape.
    if (defs.every((d) => d!.kind === 'load')) {
      for (const d of defs) if (d!.sub !== elem) return fail(); // a different element width can't share a v128
      const a0 = resolveAddr(defs[0]!.args[0]);
      for (let k = 1; k < W; k++) {
        const ak = resolveAddr(defs[k]!.args[0]);
        if (ak.root !== a0.root || ak.off !== a0.off + k * E) return fail(); // not a contiguous, base-aligned run
      }
      for (const d of defs) consumed.add(d!);
      const region: Region = { root: a0.root, lo: a0.off, hi: a0.off + W * E };
      // Legality vs the store region: identical (in-place) or provably disjoint.
      const identical = region.root === storeRegion.root && region.lo === storeRegion.lo && region.hi === storeRegion.hi;
      if (!identical && overlap(region, storeRegion)) return fail(); // a shifted/partial overlap — a cross-lane hazard
      treeLoadRegions.push(region);
      const id = fresh('v128');
      emit.push({ res: id, ty: 'v128', kind: 'vload', sub: shape, args: [clone(defs[0]!.args[0])] });
      return { tag: 'val', id };
    }

    // (4) All the same lanewise-representable ibin/fbin op: recurse per operand column.
    const k0 = defs[0]!.kind;
    if ((k0 === 'ibin' || k0 === 'fbin') && defs.every((d) => d!.kind === k0 && d!.sub === defs[0]!.sub)) {
      const table = k0 === 'ibin' ? IBIN_VEC[shape] : FBIN_VEC[shape];
      const vsub = table[defs[0]!.sub];
      if (!vsub) return fail(); // no lanewise form (a shift, an integer divide, an f min/max on an int shape…)
      for (const d of defs) consumed.add(d!);
      const lhs = packColumn(defs.map((d) => d!.args[0]));
      const rhs = packColumn(defs.map((d) => d!.args[1]));
      if (!lhs || !rhs) return fail();
      const id = fresh('v128');
      emit.push({ res: id, ty: 'v128', kind: 'vbin', sub: vsub, args: [lhs, rhs] });
      return { tag: 'val', id };
    }

    return fail(); // an unhandled shape (cast, call, mixed ops, a load beside an ibin…)
  };

  // Build the tree from the seed's stored values.
  const storedVals = seed.map((s) => s.inst.args[1]);
  const packed = packColumn(storedVals);
  if (failed || !packed) return null;

  for (const s of seed) consumed.add(s.inst);

  // --- every consumed scalar value must be fully internal to the tree --------
  // A consumed instruction is deleted, so *every* use of its result must be by
  // another consumed instruction — otherwise deleting it strands a live use.
  // `internal[r]` counts the tree's own uses of `r` (uses appearing as an operand
  // of a consumed instruction); it must equal `r`'s whole-function use count.
  // A single value used by two lanes (e.g. `c[k] = a[k] * a[k]`) is counted twice
  // on both sides, so the equality still holds. This is what caught the case where
  // store→load forwarding rewired a later `print(c[k])` to read the tree's own
  // stored value: that print use is external, so the equality fails and we decline.
  const internal = new Map<number, number>();
  for (const inst of consumed) for (const a of inst.args) if (a.tag === 'val') internal.set(a.id, (internal.get(a.id) ?? 0) + 1);
  for (const inst of consumed) {
    if (inst.res === null) continue; // a store: no result
    if ((internal.get(inst.res) ?? 0) !== (useCount.get(inst.res) ?? 0)) return null; // a use escapes the tree
  }

  // --- the emitted vectors must never reference a value we are deleting --------
  // A leaf we *keep* (a splat source, a load/store address) could coincide with a
  // value another column *consumes* and deletes; emitting a reference to it would
  // dangle. Reject if any emitted instruction reads an original (non-fresh) value
  // that lands in the consumed set.
  const emittedIds = new Set<number>();
  for (const inst of emit) if (inst.res !== null) emittedIds.add(inst.res);
  for (const inst of emit)
    for (const a of inst.args)
      if (a.tag === 'val' && !emittedIds.has(a.id)) {
        const d = defOf.get(a.id);
        if (d && consumed.has(d)) return null; // would reference a deleted value
      }

  // --- ordering legality: no *aliasing* foreign memory op in the touched span --
  let firstPos = Infinity;
  let lastStorePos = -1;
  let lastStore = seed[0].inst;
  for (const inst of consumed) {
    const p = posOf.get(inst)!;
    if (p < firstPos) firstPos = p;
  }
  for (const s of seed) { const p = posOf.get(s.inst)!; if (p > lastStorePos) { lastStorePos = p; lastStore = s.inst; } }

  const regionsToGuard = [storeRegion, ...treeLoadRegions];
  for (let p = firstPos; p <= lastStorePos; p++) {
    const inst = block.insts[p];
    if (consumed.has(inst)) continue; // a tree instruction — already reasoned about
    switch (inst.kind) {
      case 'call':
      case 'callind':
        return null; // a callee may read or write any array we touch
      case 'load':
      case 'store': {
        const a = resolveAddr(inst.args[0]);
        const r: Region = { root: a.root, lo: a.off, hi: a.off + widthOfSub(inst.sub) };
        for (const g of regionsToGuard) if (overlap(r, g)) return null; // a foreign access aliasing the tree — abort
        break;
      }
      case 'vload':
      case 'vstore': {
        const a = resolveAddr(inst.args[0]);
        const r: Region = { root: a.root, lo: a.off, hi: a.off + 16 };
        for (const g of regionsToGuard) if (overlap(r, g)) return null;
        break;
      }
      // print / gget / gset / alloc / pure ops don't read or write the arrays the
      // tree reorders (alloc's fresh region aliases nothing live), so they may sit
      // in the span freely.
      default:
        break;
    }
  }

  // The single vstore, appended after the value chain, at the last seed store's slot.
  emit.push({ res: null, ty: 'void', kind: 'vstore', sub: shape, args: [clone(seed[0].inst.args[0]), packed] });
  void laneIR;
  return { consumed, emit, atStore: lastStore };
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
