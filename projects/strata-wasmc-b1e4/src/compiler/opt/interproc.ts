import type { PBlock, PFunc, PInst, PModule, POperand } from '../ir/builder';
import type { ConstNum, IRType } from '../ir/ir';

// Interprocedural optimization, performed on the *pre-SSA* CFG (before ssa.ts),
// right after inlining. Where the rest of the optimizer reasons about one function
// at a time, this pass reasons across the whole call graph — the first mid-end
// transform whose input is *every* call site of a function at once. Four classic
// interprocedural transforms, all sound by construction and all proven correct by
// the differential oracle (the compiled wasm must print exactly what the reference
// interpreter does at every optimization level):
//
//   1. Interprocedural constant-argument propagation (IPCP). A parameter that is
//      passed the *same constant* at every call site of a function is a constant
//      inside that function's body. We bind it to that constant at entry, exposing
//      it to the whole downstream optimizer (SCCP/GVN/DCE/LICM/…).
//
//   2. Dead-argument elimination. Once a parameter is a module-wide constant *and*
//      the function is not externally reachable (not exported, address never taken),
//      *every* caller is known and passes that same literal — so the argument is pure
//      dead weight. Drop it from the signature and from every call site.
//
//   3. Function specialization / cloning (IPA-CP). When a parameter is constant at
//      *some but not all* call sites, clone the callee and redirect the constant
//      sites to the clone. The clone's callers now all pass that constant, so
//      transforms (1)+(2) fire on it — a copy of the function specialized to the
//      constant, while the original still serves the varying sites.
//
//   4. Interprocedural return-constant folding. A side-effect-free, terminating
//      function whose every `return` yields the *same* literal is a constant: replace
//      each call to it with that literal outright (the call, being pure, vanishes).
//
// Working pre-SSA keeps every rewrite a local edit — parameters and locals are still
// plain named vars, a call site is one instruction, and a bound constant is just a
// `copy` at the entry block. SSA construction then threads whatever phi nodes the
// exposed constants need, for free.

const MAX_SPEC_CALLEE_INSTS = 80; // never clone a function larger than this
const MAX_SPEC_PARAMS_PER_FN = 2; // at most this many specializations per callee
const GLOBAL_CLONE_BUDGET = 40; // hard cap on clones created per compilation

export interface InterprocStats {
  retConsts: number; // pure constant-returning calls replaced by their literal
  specialized: number; // specialization clones created
  redirected: number; // call sites redirected to a specialized clone
  constArgs: number; // parameters bound to a module-wide constant
  deadArgs: number; // parameters removed from a (fully-known-caller) signature
}

function funcInstCount(fn: PFunc): number {
  let n = 0;
  for (const b of fn.blocks) n += b.insts.length;
  return n;
}

/** Names of functions that can transitively reach themselves (self/mutual recursion). */
function recursiveFunctions(pm: PModule): Set<string> {
  const calls = new Map<string, Set<string>>();
  for (const fn of pm.funcs) {
    const s = new Set<string>();
    for (const b of fn.blocks) for (const i of b.insts) if (i.kind === 'call') s.add(i.sub);
    calls.set(fn.name, s);
  }
  const recursive = new Set<string>();
  for (const fn of pm.funcs) {
    const seen = new Set<string>();
    const stack = [...(calls.get(fn.name) ?? [])];
    let hit = false;
    while (stack.length) {
      const g = stack.pop()!;
      if (g === fn.name) { hit = true; break; }
      if (seen.has(g)) continue;
      seen.add(g);
      for (const h of calls.get(g) ?? []) stack.push(h);
    }
    if (hit) recursive.add(fn.name);
  }
  return recursive;
}

/** Every function whose address is materialized (`funcaddr`) — reachable indirectly. */
function addressTakenFunctions(pm: PModule): Set<string> {
  const taken = new Set<string>();
  for (const fn of pm.funcs) for (const b of fn.blocks) for (const i of b.insts) if (i.kind === 'funcaddr') taken.add(i.sub);
  return taken;
}

/** A const operand's identity, stable across the number/bigint split (`Object.is`
 *  distinguishes ±0 and pins NaN, so grouping never merges genuinely distinct
 *  constants). Only `const` operands have an identity; a `var` argument is unknown. */
function constKey(o: POperand): string | null {
  if (o.tag !== 'const') return null;
  // `Object.is` keeps -0 ≠ +0 and NaN = NaN; the type guards number-vs-bigint.
  return `${o.ty}#${Object.is(o.num, -0) ? '-0' : String(o.num)}`;
}

interface CallSite {
  fn: PFunc; // the caller
  inst: PInst; // the `call` instruction itself (by reference — index-shift-proof)
}

/** All direct-call sites in the module, grouped by callee name. Sites are held by
 *  instruction *reference*, so a later entry-block `unshift` (which renumbers indices)
 *  can never make a recorded site alias the wrong instruction. */
