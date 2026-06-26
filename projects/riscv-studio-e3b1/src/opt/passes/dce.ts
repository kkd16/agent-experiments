// Dead-code elimination.
//
// Build the CFG, run global liveness, and delete every pure instruction whose destination register
// is not live afterwards (and instructions that are pure with no destination at all, like a `nop`
// or `add x0, …`). Side-effecting and opaque instructions are never touched. Iterated by the driver
// to a fixpoint, this is what finally reaps the spill/reload and `mv` traffic the other passes
// expose.

import type { Module, Instr } from '../ir';
import { buildCfg } from '../cfg';
import { computeLiveness } from '../liveness';
import { analyzeInstr } from '../semantics';
import { applyDeletions } from '../edit';
import type { Pass, PassCtx } from '../pass';

export const dcePass: Pass = {
  name: 'dead-code',
  run(m: Module, ctx: PassCtx): number {
    const cfg = buildCfg(m);
    const live = computeLiveness(cfg);
    const drop = new Set<Instr>();

    for (let i = 0; i < cfg.instrs.length; i++) {
      const instr = cfg.instrs[i];
      const info = analyzeInstr(instr);
      if (!info.eliminable || info.sideEffect || info.opaque) continue;
      // Removable iff every register it defines is dead immediately after it.
      const after = live.liveAfter[i];
      const allDead = info.defs.every((d) => !after.has(d));
      if (allDead) drop.add(instr);
    }

    for (const instr of drop) ctx.deleted('dead-code', instr, 'result is never used');
    return applyDeletions(m, drop);
  },
};

// Exposed for tests that want to see what DCE would remove without mutating.
export function deadInstrs(m: Module): Instr[] {
  const cfg = buildCfg(m);
  const live = computeLiveness(cfg);
  const out: Instr[] = [];
  for (let i = 0; i < cfg.instrs.length; i++) {
    const info = analyzeInstr(cfg.instrs[i]);
    if (!info.eliminable || info.sideEffect || info.opaque) continue;
    if (info.defs.every((d) => !live.liveAfter[i].has(d))) out.push(cfg.instrs[i]);
  }
  return out;
}
