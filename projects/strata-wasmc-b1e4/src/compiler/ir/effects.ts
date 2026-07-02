import type { IRFunc, IRModule, Inst } from './ir';

// =====================================================================
// Interprocedural effect / purity analysis
// =====================================================================
//
// The rest of the mid-end is intraprocedural: every call is opaque, so
// `hasSideEffect` conservatively treats *every* `call` as if it stored to
// memory, and GVN/DCE/LICM never touch one. That leaves a whole class of wins on
// the table — the redundant `gcd(a,b) + gcd(a,b)`, the loop-invariant `f(k)`
// recomputed every iteration, the dead `is_prime(n)` whose result is discarded.
//
// This pass classifies each function by a whole-program fixpoint over the call
// graph, so those calls become first-class optimizable values:
//
//   • `pure` (const / referentially transparent): the result depends *only* on
//     the argument values and the call has no observable effect. It performs no
//     store, no global write, no `print`, no `alloc` (a heap bump is a hidden
//     write to the allocation pointer), no `call_indirect` (unknown target), and
//     reads no mutable state — no `load`, and no `gget` of a *mutable* global
//     (reading an immutable global is reading a compile-time constant, which is
//     fine). Every function it calls directly is itself `pure`. Two `pure` calls
//     with equal arguments return equal values, so GVN may deduplicate them; and
//     because a dominating call runs first, GVN may delete the dominated twin
//     even when the callee can trap or recurse — the twin can only trap or
//     return exactly as the dominator already did.
//
//   • `pureNoTrap`: `pure` *and* provably non-trapping, so a call may be
//     speculatively executed where the original program might not have run it
//     (LICM hoisting it out of a possibly-zero-trip loop) or dropped when its
//     result is dead (DCE). A `pure` function reads no memory, so it can never
//     raise an out-of-bounds trap; the only trap sources left are integer
//     `div_s`/`rem_s` (divide-by-zero / INT_MIN÷-1) and unbounded recursion
//     (a wasm call-stack overflow). A function is `pureNoTrap` when it is
//     `pure`, contains no `div_s`/`rem_s`, takes part in no call-graph cycle,
//     and every function it calls is `pureNoTrap` too.
//
// Both relations are sound *supersets* of the effects that can actually happen:
// when in doubt a function is classified impure / may-trap, never the reverse,
// so an optimization gated on them can never change observable behaviour. The
// differential harness proves it at every optimization level.

export interface EffectInfo {
  /** Referentially transparent: result depends only on args, no observable effect. */
  pure: (name: string) => boolean;
  /** `pure` and provably non-trapping (safe to speculate or drop when dead). */
  pureNoTrap: (name: string) => boolean;
}

interface LocalEffects {
  /** Writes memory / a global / prints / allocates — a genuine side effect. */
  writes: boolean;
  /** Reads mutable state (a `load`, or a `gget` of a mutable global). */
  reads: boolean;
  /** Calls through the function table (unknown, possibly-effectful target). */
  callind: boolean;
  /** Contains an integer `div_s`/`rem_s` — a potential divide-by-zero trap. */
  divRem: boolean;
  /** Names of the functions this one calls directly. */
  callees: string[];
}

function scan(fn: IRFunc, mutableGlobals: Set<string>): LocalEffects {
  const e: LocalEffects = {
    writes: false,
    reads: false,
    callind: false,
    divRem: false,
    callees: [],
  };
  const note = (inst: Inst): void => {
    switch (inst.kind) {
      case 'store':
      case 'vstore':
      case 'gset':
      case 'print':
      case 'alloc': // bumps the heap pointer — an observable write hidden in the op
        e.writes = true;
        break;
      case 'load':
      case 'vload':
        e.reads = true;
        break;
      case 'gget':
        // Reading an immutable global is reading a constant; only a *mutable*
        // global is mutable state a caller could change between two calls.
        if (mutableGlobals.has(inst.sub)) e.reads = true;
        break;
      case 'callind':
        e.callind = true;
        break;
      case 'call':
        e.callees.push(inst.sub);
        break;
      case 'ibin':
        if (inst.sub === 'div_s' || inst.sub === 'rem_s') e.divRem = true;
        break;
      default:
        break; // pure value families (ibin add/…, icmp, cast, select, funcaddr, SIMD) are effect-free
    }
  };
  for (const b of fn.blocks) for (const inst of b.insts) note(inst);
  return e;
}

/** Every function reachable (transitively, through direct calls) from `start`. */
function reaches(start: string, adj: Map<string, string[]>): Set<string> {
  const seen = new Set<string>();
  const stack = [...(adj.get(start) ?? [])];
  while (stack.length) {
    const n = stack.pop()!;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const c of adj.get(n) ?? []) stack.push(c);
  }
  return seen;
}

export function analyzeEffects(mod: IRModule): EffectInfo {
  const mutableGlobals = new Set(mod.globals.filter((g) => g.mutable).map((g) => g.name));
  const local = new Map<string, LocalEffects>();
  const adj = new Map<string, string[]>();
  for (const fn of mod.funcs) {
    const e = scan(fn, mutableGlobals);
    local.set(fn.name, e);
    adj.set(fn.name, e.callees);
  }

  // --- `pure`: greatest fixpoint. Assume every function pure, then demote any
  // that writes, reads mutable state, calls indirectly, calls an import, or
  // calls a demoted function — iterating until nothing changes. Recursion is
  // handled for free (a self-call to a still-pure function keeps it pure).
  const pure = new Set(mod.funcs.map((f) => f.name));
  let changed = true;
  while (changed) {
    changed = false;
    for (const fn of mod.funcs) {
      if (!pure.has(fn.name)) continue;
      const e = local.get(fn.name)!;
      const impure =
        e.writes ||
        e.reads ||
        e.callind ||
        e.callees.some((c) => !pure.has(c) || !adj.has(c));
      if (impure) {
        pure.delete(fn.name);
        changed = true;
      }
    }
  }

  // --- recursion: a function that can reach itself through the call graph might
  // overflow the call stack, so it can never be `pureNoTrap`.
  const recursive = new Set<string>();
  for (const fn of mod.funcs) if (reaches(fn.name, adj).has(fn.name)) recursive.add(fn.name);

  // --- `pureNoTrap`: greatest fixpoint over the pure, non-recursive functions
  // with no integer divide, whose callees are all `pureNoTrap` as well.
  const pureNoTrap = new Set([...pure].filter((n) => !recursive.has(n) && !local.get(n)!.divRem));
  changed = true;
  while (changed) {
    changed = false;
    for (const name of [...pureNoTrap]) {
      const e = local.get(name)!;
      if (e.callees.some((c) => !pureNoTrap.has(c))) {
        pureNoTrap.delete(name);
        changed = true;
      }
    }
  }

  return {
    pure: (name) => pure.has(name),
    pureNoTrap: (name) => pureNoTrap.has(name),
  };
}
