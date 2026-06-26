// Block-local value propagation: constant propagation, copy propagation, constant folding,
// power-of-two strength reduction, and constant-branch resolution.
//
// Within each basic block we track, per register, whether it currently holds a known constant or is
// a copy of another register. Reads are rewritten to the copy's root (freeing the move for the
// dead-code pass) and folded against constants; whole instructions collapse when all inputs are
// known. Staying strictly *intra-block* keeps it provably correct without a global value analysis —
// and the stack-machine's redundancy (materialise a constant, spill it, reload it, operate) is
// almost entirely within a block, so this recovers the lion's share of it.

import type { Module, Instr, Operand } from '../ir';
import { printInstr, isReg, isImm, reg as mkReg, imm as mkImm } from '../ir';
import { buildCfg } from '../cfg';
import { analyzeInstr, ZERO, SP, S0 } from '../semantics';
import type { Pass, PassCtx } from '../pass';
import { setMv, setLi, setShiftI, setNop, isPow2, log2 } from './simplify';

type Val =
  | { k: 'const'; v: number }
  | { k: 'copy'; reg: number }
  | { k: 'addr'; base: number; off: number }; // reg == base + off (for address-mode folding)

const fits12 = (x: number): boolean => x >= -2048 && x <= 2047;

export const propagatePass: Pass = {
  name: 'propagate',
  run(m: Module, ctx: PassCtx): number {
    const cfg = buildCfg(m);
    let changes = 0;
    for (const b of cfg.blocks) {
      const vals = new Map<number, Val>();

      const constOf = (r: number): number | undefined => {
        if (r === ZERO) return 0;
        const e = vals.get(r);
        return e && e.k === 'const' ? e.v : undefined;
      };
      const rootOf = (r: number): number => {
        let cur = r;
        const seen = new Set<number>();
        while (!seen.has(cur)) {
          seen.add(cur);
          const e = vals.get(cur);
          if (e && e.k === 'copy') cur = e.reg;
          else break;
        }
        return cur;
      };
      const addrOf = (r: number): { base: number; off: number } | undefined => {
        const e = vals.get(r);
        return e && e.k === 'addr' ? e : undefined;
      };
      const invalidate = (r: number) => {
        vals.delete(r);
        // Drop any copy of, or address based on, the register whose value just changed.
        for (const [k, e] of vals) {
          if (e.k === 'copy' && e.reg === r) vals.delete(k);
          else if (e.k === 'addr' && e.base === r) vals.delete(k);
        }
      };

      for (const idx of b.range) {
        const i = cfg.instrs[idx];
        const info = analyzeInstr(i);
        if (info.opaque) {
          for (const c of info.clobbers) invalidate(c);
          continue;
        }
        const before = printInstr(i).trim();
        let touched = false;

        // 1) Copy-propagate readable register operands to their current root, and fold address
        //    computations into the memory operand of loads/stores (`addi rT,rB,K; lw rD,J(rT)` →
        //    `lw rD,(J+K)(rB)`).
        const destIdx = isReg(i.operands[0]) && info.defs.includes(i.operands[0].n) ? 0 : -1;
        for (let k = 0; k < i.operands.length; k++) {
          if (k === destIdx) continue;
          const o = i.operands[k];
          if (isReg(o) && o.n !== ZERO) {
            const root = rootOf(o.n);
            if (root !== o.n) { i.operands[k] = mkReg(root); touched = true; i.rewritten = true; }
          } else if (o && o.kind === 'mem' && o.base !== ZERO) {
            const a = addrOf(o.base);
            if (a && isImm(o.off) && fits12(o.off.v + a.off)) {
              i.operands[k] = { kind: 'mem', base: a.base, off: mkImm((o.off.v + a.off) | 0) };
              touched = true; i.rewritten = true;
            } else {
              const root = rootOf(o.base);
              if (root !== o.base) { i.operands[k] = { kind: 'mem', base: root, off: o.off }; touched = true; i.rewritten = true; }
            }
          }
        }

        // 2) Fold / strength-reduce using known constants, then update the value map.
        const newVal = foldAndModel(i, constOf, addrOf);
        if (newVal.rewrote) touched = true;

        if (touched) { ctx.rewrote('propagate', before, i, newVal.note); changes++; }

        // 3) Commit the value lattice for this instruction's destination + clobbers.
        for (const c of info.clobbers) invalidate(c);
        if (newVal.set && newVal.set.reg !== ZERO) vals.set(newVal.set.reg, newVal.set.val);
      }
    }
    return changes;
  },
};

