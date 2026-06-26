// Control-flow simplification.
//
//   * jump-to-next   — a `j L` whose target label sits on the very next instruction is a no-op.
//   * jump threading — a branch/jump to a block that only does `j L2` is retargeted straight to L2.
//   * unreachable    — code with no path from any entry (e.g. after an unconditional jump/return,
//                      or a block left dangling once a branch was folded) is deleted.
//
// All three are classic and safe: they never change which instructions *execute*, only how control
// reaches them.

import type { Module, Instr, Operand } from '../ir';
import { textInstrs, printInstr } from '../ir';
import { buildCfg } from '../cfg';
import { analyzeInstr } from '../semantics';
import { applyDeletions } from '../edit';
import type { Pass, PassCtx } from '../pass';

function symOperand(o: Operand | undefined): string | undefined {
  return o && o.kind === 'sym' ? o.name : undefined;
}
// The label a `j`/`jal x0` jumps to, if this instruction is exactly that.
function plainJumpTarget(i: Instr): string | undefined {
  if (i.op === 'j') return symOperand(i.operands[0]);
  if (i.op === 'jal' && i.operands.length === 2 && i.operands[0].kind === 'reg' && i.operands[0].n === 0) {
    return symOperand(i.operands[1]);
  }
  return undefined;
}

export const controlPass: Pass = {
  name: 'control-flow',
  run(m: Module, ctx: PassCtx): number {
    let changes = 0;
    const instrs = textInstrs(m);

    // Map each label to the index of the instruction it sits on.
    const labelAt = new Map<string, number>();
    instrs.forEach((ins, idx) => ins.labels.forEach((l) => labelAt.set(l, idx)));

    // A label is a "forwarding" target if its instruction is a plain `j L2` — record L2.
    const forwardsTo = (label: string): string | undefined => {
      const idx = labelAt.get(label);
      if (idx === undefined) return undefined;
      const t = plainJumpTarget(instrs[idx]);
      return t && t !== label ? t : undefined;
    };

    // 1) Jump threading: retarget any branch/jump through a chain of forwarding blocks.
    for (const i of instrs) {
      const info = analyzeInstr(i);
      if (!info.isBranch && !info.isTerminator) continue;
      for (let k = 0; k < i.operands.length; k++) {
        const o = i.operands[k];
        if (o.kind !== 'sym') continue;
        let dest = o.name;
        const seen = new Set<string>([dest]);
        let next = forwardsTo(dest);
        while (next && !seen.has(next)) { dest = next; seen.add(dest); next = forwardsTo(dest); }
        if (dest !== o.name) {
          const before = printInstr(i).trim();
          i.operands[k] = { kind: 'sym', name: dest };
          i.rewritten = true;
          ctx.rewrote('control-flow', before, i, 'threaded jump through a forwarding block');
          changes++;
        }
      }
    }

    // 2) Jump-to-next: a `j L` immediately followed by the instruction labelled L.
    const drop = new Set<Instr>();
    for (let idx = 0; idx < instrs.length; idx++) {
      const t = plainJumpTarget(instrs[idx]);
      if (t === undefined) continue;
      const next = instrs[idx + 1];
      if (next && next.labels.includes(t)) {
        ctx.deleted('control-flow', instrs[idx], 'jump to the next instruction');
        drop.add(instrs[idx]);
      }
    }

    // 3) Unreachable code: blocks with no path from an entry.
    const cfg = buildCfg(m);
    for (const b of cfg.blocks) {
      if (b.reachable) continue;
      for (const ii of b.range) {
        const ins = cfg.instrs[ii];
        if (!drop.has(ins)) { ctx.deleted('control-flow', ins, 'unreachable code'); drop.add(ins); }
      }
    }

    return changes + applyDeletions(m, drop);
  },
};
