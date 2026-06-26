// Backward live-variable analysis over the CFG (see cfg.ts).
//
// A register is "live" at a point if some path from there reads it before the next write. We seed
// exits conservatively (a return makes the calling-convention set live; an unresolved jump makes
// *everything* live) and iterate the block transfer functions to a fixpoint. The product passes
// care about is `liveAfter[i]`: the set live immediately after instruction `i`, so dead-code
// elimination can delete a pure instruction whose destination is not in it.

import type { Cfg } from './cfg';
import { analyzeInstr, LIVE_AT_RETURN } from './semantics';

// Unresolved control transfers (a jump to a label we can't see) could read anything — be maximal.
const ALL_REGS: number[] = Array.from({ length: 31 }, (_, k) => k + 1); // x1..x31

export interface Liveness {
  liveIn: Set<number>[]; // per block
  liveOut: Set<number>[]; // per block
  /** Registers live immediately *after* instruction index i. */
  liveAfter: Set<number>[];
}

function seedExit(exit: 'none' | 'return' | 'unknown'): number[] {
  if (exit === 'return') return [...LIVE_AT_RETURN];
  if (exit === 'unknown') return ALL_REGS;
  return [];
}

export function computeLiveness(cfg: Cfg): Liveness {
  const { blocks, instrs } = cfg;
  const liveIn: Set<number>[] = blocks.map(() => new Set());
  const liveOut: Set<number>[] = blocks.map(() => new Set());

  let changed = true;
  while (changed) {
    changed = false;
    // Reverse order helps convergence but correctness doesn't depend on it.
    for (let bi = blocks.length - 1; bi >= 0; bi--) {
      const b = blocks[bi];
      const out = new Set<number>();
      for (const s of b.succ) for (const r of liveIn[s]) out.add(r);
      for (const r of seedExit(b.exit)) out.add(r);
      // A block that simply runs off the end of the text section (no terminator, no successor)
      // is treated like a return: nothing past the end observes a caller-saved temporary, but the
      // calling-convention set is kept live so a malformed fall-through can't drop a return value.
      if (b.succ.length === 0 && b.exit === 'none') for (const r of LIVE_AT_RETURN) out.add(r);

      // Transfer backward through the block.
      const cur = new Set(out);
      for (let k = b.range.length - 1; k >= 0; k--) {
        const info = analyzeInstr(instrs[b.range[k]]);
        for (const d of info.defs) cur.delete(d);
        for (const u of info.uses) cur.add(u);
      }

      if (!setEq(cur, liveIn[bi]) || !setEq(out, liveOut[bi])) {
        liveIn[bi] = cur;
        liveOut[bi] = out;
        changed = true;
      }
    }
  }

  // Materialise per-instruction live-after by replaying each block backward from its live-out.
  const liveAfter: Set<number>[] = instrs.map(() => new Set());
  for (let bi = 0; bi < blocks.length; bi++) {
    const b = blocks[bi];
    const cur = new Set(liveOut[bi]);
    for (let k = b.range.length - 1; k >= 0; k--) {
      const idx = b.range[k];
      liveAfter[idx] = new Set(cur);
      const info = analyzeInstr(instrs[idx]);
      for (const d of info.defs) cur.delete(d);
      for (const u of info.uses) cur.add(u);
    }
  }

  return { liveIn, liveOut, liveAfter };
}

function setEq(a: Set<number>, b: Set<number>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}