interface FoldResult {
  rewrote: boolean;
  note: string;
  set?: { reg: number; val: Val };
}

// Read source registers (post-substitution) and fold constants / reduce strength. May rewrite `i`.
function foldAndModel(
  i: Instr,
  constOf: (r: number) => number | undefined,
  addrOf: (r: number) => { base: number; off: number } | undefined,
): FoldResult {
  const o = i.operands;
  const rd = isReg(o[0]) ? o[0].n : undefined;
  const none: FoldResult = { rewrote: false, note: '' };

  const setConst = (reg: number, v: number): FoldResult['set'] => ({ reg, val: { k: 'const', v: v | 0 } });

  switch (i.op) {
    case 'li': {
      if (rd === undefined || !isImm(o[1])) return none;
      return { rewrote: false, note: '', set: setConst(rd, o[1].v) };
    }
    case 'mv': {
      const rs = isReg(o[1]) ? o[1].n : undefined;
      if (rd === undefined || rs === undefined) return none;
      const c = constOf(rs);
      if (c !== undefined) { setLi(i, rd, c); return { rewrote: true, note: 'copy of a constant → li', set: setConst(rd, c) }; }
      if (rs !== rd) return { rewrote: false, note: '', set: { reg: rd, val: { k: 'copy', reg: rs } } };
      return none;
    }
    case 'addi': {
      const rs = isReg(o[1]) ? o[1].n : undefined;
      const imm = isImm(o[2]) ? o[2].v : undefined;
      if (rd === undefined || rs === undefined || imm === undefined) return none;
      const c = constOf(rs);
      if (c !== undefined) { const r = (c + imm) | 0; setLi(i, rd, r); return { rewrote: true, note: 'constant fold', set: setConst(rd, r) }; }
      // Track rd = base + offset so a following load/store can fold the address in. The base must
      // be a register *other than rd* whose value is unchanged until the use — an in-place
      // `addi sp, sp, k` defines no such relation (its base is itself), so we leave rd unknown. We
      // also never re-express sp/s0 themselves as addresses: they are stable pointer bases, and
      // folding a frame (`s0`) access into a moving `sp` form would only obscure the code.
      if (rd === SP || rd === S0) return none;
      const a = addrOf(rs);
      if (a && a.base !== rd) return { rewrote: false, note: '', set: { reg: rd, val: { k: 'addr', base: a.base, off: (a.off + imm) | 0 } } };
      if (rs !== ZERO && rs !== rd) return { rewrote: false, note: '', set: { reg: rd, val: { k: 'addr', base: rs, off: imm } } };
      return none;
    }
    case 'add': case 'sub': case 'and': case 'or': case 'xor':
    case 'sll': case 'srl': case 'sra':
    case 'slt': case 'sltu': case 'mul': case 'div': case 'divu': case 'rem': case 'remu': {
      const a = isReg(o[1]) ? o[1].n : undefined;
      const bb = isReg(o[2]) ? o[2].n : undefined;
      if (rd === undefined || a === undefined || bb === undefined) return none;
      const ca = constOf(a);
      const cb = constOf(bb);
      if (ca !== undefined && cb !== undefined) {
        const r = evalBin(i.op, ca, cb);
        if (r !== undefined) { setLi(i, rd, r); return { rewrote: true, note: 'constant fold', set: setConst(rd, r) }; }
      }
      // Strength reduction / immediate folding with one known operand.
      const sr = reduceBinary(i, a, bb, ca, cb);
      if (sr) return { rewrote: true, note: sr, set: undefined };
      return none;
    }
    case 'andi': case 'ori': case 'xori': case 'slti': case 'sltiu': {
      const rs = isReg(o[1]) ? o[1].n : undefined;
      const imm = isImm(o[2]) ? o[2].v : undefined;
      if (rd === undefined || rs === undefined || imm === undefined) return none;
      const c = constOf(rs);
      if (c !== undefined) { const r = evalImm(i.op, c, imm); setLi(i, rd, r); return { rewrote: true, note: 'constant fold', set: setConst(rd, r) }; }
      return none;
    }
    case 'slli': case 'srli': case 'srai': {
      const rs = isReg(o[1]) ? o[1].n : undefined;
      const sh = isImm(o[2]) ? o[2].v : undefined;
      if (rd === undefined || rs === undefined || sh === undefined) return none;
      const c = constOf(rs);
      if (c !== undefined) { const r = evalImm(i.op, c, sh); setLi(i, rd, r); return { rewrote: true, note: 'constant fold', set: setConst(rd, r) }; }
      return none;
    }
    case 'neg': case 'not': case 'seqz': case 'snez': case 'sltz': case 'sgtz': {
      const rs = isReg(o[1]) ? o[1].n : undefined;
      if (rd === undefined || rs === undefined) return none;
      const c = constOf(rs);
      if (c !== undefined) { const r = evalUnary(i.op, c); setLi(i, rd, r); return { rewrote: true, note: 'constant fold', set: setConst(rd, r) }; }
      return none;
    }
    // Constant-branch resolution (branches are always block-terminal, so this is safe).
    case 'beqz': case 'bnez': {
      const rs = isReg(o[0]) ? o[0].n : undefined;
      if (rs === undefined) return none;
      const c = constOf(rs);
      if (c === undefined) return none;
      const taken = i.op === 'beqz' ? c === 0 : c !== 0;
      return resolveBranch(i, taken, o[1]);
    }
    case 'beq': case 'bne': case 'blt': case 'bge': case 'bltu': case 'bgeu': {
      const a = isReg(o[0]) ? o[0].n : undefined;
      const bb = isReg(o[1]) ? o[1].n : undefined;
      if (a === undefined || bb === undefined) return none;
      const ca = constOf(a); const cb = constOf(bb);
      if (ca === undefined || cb === undefined) return none;
      const taken = branchTaken(i.op, ca, cb);
      return resolveBranch(i, taken, o[2]);
    }
    default:
      return none;
  }
}