function collectCallSites(pm: PModule): Map<string, CallSite[]> {
  const sites = new Map<string, CallSite[]>();
  for (const fn of pm.funcs) {
    for (const b of fn.blocks) {
      for (const inst of b.insts) {
        if (inst.kind !== 'call') continue;
        const list = sites.get(inst.sub) ?? [];
        list.push({ fn, inst });
        sites.set(inst.sub, list);
      }
    }
  }
  return sites;
}

function constOperand(ty: IRType, num: ConstNum): POperand {
  return { tag: 'const', ty, num };
}

/** Prepend `name := const` to a function's entry block, defining the param as a
 *  constant for the whole body (pre-SSA reassignment keeps later writes correct). */
function bindParamConst(fn: PFunc, name: string, ty: IRType, num: ConstNum): void {
  const entry = fn.blocks.find((b) => b.id === fn.entry);
  if (!entry) return;
  fn.varType.set(name, ty);
  const copy: PInst = { dest: name, ty, kind: 'copy', sub: '', args: [constOperand(ty, num)] };
  entry.insts.unshift(copy);
}

// ---------------------------------------------------------------------------
// (4) Return-constant folding: a pure, terminating, always-same-literal function
// ---------------------------------------------------------------------------

const SIDE_EFFECT_KINDS = new Set<string>([
  'print', 'gset', 'store', 'vstore', 'call', 'callind', 'alloc', 'load', 'gget', 'vload',
]);

/** Does the function's CFG contain a back edge (a cycle ⇒ may not terminate)? */
function hasCycle(fn: PFunc): boolean {
  const byId = new Map(fn.blocks.map((b) => [b.id, b]));
  const state = new Map<number, number>(); // 0=unvisited,1=on-stack,2=done
  const succ = (b: PBlock): number[] => {
    const t = b.term;
    if (!t) return [];
    if (t.op === 'br') return [t.target];
    if (t.op === 'condbr') return [t.t, t.f];
    return [];
  };
  const dfs = (id: number): boolean => {
    state.set(id, 1);
    const b = byId.get(id);
    if (b) {
      for (const s of succ(b)) {
        const st = state.get(s) ?? 0;
        if (st === 1) return true; // back edge
        if (st === 0 && dfs(s)) return true;
      }
    }
    state.set(id, 2);
    return false;
  };
  return dfs(fn.entry);
}

/** If `fn` is side-effect-free, guaranteed to terminate (acyclic, callee-free) and
 *  every `ret` yields the *same* constant literal, return that constant. */
function constantReturn(fn: PFunc): POperand | null {
  if (fn.retTy === 'void') return null;
  let ret: POperand | null = null;
  for (const b of fn.blocks) {
    for (const inst of b.insts) if (SIDE_EFFECT_KINDS.has(inst.kind)) return null;
    const t = b.term;
    if (t && t.op === 'ret') {
      if (t.value === null || t.value.tag !== 'const') return null;
      const k = constKey(t.value);
      if (ret === null) ret = t.value;
      else if (constKey(ret) !== k) return null;
    }
  }
  if (ret === null) return null;
  if (hasCycle(fn)) return null; // a loop could diverge; folding it away is unsound
  return ret;
}

// ---------------------------------------------------------------------------
// (3) Specialization: clone a callee with a subset of sites' constant arg
// ---------------------------------------------------------------------------

function cloneBlock(b: PBlock): PBlock {
  return {
    id: b.id,
    insts: b.insts.map((i) => ({ dest: i.dest, ty: i.ty, kind: i.kind, sub: i.sub, args: i.args.map((o) => ({ ...o })), span: i.span })),
    term: b.term ? { ...b.term } : null,
    preds: [...b.preds],
  };
}

