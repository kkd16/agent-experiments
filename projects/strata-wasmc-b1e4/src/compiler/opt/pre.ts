import type { Block, ConstNum, IRFunc, Inst, InstKind, IRType, Operand, Phi } from '../ir/ir';
import { eachOperand, isPureValue } from '../ir/ir';
import { computeDom, succOfTerm } from '../ir/cfg';

// =====================================================================
// GVN-PRE — partial-redundancy elimination over SSA
// =====================================================================
//
// The capstone of the redundancy-removal family. GVN/CSE deletes a computation
// that a *dominating* one already produced; LICM lifts a *fully* loop-invariant
// value out of a loop; hoisting pulls a value computed in *both* arms of a branch
// up above it. What none of them touch is the **partial** redundancy — an
// expression recomputed on a path where it was *already* computed on *some* (but
// not all) of the incoming paths:
//
//        B0: condbr c, T, F
//        T:  t = a + b   ;  print(t)        // a+b computed here …
//        F:  (nothing)
//        M:  z = a + b   ;  print(z)        // … recomputed here, redundant from T
//
// PRE makes the redundancy *full* and then deletes it: it inserts `a + b` on the
// edge that lacked it (F → M), so the value is available from every predecessor
// of M, then replaces `z`'s computation with a φ merging the two leaders. The
// recomputation on the T-path is gone; the F-path does the same work it would
// have at M — never more. This is the classic Knoop–Rüthing–Steffen lazy-code-
// motion result, cast in the value-based form of VanDrunen & Hosking's GVN-PRE
// (value numbers in place of lexical expressions, φ-translation across merges).
//
// The pipeline:
//   0. split critical edges (so every insertion point is a single-pred block);
//   1. value-number every SSA value (congruent expressions share a number);
//   2. AVAIL_OUT  — forward over the dominator tree: which values have a leader
//      (an SSA temp computing them) available at each block's exit;
//   3. ANTIC_IN   — backward to a fixpoint with φ-translation: which expressions
//      are *anticipated* (computed on every path forward) at each block's entry;
//   4. INSERT     — at each merge, for each anticipated expression available from
//      some-but-not-all predecessors, materialise it on the lacking edges and
//      build a φ that becomes the value's new leader at the merge;
//   5. ELIMINATE  — a value-number-aware dominator walk: replace any movable
//      computation whose value already has a dominating leader (the φ included).
//
// **Soundness.** Only *pure, never-trapping* value families move (no loads,
// stores, calls, `div_s`/`rem_s`, or trapping float→int casts), so an inserted
// computation can never invent a fault, a memory read, or a side effect. Every
// inserted op's operands must already have a leader on the target edge, so the
// new instruction needs nothing the edge can't see, and anticipation guarantees
// the value is used on every path out of the merge — the move is down-safe, never
// speculative onto a path that wouldn't compute it. As a belt-and-braces final
// check the pass re-verifies SSA dominance and, if anything is off, discards all
// of its work and reports zero changes — so a latent bug degrades to a no-op,
// never a miscompile. The differential oracle (interpreter = wasm = VM) proves
// the rest across thousands of seeded programs.

// --- value-number expressions -------------------------------------------------

type VExpr =
  | { t: 'const'; ty: IRType; num: ConstNum }
  | { t: 'leaf'; id: number } // param / φ / impure or non-movable def — not movable
  | { t: 'op'; kind: InstKind; sub: string; ty: IRType; ops: number[] };

// Same commutative set the existing GVN uses, so the two agree on congruence.
const COMMUTATIVE = new Set(['add', 'mul', 'and', 'or', 'xor', 'eq', 'ne']);

// A pure value family that never traps and may therefore be freely recomputed on
// another path. Excludes `copy` (an alias), `cast` (float→int truncations trap),
// and integer `div_s`/`rem_s` (divide-by-zero / INT_MIN÷-1 trap).
function isMovable(inst: Inst): boolean {
  if (inst.res === null || !isPureValue(inst)) return false;
  if (inst.kind === 'copy' || inst.kind === 'cast') return false;
  if (inst.kind === 'ibin' && (inst.sub === 'div_s' || inst.sub === 'rem_s')) return false;
  return true;
}