function resolveBranch(i: Instr, taken: boolean, target: Operand | undefined): FoldResult {
  if (taken) {
    if (!target || target.kind !== 'sym') return { rewrote: false, note: '' };
    i.op = 'j';
    i.operands = [{ kind: 'sym', name: target.name }];
    i.known = true;
    i.rewritten = true;
    return { rewrote: true, note: 'branch condition is always true → unconditional jump' };
  }
  setNop(i);
  return { rewrote: true, note: 'branch condition is always false → removed' };
}

// One-known-operand strength reduction for the register-register binary forms.
function reduceBinary(i: Instr, a: number, b: number, ca: number | undefined, cb: number | undefined): string | null {
  const rd = isReg(i.operands[0]) ? (i.operands[0] as { n: number }).n : undefined;
  if (rd === undefined) return null;
  switch (i.op) {
    case 'add':
      if (cb !== undefined && fits12(cb)) { toAddi(i, rd, a, cb); return 'add with constant → addi'; }
      if (ca !== undefined && fits12(ca)) { toAddi(i, rd, b, ca); return 'add with constant → addi'; }
      return null;
    case 'sub':
      if (cb !== undefined && fits12(-cb)) { toAddi(i, rd, a, -cb); return 'subtract constant → addi'; }
      return null;
    case 'and':
      if (cb !== undefined && fits12(cb)) { toImmOp(i, 'andi', rd, a, cb); return 'and with constant → andi'; }
      if (ca !== undefined && fits12(ca)) { toImmOp(i, 'andi', rd, b, ca); return 'and with constant → andi'; }
      return null;
    case 'or':
      if (cb !== undefined && fits12(cb)) { toImmOp(i, 'ori', rd, a, cb); return 'or with constant → ori'; }
      if (ca !== undefined && fits12(ca)) { toImmOp(i, 'ori', rd, b, ca); return 'or with constant → ori'; }
      return null;
    case 'xor':
      if (cb !== undefined && fits12(cb)) { toImmOp(i, 'xori', rd, a, cb); return 'xor with constant → xori'; }
      if (ca !== undefined && fits12(ca)) { toImmOp(i, 'xori', rd, b, ca); return 'xor with constant → xori'; }
      return null;
    case 'sll': case 'srl': case 'sra':
      if (cb !== undefined) { setShiftI(i, i.op + 'i', rd, a, cb & 31); return 'shift by a constant → immediate shift'; }
      return null;
    case 'mul':
      if (cb !== undefined && isPow2(cb)) { setShiftI(i, 'slli', rd, a, log2(cb)); return 'multiply by 2^k → shift'; }
      if (ca !== undefined && isPow2(ca)) { setShiftI(i, 'slli', rd, b, log2(ca)); return 'multiply by 2^k → shift'; }
      if (cb === 1) { setMv(i, rd, a); return 'multiply by 1 → move'; }
      if (ca === 1) { setMv(i, rd, b); return 'multiply by 1 → move'; }
      return null;
    case 'divu':
      if (cb !== undefined && isPow2(cb)) { setShiftI(i, 'srli', rd, a, log2(cb)); return 'unsigned divide by 2^k → shift'; }
      return null;
    case 'remu':
      if (cb !== undefined && isPow2(cb) && fits12(cb - 1)) { toImmOp(i, 'andi', rd, a, cb - 1); return 'unsigned remainder by 2^k → mask'; }
      return null;
    default:
      return null;
  }
}

