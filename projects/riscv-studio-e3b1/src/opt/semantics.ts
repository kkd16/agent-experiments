// The single source of truth for what every instruction *does*, at the granularity the optimizer
// needs. Every pass routes its correctness through this table: which integer registers an
// instruction reads (`uses`), which it writes a fresh value to (`defs`), which become unknown
// (`clobbers` ⊇ defs — e.g. a call trashes the caller-saved set), whether it touches memory or has
// other side effects, and its control-flow shape.
//
// Two distinct notions of "written" are deliberate and load-bearing:
//   * `defs`     — the exact destination register(s). Used by dead-code elimination (delete a pure
//                  instruction whose single def is dead) and as the liveness KILL set. Must never
//                  over-claim, or liveness could wrongly judge a live value dead.
//   * `clobbers` — every register whose value becomes unknown afterwards (⊇ defs). Used by constant
//                  and copy propagation to invalidate. Must never under-claim, or stale values leak
//                  across a call.
// Anything not modelled here is `opaque`: a full barrier that is never deleted, never rewritten,
// and conservatively reads/writes the whole world.

import type { Instr, Operand } from './ir';

// Register indices with fixed roles.
export const ZERO = 0;
export const RA = 1;
export const SP = 2;
export const GP = 3;
export const TP = 4;
export const FP = 8;
export const S0 = 8; // x8 doubles as the frame pointer (alias of FP)

// Caller-saved (t0–t2, t3–t6, a0–a7): trashed across a call.
export const CALLER_SAVED: readonly number[] = [5, 6, 7, 28, 29, 30, 31, 10, 11, 12, 13, 14, 15, 16, 17];
// Registers a caller may observe after a function returns. Conservative — keeps epilogues alive.
export const LIVE_AT_RETURN: readonly number[] = [
  RA, SP, GP, TP, 10, 11, // ra, sp, gp, tp, a0, a1 (return value)
  8, 9, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, // s0–s11 (callee-saved, restored by epilogue)
];

export interface InstrInfo {
  defs: number[];
  uses: number[];
  clobbers: number[];
  memRead: boolean;
  memWrite: boolean;
  /** Cannot be deleted even if its def is dead (store, ecall, csr, fence, …). */
  sideEffect: boolean;
  /** Ends a basic block by transferring control unconditionally (j/ret/jr/mret/…). */
  isTerminator: boolean;
  /** A conditional branch (two successors: target + fall-through). */
  isBranch: boolean;
  /** A function call: links a return address and trashes caller-saved registers. */
  isCall: boolean;
  /** Label targets this instruction may branch/jump to (intra-function edges). */
  targets: string[];
  fallsThrough: boolean;
  /** Pure: deletable when its single destination register is dead. */
  eliminable: boolean;
  /** Mentions a float/vector register or is an opaque form — passes tread carefully. */
  opaque: boolean;
}

// Operand accessors (typed; return undefined when the shape doesn't match).
export function asReg(o: Operand | undefined): number | undefined {
  return o && o.kind === 'reg' ? o.n : undefined;
}
function regOf(o: Operand | undefined): number[] {
  const r = asReg(o);
  return r === undefined || r === ZERO ? [] : [r];
}
function memRegs(o: Operand | undefined): number[] {
  if (!o || o.kind !== 'mem') return [];
  return o.base === ZERO ? [] : [o.base];
}
function symTargets(ops: Operand[]): string[] {
  return ops.filter((o) => o.kind === 'sym').map((o) => (o as { name: string }).name);
}

