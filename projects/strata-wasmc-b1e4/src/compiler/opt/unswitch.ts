import type { Block, IRFunc, IRType, Operand, Term } from '../ir/ir';
import { eachOperand } from '../ir/ir';
import { computeDom, succOfTerm } from '../ir/cfg';
import { findNaturalLoops } from '../ir/loops';
import type { NaturalLoop } from '../ir/loops';
import { getPreheader, maxValueId } from './optimize';

// Loop unswitching — hoist a loop-invariant branch out of a loop.
//
// When a loop body contains a conditional `if (C) … else …` whose condition `C`
// is *loop-invariant* (its single SSA definition lies outside the loop, so it
// takes the same value on every iteration), testing `C` once per iteration is
// pure waste: the branch always goes the same way. Unswitching turns the loop
// inside-out — the test moves *above* the loop, and the loop is cloned into two
// specialized versions:
//
//     preheader:                      preheader:
//       br loop                          condbr(C, loopᵀ, loopᶠ)
//     loop:                  ==>      loopᵀ:  … (every `if (C)` → its then-arm)
//       …                            loopᶠ:  … (every `if (C)` → its else-arm)
//       if (C) A else B
//       …
//
// Each clone specializes *every* in-loop branch on `C` to the side it must take,
// so the now-constant branches — and, after the following DCE/CFG-simplify
// rounds, the dead arm of each — vanish, leaving two tight, branch-free loops.
//
// Soundness is by precondition, the house way. The transform fires only on the
// structured-loop shape the unroller also demands — a single preheader, and a
// header conditional that is the loop's *one* exit (every other body edge stays
// in the body) — so the only edge leaving the loop is `header → exit`. That makes
// the SSA repair exact: every value that escapes the loop is defined in the
// header block, so each clone's copy is merged back at the single exit with a
// fresh φ. When any precondition is unmet the pass declines and leaves the IR
// untouched, so a bug can only ever miss an opportunity — never change behaviour,
// as the differential oracle (interpreter ≡ wasm ≡ from-scratch VM) proves.

const MAX_BODY_INSTS = 400; // cap per-loop code duplication
const MAX_BODY_BLOCKS = 60;
const MAX_UNSWITCH = 8; // bound total growth per function (k flags ⇒ ≤k clones)

const clone = (o: Operand): Operand =>
  o.tag === 'const' ? { tag: 'const', ty: o.ty, num: o.num } : { tag: 'val', id: o.id };

export function unswitchLoops(fn: IRFunc): number {
  let changed = 0;
  // One loop per step (the CFG changes under us); re-discover after each. The cap
  // bounds work on pathological inputs — real programs have very few loops.
  for (let i = 0; i < MAX_UNSWITCH; i++) {
    if (!unswitchOne(fn)) break;
    changed++;
  }
  return changed;
}

function unswitchOne(fn: IRFunc): boolean {
  pruneUnreachable(fn); // keep the CFG clean so dead arms from a prior pass don't pollute loop bodies
  const dom = computeDom(fn);
  const loops = findNaturalLoops(fn, dom);
  for (const loop of loops) {
    if (tryUnswitch(fn, loop)) return true;
  }
  return false;
}

