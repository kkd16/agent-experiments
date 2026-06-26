// Local common-subexpression elimination via value numbering.
//
// Within a block we give every distinct runtime value a number: a fresh number on each computation,
// and the *same* number propagated through a `mv`. An expression is keyed by its opcode, immediates,
// and the value numbers of its operands — so if an identical value has already been computed into a
// still-live register, we replace the recomputation with a move from it. Value-number equality means
// provably-equal values, which makes this sound without any aliasing reasoning (we only touch pure,
// register-only instructions — loads/stores and side-effecting ops are left entirely alone).

import type { Module, Instr, Operand } from '../ir';
import { printInstr, reg as mkReg } from '../ir';
import { buildCfg } from '../cfg';
import { analyzeInstr, ZERO } from '../semantics';
import type { Pass, PassCtx } from '../pass';

// Opcodes whose result is a pure function of their register/immediate operands (no memory, no pc).
function isPureValue(i: Instr, info: ReturnType<typeof analyzeInstr>): boolean {
  if (!info.eliminable || info.memRead || info.memWrite || info.sideEffect || info.opaque) return false;
  if (info.defs.length !== 1) return false;
  if (i.op === 'auipc') return false; // value depends on pc, not just operands
  return true;
}

export const csePass: Pass = {
  name: 'cse',
  run(m: Module, ctx: PassCtx): number {
    const cfg = buildCfg(m);
    let changes = 0;
    let nextVN = 1;
    const constZeroVN = 0;

    for (const b of cfg.blocks) {
      const regVN = new Int32Array(32);
      for (let r = 1; r < 32; r++) regVN[r] = nextVN++; // each reg starts as an unknown distinct value
      regVN[ZERO] = constZeroVN;
      const avail = new Map<string, { reg: number; vn: number }>();

      const vnOfOperand = (o: Operand): string => {
        if (o.kind === 'reg') return `r${regVN[o.n]}`;
        if (o.kind === 'imm') return `i${o.v}`;
        if (o.kind === 'sym') return `s${o.reloc ?? ''}:${o.name}`;
        return `x${JSON.stringify(o)}`;
      };

      for (const idx of b.range) {
        const i = cfg.instrs[idx];
        const info = analyzeInstr(i);

        if (i.op === 'mv' && i.operands[0]?.kind === 'reg' && i.operands[1]?.kind === 'reg') {
          // A copy: the destination takes on the source's value number.
          regVN[i.operands[0].n] = regVN[i.operands[1].n];
          continue;
        }

        if (isPureValue(i, info)) {
          const rd = info.defs[0];
          const key = i.op + '|' + i.operands.slice(1).map(vnOfOperand).join(',');
          const hit = avail.get(key);
          if (hit && regVN[hit.reg] === hit.vn && hit.reg !== rd) {
            const before = printInstr(i).trim();
            i.op = 'mv';
            i.operands = [mkReg(rd), mkReg(hit.reg)];
            i.known = true;
            i.rewritten = true;
            regVN[rd] = hit.vn;
            ctx.rewrote('cse', before, i, 'reuses an already-computed value');
            changes++;
          } else {
            const vn = nextVN++;
            regVN[rd] = vn;
            avail.set(key, { reg: rd, vn });
          }
          continue;
        }

        // Anything else: every register it clobbers takes a fresh, unknown value number.
        for (const c of info.clobbers) if (c !== ZERO) regVN[c] = nextVN++;
      }
    }
    return changes;
  },
};