class ValueTable {
  next = 1;
  byKey = new Map<string, number>();
  expr = new Map<number, VExpr>();
  ofVal = new Map<number, number>(); // SSA value id -> value number

  private fresh(e: VExpr): number {
    const vn = this.next++;
    this.expr.set(vn, e);
    return vn;
  }

  constVN(ty: IRType, num: ConstNum): number {
    const key = `K|${ty}|${num}`;
    let vn = this.byKey.get(key);
    if (vn === undefined) {
      vn = this.fresh({ t: 'const', ty, num });
      this.byKey.set(key, vn);
    }
    return vn;
  }

  leafVN(id: number): number {
    const vn = this.fresh({ t: 'leaf', id });
    this.ofVal.set(id, vn);
    return vn;
  }

  // Intern `op(ops…)`; congruent expressions (same family/opcode/type/operands,
  // operands sorted for commutative ops) collapse to one number.
  opVN(kind: InstKind, sub: string, ty: IRType, ops: number[]): number {
    const canon = COMMUTATIVE.has(sub) && ops.length === 2 ? [...ops].sort((a, b) => a - b) : ops;
    const key = `${kind}|${sub}|${ty}|${canon.join(',')}`;
    let vn = this.byKey.get(key);
    if (vn === undefined) {
      vn = this.fresh({ t: 'op', kind, sub, ty, ops: canon });
      this.byKey.set(key, vn);
    }
    return vn;
  }

  vnOfOperand(o: Operand): number {
    if (o.tag === 'const') return this.constVN(o.ty, o.num);
    const vn = this.ofVal.get(o.id);
    return vn ?? this.leafVN(o.id); // params / not-yet-seen → opaque leaf
  }
}

// --- small CFG helpers --------------------------------------------------------

function recomputePreds(fn: IRFunc): void {
  const byId = new Map(fn.blocks.map((b) => [b.id, b]));
  for (const b of fn.blocks) b.preds = [];
  for (const b of fn.blocks) for (const s of succOfTerm(b.term)) byId.get(s)?.preds.push(b.id);
}

function redirectTerm(t: Block['term'], from: number, to: number): Block['term'] {
  if (t.op === 'br') return t.target === from ? { op: 'br', target: to } : t;
  if (t.op === 'condbr')
    return { op: 'condbr', cond: t.cond, t: t.t === from ? to : t.t, f: t.f === from ? to : t.f, span: t.span };
  return t;
}

// Split every critical edge u→v (u has >1 successor, v has >1 predecessor) with a
// fresh forwarding block. Afterwards a block either has one successor (whose
// φs we φ-translate through) or many successors that each have a single
// predecessor — exactly the shape PRE's insertion and anticipation rely on.
function splitCriticalEdges(fn: IRFunc, idCtr: { n: number }): void {
  recomputePreds(fn);
  let again = true;
  while (again) {
    again = false;
    const byId = new Map(fn.blocks.map((b) => [b.id, b]));
    for (const u of [...fn.blocks]) {
      const succs = succOfTerm(u.term);
      if (succs.length < 2) continue;
      for (const vId of new Set(succs)) {
        const v = byId.get(vId)!;
        if (v.preds.length < 2) continue;
        // critical edge u→v: insert w
        const w: Block = { id: idCtr.n++, phis: [], insts: [], term: { op: 'br', target: v.id }, preds: [u.id] };
        u.term = redirectTerm(u.term, v.id, w.id);
        v.preds = v.preds.map((p) => (p === u.id ? w.id : p));
        for (const phi of v.phis) for (const inc of phi.incomings) if (inc.pred === u.id) inc.pred = w.id;
        const vi = fn.blocks.indexOf(v);
        fn.blocks.splice(vi, 0, w);
        again = true;
        break;
      }
      if (again) break;
    }
  }
  recomputePreds(fn);
}

// --- transactional snapshot (restore on a failed self-check) ------------------

