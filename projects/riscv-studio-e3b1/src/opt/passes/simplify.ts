// Peephole normalisation + algebraic strength reduction.
//
// These are unconditionally-valid local rewrites: identity operations collapse to a move, a move to
// self vanishes, multiply/divide by a power of two becomes a shift, and `x0` algebra folds. They
// shrink code directly and, just as importantly, expose copies and dead definitions for the later
// propagation and dead-code passes to clean up.

import type { Module, Instr, Operand } from '../ir';
import { textInstrs, printInstr, imm as mkImm, reg as mkReg, isImm, isReg } from '../ir';
import { ZERO } from '../semantics';
import type { Pass, PassCtx } from '../pass';

function setMv(i: Instr, rd: number, rs: number): void {
  i.op = 'mv';
  i.operands = [mkReg(rd), mkReg(rs)];
  i.known = true;
  i.rewritten = true;
}
function setLi(i: Instr, rd: number, v: number): void {
  i.op = 'li';
  i.operands = [mkReg(rd), mkImm(v | 0)];
  i.known = true;
  i.rewritten = true;
}
function setShiftI(i: Instr, op: string, rd: number, rs: number, sh: number): void {
  i.op = op;
  i.operands = [mkReg(rd), mkReg(rs), mkImm(sh)];
  i.known = true;
  i.rewritten = true;
}
function setNop(i: Instr): void {
  i.op = 'nop';
  i.operands = [];
  i.known = true;
  i.rewritten = true;
}

const r = (o: Operand | undefined): number | undefined => (isReg(o) ? o.n : undefined);
const v = (o: Operand | undefined): number | undefined => (isImm(o) ? o.v : undefined);
const isPow2 = (n: number): boolean => n > 0 && (n & (n - 1)) === 0;
const log2 = (n: number): number => Math.round(Math.log2(n));

export const simplifyPass: Pass = {
  name: 'peephole',
  run(m: Module, ctx: PassCtx): number {
    let changes = 0;
    for (const i of textInstrs(m)) {
      if (!i.known) continue;
      const before = printInstr(i).trim();
      if (trySimplify(i)) {
        ctx.rewrote('peephole', before, i, 'algebraic / identity simplification');
        changes++;
      }
    }
    return changes;
  },
};

function trySimplify(i: Instr): boolean {
  const o = i.operands;
  const rd = r(o[0]);

  switch (i.op) {
    case 'addi': {
      const rs = r(o[1]);
      const imm = v(o[2]);
      if (rd === undefined || rs === undefined || imm === undefined) return false;
      if (rs === ZERO) { setLi(i, rd, imm); return true; } // addi rd, x0, c → li rd, c
      if (imm === 0) { setMv(i, rd, rs); return true; } // addi rd, rs, 0 → mv
      return false;
    }
    case 'ori':
    case 'xori': {
      const rs = r(o[1]);
      const imm = v(o[2]);
      if (rd === undefined || rs === undefined || imm === undefined) return false;
      if (imm === 0) { setMv(i, rd, rs); return true; }
      return false;
    }
    case 'andi': {
      const rs = r(o[1]);
      const imm = v(o[2]);
      if (rd === undefined || rs === undefined || imm === undefined) return false;
      if (imm === -1) { setMv(i, rd, rs); return true; }
      if (imm === 0) { setLi(i, rd, 0); return true; }
      return false;
    }
    case 'slli':
    case 'srli':
    case 'srai': {
      const rs = r(o[1]);
      const sh = v(o[2]);
      if (rd === undefined || rs === undefined || sh === undefined) return false;
      if (sh === 0) { setMv(i, rd, rs); return true; }
      return false;
    }
    case 'add':
    case 'or':
    case 'sub':
    case 'xor': {
      const a = r(o[1]);
      const b = r(o[2]);
      if (rd === undefined || a === undefined || b === undefined) return false;
      if (b === ZERO) { setMv(i, rd, a); return true; } // op rd, a, x0 → mv rd, a
      if (a === ZERO && (i.op === 'add' || i.op === 'or' || i.op === 'xor')) { setMv(i, rd, b); return true; }
      return false;
    }
    case 'and': {
      const a = r(o[1]);
      const b = r(o[2]);
      if (rd === undefined || a === undefined || b === undefined) return false;
      if (a === ZERO || b === ZERO) { setLi(i, rd, 0); return true; }
      if (a === b) { setMv(i, rd, a); return true; }
      return false;
    }
    case 'mul': {
      const a = r(o[1]);
      const b = r(o[2]);
      if (rd === undefined || a === undefined || b === undefined) return false;
      if (a === ZERO || b === ZERO) { setLi(i, rd, 0); return true; }
      return false;
    }
    case 'mv': {
      const rs = r(o[1]);
      if (rd !== undefined && rs === rd) { setNop(i); return true; } // mv rd, rd → nop
      if (rs === ZERO && rd !== undefined) { setLi(i, rd, 0); return true; } // mv rd, x0 → li 0
      return false;
    }
    default:
      return false;
  }
}

export { isPow2, log2, setMv, setLi, setShiftI, setNop };