function cloneFunc(fn: PFunc, newName: string): PFunc {
  return {
    name: newName,
    params: fn.params.map((p) => ({ ...p })),
    retTy: fn.retTy,
    blocks: fn.blocks.map(cloneBlock),
    entry: fn.entry,
    varType: new Map(fn.varType),
    exported: false, // a clone is a fresh internal function; only direct sites reach it
  };
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export function interproc(pm: PModule): InterprocStats {
  const stats: InterprocStats = { retConsts: 0, specialized: 0, redirected: 0, constArgs: 0, deadArgs: 0 };

  // (4) Return-constant folding first: it may delete calls, simplifying the graph
  // the later analyses see. A call to a pure constant-returning `f` becomes the
  // literal outright — the `call` has no effect to keep, so it disappears.
  {
    const constRet = new Map<string, POperand>();
    for (const fn of pm.funcs) {
      const c = constantReturn(fn);
      if (c) constRet.set(fn.name, c);
    }
    if (constRet.size > 0) {
      for (const fn of pm.funcs) {
        for (const b of fn.blocks) {
          for (let i = 0; i < b.insts.length; i++) {
            const inst = b.insts[i];
            if (inst.kind !== 'call') continue;
            const c = constRet.get(inst.sub);
            if (!c || inst.dest === null) continue;
            // Replace `d = call f(args)` with `d = copy <const>`; f is pure, so the
            // call (and its argument evaluation) has nothing observable to preserve.
            b.insts[i] = { dest: inst.dest, ty: inst.ty, kind: 'copy', sub: '', args: [{ ...c }], span: inst.span };
            stats.retConsts++;
          }
        }
      }
    }
  }

  const recursive = recursiveFunctions(pm);
  const addressTaken = addressTakenFunctions(pm);

  // (3) Function specialization. For each non-recursive, size-bounded callee, find a
  // parameter that is a constant at some (but not all) of its call sites and split
  // those sites off to a fresh clone. Snapshot the original function list so we never
  // specialize a clone we just made (bounded, terminating).
  let cloneCounter = 1;
  const originals = [...pm.funcs];
  for (const callee of originals) {
    if (stats.specialized >= GLOBAL_CLONE_BUDGET) break;
    if (recursive.has(callee.name)) continue;
    if (funcInstCount(callee) > MAX_SPEC_CALLEE_INSTS) continue;
    if (callee.params.length === 0) continue;

    let specsForThisFn = 0;
    for (let k = 0; k < callee.params.length; k++) {
      if (specsForThisFn >= MAX_SPEC_PARAMS_PER_FN) break;
      if (stats.specialized >= GLOBAL_CLONE_BUDGET) break;

      // Re-collect fresh each iteration: a prior specialization redirected some sites
      // to a clone, so `callee`'s remaining direct sites have shrunk.
      const sites = collectCallSites(pm).get(callee.name) ?? [];
      if (sites.length < 2) continue; // splitting needs ≥2 sites (else it's all-or-nothing)

      // Tally constant values seen for param k across the remaining sites.
      const byConst = new Map<string, { op: POperand; sites: CallSite[] }>();
      let nonConst = 0;
      for (const s of sites) {
        const arg = s.inst.args[k];
        const key = arg ? constKey(arg) : null;
        if (key === null) { nonConst++; continue; }
        const e = byConst.get(key) ?? { op: arg, sites: [] };
        e.sites.push(s);
        byConst.set(key, e);
      }
      // Pick the most common constant value.
      let best: { op: POperand; sites: CallSite[] } | null = null;
      for (const e of byConst.values()) if (!best || e.sites.length > best.sites.length) best = e;
      if (!best) continue;
      // If *every* site already passes this one constant, it is module-constant on the
      // callee itself — transform (1)/(2) handles it with no clone. Skip.
      if (best.sites.length === sites.length && nonConst === 0 && byConst.size === 1) continue;
      // Worth-it gate: a clone duplicates the whole body, so only split when it pays.
      // Two-or-more sites amortize the copy; a single site only earns it for a small
      // helper (where baking the constant in shrinks more than the copy costs).
      const small = funcInstCount(callee) <= 24;
      if (best.sites.length < 2 && !small) continue;

      const clone = cloneFunc(callee, `${callee.name}$sp${cloneCounter++}`);
      pm.funcs.push(clone);
      for (const s of best.sites) s.inst.sub = clone.name;
      stats.specialized++;
      stats.redirected += best.sites.length;
      specsForThisFn++;
    }
  }

  // (1)+(2) Module-constant argument propagation + dead-argument elimination.
  // Recompute sites over the whole (now clone-augmented) module. For every function
  // whose callers are *all* known — not exported, address never taken — a parameter
  // passed the same literal at every site is a module-wide constant.
  {
    const sites = collectCallSites(pm);
    for (const fn of pm.funcs) {
      if (fn.exported || addressTaken.has(fn.name)) continue; // unknown external callers
      if (fn.params.length === 0) continue;
      const calls = sites.get(fn.name) ?? [];
      if (calls.length === 0) continue; // no caller ⇒ no constant to fold (and likely dead)

      // Meet each parameter's incoming argument over all call sites.
      const constParam: (POperand | null)[] = fn.params.map((_, k) => {
        let acc: POperand | null = null;
        let key: string | null = null;
        for (const s of calls) {
          const arg = s.inst.args[k];
          const ak = arg ? constKey(arg) : null;
          if (ak === null) return null; // a non-constant argument ⇒ ⊥
          if (acc === null) { acc = arg; key = ak; }
          else if (ak !== key) return null; // two different constants ⇒ ⊥
        }
        return acc;
      });

      const deadIdx: number[] = [];
      for (let k = 0; k < fn.params.length; k++) {
        const c = constParam[k];
        if (!c || c.tag !== 'const') continue;
        // (1) Bind the parameter to its constant inside the body.
        bindParamConst(fn, fn.params[k].name, fn.params[k].ty, c.num);
        stats.constArgs++;
        deadIdx.push(k);
      }
      if (deadIdx.length === 0) continue;

      // (2) The parameter is now dead input (every caller is known and passes the
      // bound literal): drop it from the signature and from every call site. Remove
      // from the highest index down so earlier positions stay valid.
      deadIdx.sort((a, b) => b - a);
      for (const k of deadIdx) {
        fn.params.splice(k, 1);
        for (const s of calls) {
          if (k < s.inst.args.length) s.inst.args.splice(k, 1);
        }
        stats.deadArgs++;
      }
    }
  }

  return stats;
}