function toAddi(i: Instr, rd: number, rs: number, imm: number): void {
  i.op = 'addi';
  i.operands = [mkReg(rd), mkReg(rs), mkImm(imm | 0)];
  i.known = true;
  i.rewritten = true;
}
function toImmOp(i: Instr, op: string, rd: number, rs: number, imm: number): void {
  i.op = op;
  i.operands = [mkReg(rd), mkReg(rs), mkImm(imm | 0)];
  i.known = true;
  i.rewritten = true;
}

// ---- pure constant evaluation (exact RV32 semantics) ----------------------

function evalBin(op: string, a: number, b: number): number | undefined {
  switch (op) {
    case 'add': return (a + b) | 0;
    case 'sub': return (a - b) | 0;
    case 'and': return a & b;
    case 'or': return a | b;
    case 'xor': return a ^ b;
    case 'sll': return a << (b & 31);
    case 'srl': return a >>> (b & 31) | 0;
    case 'sra': return a >> (b & 31);
    case 'slt': return a < b ? 1 : 0;
    case 'sltu': return (a >>> 0) < (b >>> 0) ? 1 : 0;
    case 'mul': return Math.imul(a, b);
    case 'div':
      if (b === 0) return -1;
      if (a === -2147483648 && b === -1) return -2147483648;
      return Math.trunc(a / b) | 0;
    case 'divu':
      if (b === 0) return -1;
      return Math.trunc((a >>> 0) / (b >>> 0)) | 0;
    case 'rem':
      if (b === 0) return a | 0;
      if (a === -2147483648 && b === -1) return 0;
      return (a % b) | 0;
    case 'remu':
      if (b === 0) return a | 0;
      return ((a >>> 0) % (b >>> 0)) | 0;
    default: return undefined;
  }
}

function evalImm(op: string, a: number, imm: number): number {
  switch (op) {
    case 'andi': return a & imm;
    case 'ori': return a | imm;
    case 'xori': return a ^ imm;
    case 'slti': return a < imm ? 1 : 0;
    case 'sltiu': return (a >>> 0) < (imm >>> 0) ? 1 : 0;
    case 'slli': return a << (imm & 31);
    case 'srli': return a >>> (imm & 31) | 0;
    case 'srai': return a >> (imm & 31);
    default: return a;
  }
}

function evalUnary(op: string, a: number): number {
  switch (op) {
    case 'neg': return (-a) | 0;
    case 'not': return ~a;
    case 'seqz': return a === 0 ? 1 : 0;
    case 'snez': return a !== 0 ? 1 : 0;
    case 'sltz': return a < 0 ? 1 : 0;
    case 'sgtz': return a > 0 ? 1 : 0;
    default: return a;
  }
}

function branchTaken(op: string, a: number, b: number): boolean {
  switch (op) {
    case 'beq': return a === b;
    case 'bne': return a !== b;
    case 'blt': return a < b;
    case 'bge': return a >= b;
    case 'bltu': return (a >>> 0) < (b >>> 0);
    case 'bgeu': return (a >>> 0) >= (b >>> 0);
    default: return false;
  }
}