function tryUnswitch(fn: IRFunc, loop: NaturalLoop): boolean {
  let byId = new Map(fn.blocks.map((b) => [b.id, b]));
  const body = loop.body;
  const H = byId.get(loop.header);
  if (!H) return false;

  // --- cost: bound the duplication ------------------------------------
  if (body.size > MAX_BODY_BLOCKS) return false;
  let bodyInsts = 0;
  for (const bid of body) bodyInsts += byId.get(bid)!.insts.length;
  if (bodyInsts > MAX_BODY_INSTS) return false;

  // --- the header must be the loop's single, conditional exit ----------
  // (one successor inside the body — the entry — and one outside — the exit).
  if (H.term.op !== 'condbr' || H.term.t === H.term.f) return false;
  const tT = H.term.t;
  const fT = H.term.f;
  let bodyEntry: number;
  let exitTarget: number;
  if (body.has(tT) && !body.has(fT)) {
    bodyEntry = tT;
    exitTarget = fT;
  } else if (body.has(fT) && !body.has(tT)) {
    bodyEntry = fT;
    exitTarget = tT;
  } else {
    return false;
  }
  if (bodyEntry === H.id || exitTarget === H.id) return false;

  // Single exit + single entry: every non-header body block keeps all of its
  // successors and predecessors inside the body. So the only loop-leaving edge
  // is the header's exit, and nothing jumps into the body from outside.
  for (const bid of body) {
    if (bid === H.id) continue;
    const b = byId.get(bid)!;
    for (const s of succOfTerm(b.term)) if (!body.has(s)) return false;
    for (const p of b.preds) if (!body.has(p)) return false;
  }
  // The exit must not also be an entry edge (a self-tangled loop); declining
  // here keeps the preheader we are about to build distinct from the exit.
  const outsidePreds = H.preds.filter((p) => !body.has(p));
  if (outsidePreds.includes(exitTarget)) return false;

  // --- classify the loop's value definitions ---------------------------
  const bodyDefs = new Set<number>();
  const headerDefs = new Set<number>(); // values defined in the header block
  for (const bid of body) {
    const b = byId.get(bid)!;
    for (const p of b.phis) {
      bodyDefs.add(p.res);
      if (bid === H.id) headerDefs.add(p.res);
    }
    for (const ins of b.insts)
      if (ins.res !== null) {
        bodyDefs.add(ins.res);
        if (bid === H.id) headerDefs.add(ins.res);
      }
  }

  // --- find a loop-invariant branch to unswitch on ---------------------
  // A non-header body block ending in `condbr(C, …)` where `C`'s single SSA
  // definition is outside the loop (so it is constant across iterations). A
  // constant `C` is left to SCCP; we want a genuine runtime flag.
  let C: number | null = null;
  for (const bid of body) {
    if (bid === H.id) continue;
    const b = byId.get(bid)!;
    if (b.term.op !== 'condbr' || b.term.t === b.term.f) continue;
    const cond = b.term.cond;
    if (cond.tag !== 'val' || bodyDefs.has(cond.id)) continue;
    C = cond.id;
    break;
  }
  if (C === null) return false;

  // Every value that escapes the loop (a body def used outside the body) must be
  // defined in the header — guaranteed by the single-exit-from-header shape, but
  // verified so the merge below is exhaustive. (Values defined deeper in the body
  // are not live on the header's exit edge, so valid SSA never lets them escape.)
  for (const b of fn.blocks) {
    if (body.has(b.id)) continue;
    let bad = false;
    eachOperand(b, (o) => {
      if (o.tag === 'val' && bodyDefs.has(o.id) && !headerDefs.has(o.id)) bad = true;
    });
    if (bad) return false;
  }

  // ====================================================================
  // Transform.
  // ====================================================================
  // A single fresh-id counter past every existing block and value id, shared by
  // the preheader builder and both clones (so no id ever collides).
  const idCtr = { n: Math.max(maxValueId(fn), maxBlockId(fn)) + 1 };
  const PH = getPreheader(fn, H, body, idCtr);
  if (!PH) return false;

  // getPreheader spliced a block in and rewired the header's phis; re-read.
  recomputePreds(fn);
  byId = new Map(fn.blocks.map((b) => [b.id, b]));
  const bodyArr = [...body].map((id) => byId.get(id)!);

  // Build one specialized clone of the whole body. `takeTrue` decides which side
  // every `condbr(C, t, f)` collapses to: the then-arm (`t`) when C is assumed
  // true, the else-arm (`f`) when assumed false.
  const buildClone = (takeTrue: boolean) => {
    const blockMap = new Map<number, number>();
    for (const b of bodyArr) blockMap.set(b.id, idCtr.n++);
    const valMap = new Map<number, Operand>();
    for (const b of bodyArr) {
      for (const p of b.phis) {
        const id = idCtr.n++;
        fn.valueType.set(id, p.ty);
        valMap.set(p.res, { tag: 'val', id });
      }
      for (const ins of b.insts)
        if (ins.res !== null) {
          const id = idCtr.n++;
          fn.valueType.set(id, ins.ty as IRType);
          valMap.set(ins.res, { tag: 'val', id });
        }
    }
    // A body target maps to its clone; the lone outside target (the exit) stays.
    const mapTarget = (s: number): number => (blockMap.has(s) ? blockMap.get(s)! : s);
    const blocks: Block[] = [];
    for (const ob of bodyArr) {
      const nb: Block = { id: blockMap.get(ob.id)!, phis: [], insts: [], term: { op: 'unreachable' }, preds: [] };
      for (const p of ob.phis) {
        nb.phis.push({
          res: (valMap.get(p.res) as { tag: 'val'; id: number }).id,
          ty: p.ty,
          // The preheader incoming keeps `pred = PH` (PH is outside the body, so
          // not in blockMap); back-edge incomings remap to the clone's latch.
          incomings: p.incomings.map((inc) => ({
            pred: blockMap.has(inc.pred) ? blockMap.get(inc.pred)! : inc.pred,
            val: remap(valMap, inc.val),
          })),
        });
      }
      for (const ins of ob.insts) {
        nb.insts.push({
          res: ins.res === null ? null : (valMap.get(ins.res) as { tag: 'val'; id: number }).id,
          ty: ins.ty,
          kind: ins.kind,
          sub: ins.sub,
          args: ins.args.map((a) => remap(valMap, a)),
        });
      }
      // Specialize every in-loop branch on C (never the header's own exit test).
      if (ob.id !== H.id && ob.term.op === 'condbr' && ob.term.cond.tag === 'val' && ob.term.cond.id === C) {
        const taken = takeTrue ? ob.term.t : ob.term.f;
        nb.term = { op: 'br', target: mapTarget(taken) };
      } else {
        nb.term = mapTerm(ob.term, mapTarget, valMap);
      }
      blocks.push(nb);
    }
    return { headerId: blockMap.get(H.id)!, valMap, blocks };
  };

  const T = buildClone(true);
  const F = buildClone(false);

  // Hoist the test: the preheader now picks the specialized loop on C. C is
  // loop-invariant, hence defined outside the body, hence dominates the
  // preheader — so it is available here.
  PH.term = { op: 'condbr', cond: { tag: 'val', id: C }, t: T.headerId, f: F.headerId };

  // --- repair SSA at the single exit -----------------------------------
  const X = byId.get(exitTarget)!;
  // (1) Every exit-φ incoming that came from the original header now arrives from
  //     *both* clone headers, each carrying that clone's copy of the value.
  for (const phi of X.phis) {
    const fixed: typeof phi.incomings = [];
    for (const inc of phi.incomings) {
      if (inc.pred === H.id) {
        fixed.push({ pred: T.headerId, val: remap(T.valMap, inc.val) });
        fixed.push({ pred: F.headerId, val: remap(F.valMap, inc.val) });
      } else {
        fixed.push(inc);
      }
    }
    phi.incomings = fixed;
  }
  // (2) Header values used *directly* after the loop (not through an exit φ) are
  //     merged with a fresh φ in the exit (which dominates every such use).
  const escaping = new Set<number>();
  for (const b of fn.blocks) {
    if (body.has(b.id)) continue;
    eachOperand(b, (o) => {
      if (o.tag === 'val' && headerDefs.has(o.id)) escaping.add(o.id);
    });
  }
  const mergeOf = new Map<number, Operand>();
  for (const vid of escaping) {
    const ty = fn.valueType.get(vid)!;
    const mid = idCtr.n++;
    fn.valueType.set(mid, ty);
    X.phis.push({
      res: mid,
      ty,
      incomings: [
        { pred: T.headerId, val: remap(T.valMap, { tag: 'val', id: vid }) },
        { pred: F.headerId, val: remap(F.valMap, { tag: 'val', id: vid }) },
      ],
    });
    mergeOf.set(vid, { tag: 'val', id: mid });
  }
  for (const b of fn.blocks) {
    if (body.has(b.id)) continue;
    eachOperand(b, (o, set) => {
      const m = o.tag === 'val' ? mergeOf.get(o.id) : undefined;
      if (m) set(clone(m));
    });
  }

  // Swap the original body out for the two clones.
  fn.blocks = fn.blocks.filter((b) => !body.has(b.id));
  fn.blocks.push(...T.blocks, ...F.blocks);
  recomputePreds(fn);
  return true;
}