function snapshot(fn: IRFunc): { blocks: Block[]; valueType: Map<number, IRType> } {
  const cloneOp = (o: Operand): Operand => (o.tag === 'const' ? { ...o } : { tag: 'val', id: o.id });
  return {
    valueType: new Map(fn.valueType),
    blocks: fn.blocks.map((b) => ({
      id: b.id,
      preds: [...b.preds],
      phis: b.phis.map((p) => ({ res: p.res, ty: p.ty, incomings: p.incomings.map((i) => ({ pred: i.pred, val: cloneOp(i.val) })) })),
      insts: b.insts.map((i) => ({ res: i.res, ty: i.ty, kind: i.kind, sub: i.sub, args: i.args.map(cloneOp), span: i.span })),
      term:
        b.term.op === 'condbr'
          ? { op: 'condbr', cond: cloneOp(b.term.cond), t: b.term.t, f: b.term.f, span: b.term.span }
          : b.term.op === 'ret'
            ? { op: 'ret', value: b.term.value ? cloneOp(b.term.value) : null, span: b.term.span }
            : b.term.op === 'br'
              ? { op: 'br', target: b.term.target }
              : { op: 'unreachable' },
    })),
  };
}
function restore(fn: IRFunc, snap: { blocks: Block[]; valueType: Map<number, IRType> }): void {
  fn.blocks = snap.blocks;
  fn.valueType = snap.valueType;
}

// --- SSA dominance self-check -------------------------------------------------

function verifySSA(fn: IRFunc): boolean {
  const dom = computeDom(fn);
  const idom = dom.idom;
  // a dominates b?
  const dominates = (a: number, b: number): boolean => {
    let x: number | undefined = b;
    while (x !== undefined) {
      if (x === a) return true;
      const nx = idom.get(x);
      if (nx === x) break;
      x = nx;
    }
    return false;
  };
  // def site of every SSA value: block id + instruction index (phis at -1)
  const defBlock = new Map<number, number>();
  const defIndex = new Map<number, number>();
  for (const b of fn.blocks) {
    for (const p of b.phis) {
      defBlock.set(p.res, b.id);
      defIndex.set(p.res, -1);
    }
    b.insts.forEach((i, k) => {
      if (i.res !== null) {
        defBlock.set(i.res, b.id);
        defIndex.set(i.res, k);
      }
    });
  }
  // params (and anything used but never defined) count as defined at entry
  const definedAtEntry = (id: number): boolean => !defBlock.has(id);
  let ok = true;
  for (const b of fn.blocks) {
    if (!dom.rpoIndex.has(b.id)) continue; // unreachable; codegen drops it
    // φ incomings: value must be available at the end of its predecessor edge
    for (const phi of b.phis) {
      for (const inc of phi.incomings) {
        if (inc.val.tag !== 'val') continue;
        const v = inc.val.id;
        if (definedAtEntry(v)) continue;
        if (!dominates(defBlock.get(v)!, inc.pred)) ok = false;
      }
    }
    // ordinary uses: def must dominate the use (and precede it within a block)
    b.insts.forEach((inst, k) => {
      for (const o of inst.args) {
        if (o.tag !== 'val' || definedAtEntry(o.id)) continue;
        const db = defBlock.get(o.id)!;
        if (db === b.id) {
          if ((defIndex.get(o.id) ?? -1) >= k) ok = false;
        } else if (!dominates(db, b.id)) ok = false;
      }
    });
    const termOps: Operand[] = b.term.op === 'condbr' ? [b.term.cond] : b.term.op === 'ret' && b.term.value ? [b.term.value] : [];
    for (const o of termOps) {
      if (o.tag !== 'val' || definedAtEntry(o.id)) continue;
      const db = defBlock.get(o.id)!;
      if (db !== b.id && !dominates(db, b.id)) ok = false;
    }
  }
  return ok;
}

// --- the pass ----------------------------------------------------------------