// Form families. Each maps cleanly onto defs/uses.
const R_TYPE = new Set([
  'add', 'sub', 'sll', 'slt', 'sltu', 'xor', 'srl', 'sra', 'or', 'and',
  'mul', 'mulh', 'mulhsu', 'mulhu', 'div', 'divu', 'rem', 'remu',
  // Zb R-types (rd, rs1, rs2)
  'sh1add', 'sh2add', 'sh3add', 'andn', 'orn', 'xnor', 'min', 'minu', 'max', 'maxu',
  'rol', 'ror', 'clmul', 'clmulh', 'clmulr', 'bset', 'bclr', 'binv', 'bext', 'zext.h',
]);
const I_ARITH = new Set(['addi', 'slti', 'sltiu', 'xori', 'ori', 'andi']);
const I_SHIFT = new Set(['slli', 'srli', 'srai', 'rori', 'bseti', 'bclri', 'binvi', 'bexti']);
const LOADS = new Set(['lw', 'lh', 'lhu', 'lb', 'lbu']);
const STORES = new Set(['sw', 'sh', 'sb']);
const BRANCH = new Set(['beq', 'bne', 'blt', 'bge', 'bltu', 'bgeu']);
const BRANCH_Z = new Set(['beqz', 'bnez', 'blez', 'bgez', 'bltz', 'bgtz']);
const BRANCH_2 = new Set(['bgt', 'ble', 'bgtu', 'bleu']);
// Unary pure (rd, rs1).
const UNARY = new Set([
  'mv', 'neg', 'not', 'seqz', 'snez', 'sltz', 'sgtz',
  'clz', 'ctz', 'cpop', 'sext.b', 'sext.h', 'orc.b', 'rev8',
]);

function base(): InstrInfo {
  return {
    defs: [], uses: [], clobbers: [], memRead: false, memWrite: false, sideEffect: false,
    isTerminator: false, isBranch: false, isCall: false, targets: [], fallsThrough: true,
    eliminable: false, opaque: false,
  };
}

/** Does any operand name a float register? Such instructions stay opaque to the integer passes. */
function mentionsFloat(i: Instr): boolean {
  return i.operands.some((o) => o.kind === 'freg');
}