// --- helpers ---------------------------------------------------------------

function remap(valMap: Map<number, Operand>, op: Operand): Operand {
  if (op.tag === 'const') return clone(op);
  const m = valMap.get(op.id);
  return m ? clone(m) : clone(op);
}

function mapTerm(t: Term, mapTarget: (s: number) => number, valMap: Map<number, Operand>): Term {
  if (t.op === 'br') return { op: 'br', target: mapTarget(t.target) };
  if (t.op === 'condbr') return { op: 'condbr', cond: remap(valMap, t.cond), t: mapTarget(t.t), f: mapTarget(t.f) };
  if (t.op === 'ret') return { op: 'ret', value: t.value ? remap(valMap, t.value) : null };
  return { op: 'unreachable' };
}

function recomputePreds(fn: IRFunc): void {
  const byId = new Map(fn.blocks.map((b) => [b.id, b]));
  for (const b of fn.blocks) b.preds = [];
  for (const b of fn.blocks) for (const s of succOfTerm(b.term)) byId.get(s)?.preds.push(b.id);
}

/** Drop blocks unreachable from the entry and prune φ incomings from dead preds. */
function pruneUnreachable(fn: IRFunc): void {
  const byId = new Map(fn.blocks.map((b) => [b.id, b]));
  const reach = new Set<number>();
  const stack = [fn.entry];
  while (stack.length) {
    const id = stack.pop()!;
    if (reach.has(id)) continue;
    reach.add(id);
    for (const s of succOfTerm(byId.get(id)!.term)) stack.push(s);
  }
  if (reach.size === fn.blocks.length) return; // nothing dead — leave the IR alone
  fn.blocks = fn.blocks.filter((b) => reach.has(b.id));
  for (const b of fn.blocks) for (const p of b.phis) p.incomings = p.incomings.filter((inc) => reach.has(inc.pred));
  recomputePreds(fn);
}

function maxBlockId(fn: IRFunc): number {
  let m = 0;
  for (const b of fn.blocks) if (b.id > m) m = b.id;
  return m;
}