export function pre(fn: IRFunc): number {
  recomputePreds(fn);
  // Nothing to do without a merge point (two paths joining) — that's where a
  // partial redundancy can live.
  if (!fn.blocks.some((b) => b.preds.length >= 2)) return 0;

  const snap = snapshot(fn);
  const idCtr = { n: 0 };
  for (const k of fn.valueType.keys()) if (k >= idCtr.n) idCtr.n = k + 1;
  for (const b of fn.blocks) {
    if (b.id >= idCtr.n) idCtr.n = b.id + 1;
    for (const p of b.phis) if (p.res >= idCtr.n) idCtr.n = p.res + 1;
    for (const i of b.insts) if (i.res !== null && i.res >= idCtr.n) idCtr.n = i.res + 1;
  }

  splitCriticalEdges(fn, idCtr);

  const dom = computeDom(fn);
  const byId = new Map(fn.blocks.map((b) => [b.id, b]));
  // Only operate over reachable blocks, in dominator/RPO order.
  const rpo = dom.rpo;
  const rpoSet = new Set(rpo);

  // === Phase 1: value numbering ===============================================
  const vt = new ValueTable();
  // Each value generated in a block, in program order, with its leader temp.
  const genList = new Map<number, { vn: number; leader: number }[]>();
  // φ value-numbers per block (used by φ-translation to recognise merge φs).
  const phiVNToPhi = new Map<number, Phi>();
  const phiVNBlock = new Map<number, number>();
  for (const id of rpo) genList.set(id, []);

  for (const id of rpo) {
    const b = byId.get(id)!;
    const gens = genList.get(id)!;
    for (const phi of b.phis) {
      const vn = vt.leafVN(phi.res); // a φ is its own (opaque) value
      phiVNToPhi.set(vn, phi);
      phiVNBlock.set(vn, id);
      gens.push({ vn, leader: phi.res });
    }
    for (const inst of b.insts) {
      if (inst.res === null) continue;
      if (inst.kind === 'copy') {
        // a copy is an alias: it shares its source's value number, no new leader
        vt.ofVal.set(inst.res, vt.vnOfOperand(inst.args[0]));
        continue;
      }
      let vn: number;
      if (isMovable(inst)) {
        vn = vt.opVN(inst.kind, inst.sub, inst.ty as IRType, inst.args.map((o) => vt.vnOfOperand(o)));
        vt.ofVal.set(inst.res, vn);
      } else {
        vn = vt.leafVN(inst.res); // load / call / div / cast … opaque, not movable
      }
      gens.push({ vn, leader: inst.res });
    }
  }

  // === Phase 2: AVAIL_OUT (and AVAIL_IN) over the dominator tree ==============
  // availOut[b]: value-number -> an SSA operand computing it, available at b's exit.
  const availOut = new Map<number, Map<number, Operand>>();
  const availInOf = (id: number): Map<number, Operand> => {
    const d = dom.idom.get(id);
    return d === undefined || d === id ? new Map() : availOut.get(d) ?? new Map();
  };
  for (const id of rpo) {
    const m = new Map(availInOf(id));
    for (const g of genList.get(id)!) if (!m.has(g.vn)) m.set(g.vn, { tag: 'val', id: g.leader });
    availOut.set(id, m);
  }

  // leader of a value at a program point given an avail map (consts are universal)
  const leaderIn = (avail: Map<number, Operand>, vn: number): Operand | null => {
    const e = vt.expr.get(vn);
    if (e && e.t === 'const') return { tag: 'const', ty: e.ty, num: e.num };
    return avail.get(vn) ?? null;
  };
  const availableAtEntry = (id: number, vn: number): boolean => {
    const e = vt.expr.get(vn);
    if (e && e.t === 'const') return true;
    return availInOf(id).has(vn);
  };

  // === Phase 3: ANTIC_IN (backward, φ-translated, to a fixpoint) ==============
  // Sets hold only movable op value-numbers (the things we might insert).
  const expGen = new Map<number, number[]>(); // movable ops generated in b, in order
  for (const id of rpo) {
    const list: number[] = [];
    const seen = new Set<number>();
    for (const g of genList.get(id)!) {
      const e = vt.expr.get(g.vn);
      if (e && e.t === 'op' && !seen.has(g.vn)) {
        seen.add(g.vn);
        list.push(g.vn);
      }
    }
    expGen.set(id, list);
  }

  // φ-translate a value number from block `from` to successor `to`: rewrite any
  // operand that is a φ of `to` to the value flowing in along the `from` edge.
  const translateCache = new Map<string, number>();
  const translate = (vn: number, from: number, to: number): number => {
    const ck = `${vn}@${from}->${to}`;
    const hit = translateCache.get(ck);
    if (hit !== undefined) return hit;
    const e = vt.expr.get(vn);
    let res = vn;
    if (e) {
      if (e.t === 'leaf' && phiVNBlock.get(vn) === to) {
        const phi = phiVNToPhi.get(vn)!;
        const inc = phi.incomings.find((i) => i.pred === from);
        res = inc ? vt.vnOfOperand(inc.val) : vn;
      } else if (e.t === 'op') {
        const newOps = e.ops.map((o) => translate(o, from, to));
        res = newOps.every((o, i) => o === e.ops[i]) ? vn : vt.opVN(e.kind, e.sub, e.ty, newOps);
      }
    }
    translateCache.set(ck, res);
    return res;
  };

  const anticIn = new Map<number, Set<number>>();
  for (const id of rpo) anticIn.set(id, new Set());

  // `clean`: keep an op only if every operand is a const, available at entry, or
  // itself a kept op in the set (so the whole thing is computable at b's entry).
  const clean = (id: number, set: Set<number>): Set<number> => {
    let changed = true;
    while (changed) {
      changed = false;
      for (const vn of [...set]) {
        const e = vt.expr.get(vn);
        if (!e || e.t !== 'op') continue;
        for (const o of e.ops) {
          if (!availableAtEntry(id, o) && !set.has(o)) {
            set.delete(vn);
            changed = true;
            break;
          }
        }
      }
    }
    return set;
  };

  const order = [...rpo].reverse(); // process near-exit blocks first
  let pass = true;
  let guard = 0;
  while (pass && guard++ < 100) {
    pass = false;
    for (const id of order) {
      const b = byId.get(id)!;
      const succs = succOfTerm(b.term).filter((s) => rpoSet.has(s));
      const out = new Set<number>();
      if (succs.length === 1) {
        for (const vn of anticIn.get(succs[0])!) out.add(translate(vn, id, succs[0]));
      } else if (succs.length > 1) {
        // after edge-splitting, these successors have a single predecessor (this
        // block) — no φs to translate, so a plain value-wise intersection holds.
        const sets = succs.map((s) => anticIn.get(s)!);
        for (const vn of sets[0]) if (sets.every((s) => s.has(vn))) out.add(vn);
      }
      const incoming = new Set<number>(expGen.get(id)!);
      for (const vn of out) incoming.add(vn);
      const cleaned = clean(id, incoming);
      const prev = anticIn.get(id)!;
      if (cleaned.size !== prev.size || [...cleaned].some((v) => !prev.has(v))) {
        anticIn.set(id, cleaned);
        pass = true;
      }
    }
  }

  // === Phase 4: INSERT ========================================================
  let inserted = 0;
  // The merge blocks, processed in RPO so an inserted φ is available to dominated
  // merges within the same insertion sweep.
  const merges = rpo.map((id) => byId.get(id)!).filter((b) => b.preds.filter((p) => rpoSet.has(p)).length >= 2);
  for (let sweep = 0; sweep < 3; sweep++) {
    let did = false;
    for (const b of merges) {
      const preds = b.preds.filter((p) => rpoSet.has(p));
      const availEntry = new Map(availInOf(b.id)); // what reaches the merge *before* its own body
      for (const vn of [...anticIn.get(b.id)!]) {
        const e = vt.expr.get(vn);
        if (!e || e.t !== 'op') continue;
        if (availEntry.has(vn)) continue; // already available from a dominator (GVN's job)
        // per-predecessor leader of this expression (φ-translated to the edge)
        const predLeader: (Operand | null)[] = [];
        let someAvail = false;
        let someMissing = false;
        const tvns: number[] = [];
        for (const p of preds) {
          const tvn = translate(vn, p, b.id);
          tvns.push(tvn);
          const l = leaderIn(availOut.get(p)!, tvn);
          predLeader.push(l);
          if (l) someAvail = true;
          else someMissing = true;
        }
        if (!someAvail || !someMissing) continue; // not a partial redundancy
        // We will insert on the missing edges. First make sure each insertion is
        // possible: every operand of the translated expression must already have a
        // leader at that predecessor (conservative — otherwise we decline).
        const plans: ({ kind: InstKind; sub: string; ty: IRType; args: Operand[] } | null)[] = [];
        let feasible = true;
        for (let i = 0; i < preds.length; i++) {
          if (predLeader[i]) {
            plans.push(null);
            continue;
          }
          const te = vt.expr.get(tvns[i]);
          if (!te || te.t !== 'op') {
            feasible = false;
            break;
          }
          const pav = availOut.get(preds[i])!;
          const args = te.ops.map((o) => leaderIn(pav, o));
          if (args.some((a) => a === null)) {
            feasible = false;
            break;
          }
          plans.push({ kind: te.kind, sub: te.sub, ty: te.ty, args: args as Operand[] });
        }
        if (!feasible) continue;
        // Materialise on each missing edge and record its leader.
        for (let i = 0; i < preds.length; i++) {
          const plan = plans[i];
          if (!plan) continue;
          const pb = byId.get(preds[i])!;
          const id = idCtr.n++;
          const inst: Inst = { res: id, ty: plan.ty, kind: plan.kind, sub: plan.sub, args: plan.args };
          pb.insts.push(inst);
          fn.valueType.set(id, plan.ty);
          vt.ofVal.set(id, tvns[i]);
          availOut.get(preds[i])!.set(tvns[i], { tag: 'val', id });
          predLeader[i] = { tag: 'val', id };
        }
        // Build the φ that fuses the per-edge leaders into this value at the merge.
        const phiRes = idCtr.n++;
        const phi: Phi = {
          res: phiRes,
          ty: e.ty,
          incomings: preds.map((p, i) => ({ pred: p, val: predLeader[i]! })),
        };
        b.phis.push(phi);
        fn.valueType.set(phiRes, e.ty);
        vt.ofVal.set(phiRes, vn); // the φ now *is* this expression's value
        phiVNToPhi.set(vn, phi);
        phiVNBlock.set(vn, b.id);
        availEntry.set(vn, { tag: 'val', id: phiRes }); // available at entry for further exprs this sweep
        availOut.get(b.id)!.set(vn, { tag: 'val', id: phiRes }); // and to dominated merges
        inserted++;
        did = true;
      }
    }
    if (!did) break;
  }

  // === Phase 5: ELIMINATE (value-number-aware dominator GVN) ===================
  let removed = 0;
  const dom2 = computeDom(fn);
  const byId2 = new Map(fn.blocks.map((b) => [b.id, b]));
  const replaceAllUses = (fromId: number, to: Operand): void => {
    for (const b of fn.blocks)
      eachOperand(b, (o, set) => {
        if (o.tag === 'val' && o.id === fromId) set(to.tag === 'const' ? { tag: 'const', ty: to.ty, num: to.num } : { tag: 'val', id: to.id });
      });
  };
  const table = new Map<number, Operand>();
  const walk = (id: number): void => {
    const b = byId2.get(id)!;
    const added: number[] = [];
    const note = (vn: number, op: Operand): void => {
      if (!table.has(vn)) {
        table.set(vn, op);
        added.push(vn);
      }
    };
    for (const phi of b.phis) {
      const vn = vt.ofVal.get(phi.res);
      if (vn !== undefined) note(vn, { tag: 'val', id: phi.res });
    }
    const keep: Inst[] = [];
    for (const inst of b.insts) {
      if (inst.res !== null && isMovable(inst)) {
        const vn = vt.ofVal.get(inst.res);
        const lead = vn !== undefined ? table.get(vn) : undefined;
        if (lead && !(lead.tag === 'val' && lead.id === inst.res)) {
          replaceAllUses(inst.res, lead);
          removed++;
          continue; // drop the now-redundant computation
        }
        if (vn !== undefined) note(vn, { tag: 'val', id: inst.res });
      } else if (inst.res !== null) {
        const vn = vt.ofVal.get(inst.res);
        if (vn !== undefined) note(vn, { tag: 'val', id: inst.res });
      }
      keep.push(inst);
    }
    b.insts = keep;
    for (const c of dom2.domChildren.get(id) ?? []) walk(c);
    for (const vn of added) table.delete(vn);
  };
  walk(fn.entry);

  // Nothing profitable — undo the edge splits so PRE is a true no-op when it
  // finds no partial redundancy (keeps the CFG free of stray forwarder blocks).
  if (inserted + removed === 0) {
    restore(fn, snap);
    return 0;
  }
  // === self-check: if anything is structurally off, discard all of it =========
  if (!verifySSA(fn)) {
    restore(fn, snap);
    return 0;
  }
  recomputePreds(fn);
  return inserted + removed;
}