export function analyzeInstr(i: Instr): InstrInfo {
  const info = base();
  const ops = i.operands;
  const op = i.op;

  if (!i.known || mentionsFloat(i)) return opaque(i, info);

  if (R_TYPE.has(op)) {
    info.defs = regOf(ops[0]);
    info.uses = [...regOf(ops[1]), ...regOf(ops[2])];
    info.eliminable = true;
  } else if (I_ARITH.has(op) || I_SHIFT.has(op)) {
    info.defs = regOf(ops[0]);
    info.uses = regOf(ops[1]);
    info.eliminable = true;
  } else if (op === 'li') {
    info.defs = regOf(ops[0]);
    info.eliminable = true;
  } else if (op === 'lui' || op === 'auipc') {
    info.defs = regOf(ops[0]);
    info.eliminable = true; // auipc uses pc only — pure w.r.t. registers
  } else if (op === 'la') {
    info.defs = regOf(ops[0]);
    info.eliminable = true;
  } else if (UNARY.has(op)) {
    info.defs = regOf(ops[0]);
    info.uses = regOf(ops[1]);
    info.eliminable = true;
  } else if (LOADS.has(op)) {
    info.defs = regOf(ops[0]);
    info.uses = memRegs(ops[1]);
    info.memRead = true;
    // NOT eliminable: a load can trap (page fault under an active MMU, misalignment), which is an
    // observable control transfer, so a load with a dead result must still execute.
    info.eliminable = false;
  } else if (STORES.has(op)) {
    info.uses = [...regOf(ops[0]), ...memRegs(ops[1])];
    info.memWrite = true;
    info.sideEffect = true;
  } else if (BRANCH.has(op)) {
    info.uses = [...regOf(ops[0]), ...regOf(ops[1])];
    info.isBranch = true;
    info.targets = symTargets(ops);
  } else if (BRANCH_Z.has(op)) {
    info.uses = regOf(ops[0]);
    info.isBranch = true;
    info.targets = symTargets(ops);
  } else if (BRANCH_2.has(op)) {
    info.uses = [...regOf(ops[0]), ...regOf(ops[1])];
    info.isBranch = true;
    info.targets = symTargets(ops);
  } else if (op === 'j') {
    info.isTerminator = true;
    info.fallsThrough = false;
    info.targets = symTargets(ops);
  } else if (op === 'jal') {
    // `jal sym` (link ra) or `jal rd, sym`. rd === x0 ⇒ plain jump.
    const rd = ops.length === 2 ? asReg(ops[0]) : RA;
    info.targets = symTargets(ops);
    if (rd === ZERO || rd === undefined) {
      info.isTerminator = true;
      info.fallsThrough = false;
    } else {
      info.isCall = true;
      info.defs = [rd];
      info.clobbers = [...CALLER_SAVED];
      info.uses = [10, 11, 12, 13, 14, 15, 16, 17, SP]; // args may be in a0–a7 + stack
      info.sideEffect = true;
    }
  } else if (op === 'call') {
    info.isCall = true;
    info.defs = [RA];
    info.clobbers = [...CALLER_SAVED];
    info.uses = [10, 11, 12, 13, 14, 15, 16, 17, SP];
    info.targets = symTargets(ops);
    info.sideEffect = true;
  } else if (op === 'ret') {
    info.isTerminator = true;
    info.fallsThrough = false;
    info.uses = [...LIVE_AT_RETURN];
  } else if (op === 'jr') {
    info.isTerminator = true;
    info.fallsThrough = false;
    info.uses = regOf(ops[0]);
  } else if (op === 'jalr') {
    // jalr rd, rs1[, imm]  |  jalr rs1.  rd === x0 ⇒ indirect jump (terminator).
    let rd: number | undefined;
    let rs1: number | undefined;
    if (ops.length === 1) { rd = RA; rs1 = asReg(ops[0]); }
    else { rd = asReg(ops[0]); rs1 = asReg(ops[1]); }
    if (rd === ZERO) {
      info.isTerminator = true;
      info.fallsThrough = false;
      info.uses = [...regOf(rs1 === undefined ? undefined : { kind: 'reg', n: rs1 }), ...LIVE_AT_RETURN];
    } else {
      info.isCall = true;
      if (rd !== undefined && rd !== ZERO) info.defs = [rd];
      info.clobbers = [...CALLER_SAVED];
      info.uses = [...(rs1 !== undefined ? [rs1] : []), 10, 11, 12, 13, 14, 15, 16, 17, SP];
      info.sideEffect = true;
    }
  } else if (op === 'nop') {
    info.eliminable = true;
  } else if (op === 'ecall') {
    // A syscall: reads a7 (number) + a0–a6 (args), may write a0, and performs I/O.
    info.uses = [10, 11, 12, 13, 14, 15, 16, 17];
    info.clobbers = [10];
    info.sideEffect = true;
  } else if (op === 'ebreak' || op === 'mret' || op === 'sret') {
    info.isTerminator = true;
    info.fallsThrough = false;
    info.sideEffect = true;
  } else {
    return opaque(i, info);
  }

  // clobbers always ⊇ defs.
  if (info.clobbers.length === 0) info.clobbers = info.defs;
  return info;
}

// An instruction we do not model: a full barrier. We never delete or rewrite it; we keep its
// register operands live (conservative) and assume it can read/write memory and clobber its rd.
function opaque(i: Instr, info: InstrInfo): InstrInfo {
  info.opaque = true;
  info.sideEffect = true;
  info.memRead = true;
  info.memWrite = true;
  const regs = new Set<number>();
  for (const o of i.operands) {
    if (o.kind === 'reg' && o.n !== ZERO) regs.add(o.n);
    if (o.kind === 'mem' && o.base !== ZERO) regs.add(o.base);
  }
  info.uses = [...regs];
  info.clobbers = [...regs];
  return info;
}

/** The destination register of a simple single-def instruction, or undefined. */
export function destReg(i: Instr): number | undefined {
  const info = analyzeInstr(i);
  return info.defs.length === 1 ? info.defs[0] : undefined;
}
