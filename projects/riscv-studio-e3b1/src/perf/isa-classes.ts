// Per-instruction micro-architectural shape.
//
// The timing model needs to know, for each retired instruction, *which* register operands it
// genuinely reads and writes (and in which register file — integer `x` or float `f`), and what
// kind of functional unit it uses (load, store, branch, jump, multi-cycle ALU). The functional
// interpreter doesn't need any of this; it lives here as a pure, table-driven classifier so the
// hazard / forwarding / latency logic in `pipeline.ts` stays correct per instruction class.

import type { DecodedFormat } from '../vm/decode';
import { vmemSpec } from '../vm/vector';

/** Which register file an operand lives in. */
export type RegFile = 'x' | 'f';

/** A register operand: a file plus an index (0..31). */
export interface RegRef {
  file: RegFile;
  index: number;
}

/** The functional-unit / control character of an instruction. */
export type UnitKind =
  | 'alu' // single-cycle integer ALU (and most ops)
  | 'mul' // integer multiply (multi-cycle EX)
  | 'div' // integer divide/remainder (multi-cycle EX)
  | 'load' // memory load
  | 'store' // memory store
  | 'branch' // conditional branch (predicted)
  | 'jump' // unconditional jump: jal / jalr (predicted via BTB)
  | 'fpadd' // fp add/sub/convert/compare/min-max/sign (multi-cycle EX)
  | 'fpmul' // fp multiply / fused multiply-add (multi-cycle EX)
  | 'fpdiv' // fp divide / sqrt (long multi-cycle EX)
  | 'system'; // ecall/ebreak/csr/fence/mret/sret/wfi — no modelled data hazards

/** The decoded micro-op shape of one instruction (independent of its dynamic operands). */
export interface InstrClass {
  unit: UnitKind;
  /** Source operands actually read (used for RAW hazard detection). */
  srcs: RegRef[];
  /** Destination register written, or null when the instruction writes no register. */
  dst: RegRef | null;
  isMem: boolean;
  isLoad: boolean;
  isStore: boolean;
  /** A control-flow instruction the front-end predicts (branch or jump). */
  isControl: boolean;
  isBranch: boolean;
  isJump: boolean;
}

function x(index: number): RegRef {
  return { file: 'x', index };
}
function f(index: number): RegRef {
  return { file: 'f', index };
}

// Float ALU mnemonics whose two source operands are *float* registers.
const FP_RR_FLOAT_SRC = new Set([
  'fadd.s', 'fsub.s', 'fmul.s', 'fdiv.s', 'fmin.s', 'fmax.s',
  'fsgnj.s', 'fsgnjn.s', 'fsgnjx.s', 'feq.s', 'flt.s', 'fle.s',
]);

/**
 * Classify one retired instruction by mnemonic (and format, for the rare ambiguous cases).
 * `rd/rs1/rs2/rs3` are the decoded register fields; whether each is *used* and in which file
 * is what this function resolves.
 */
export function classify(
  mnemonic: string,
  format: DecodedFormat,
  rd: number,
  rs1: number,
  rs2: number,
  rs3: number,
): InstrClass {
  const base = (unit: UnitKind, srcs: RegRef[], dst: RegRef | null): InstrClass => ({
    unit,
    srcs,
    dst,
    isMem: unit === 'load' || unit === 'store',
    isLoad: unit === 'load',
    isStore: unit === 'store',
    isControl: unit === 'branch' || unit === 'jump',
    isBranch: unit === 'branch',
    isJump: unit === 'jump',
  });

  // ---- V (vector) extension --------------------------------------------------
  // The timing model doesn't track the vector register file, so vector ops carry no modelled
  // vector-register hazards. We still surface the integer-register traffic that matters: a vector
  // load/store reads the `x` base (so the cache model sees a real address) and the configuration /
  // element-move ops touch the `x` file as a normal ALU op would.
  if (format === 'V') {
    const mem = vmemSpec(mnemonic);
    if (mem) return base(mem.store ? 'store' : 'load', [x(rs1)], mem.store ? null : null);
    if (mnemonic === 'vsetvli' || mnemonic === 'vsetvl') return base('alu', [x(rs1)], x(rd));
    if (mnemonic === 'vsetivli') return base('alu', [], x(rd));
    if (mnemonic === 'vmv.x.s' || mnemonic === 'vcpop.m' || mnemonic === 'vfirst.m') {
      return base('alu', [], x(rd));
    }
    if (mnemonic === 'vmv.s.x') return base('alu', [x(rs1)], null);
    return base('alu', [], null);
  }

  switch (mnemonic) {
    // ---- U / control ----
    case 'lui':
    case 'auipc':
      return base('alu', [], x(rd));
    case 'jal':
      return base('jump', [], x(rd));
    case 'jalr':
      return base('jump', [x(rs1)], x(rd));
    case 'beq':
    case 'bne':
    case 'blt':
    case 'bge':
    case 'bltu':
    case 'bgeu':
      return base('branch', [x(rs1), x(rs2)], null);

    // ---- integer loads / stores ----
    case 'lb':
    case 'lh':
    case 'lw':
    case 'lbu':
    case 'lhu':
      return base('load', [x(rs1)], x(rd));
    case 'sb':
    case 'sh':
    case 'sw':
      return base('store', [x(rs1), x(rs2)], null);

    // ---- OP-IMM ----
    case 'addi':
    case 'slti':
    case 'sltiu':
    case 'xori':
    case 'ori':
    case 'andi':
    case 'slli':
    case 'srli':
    case 'srai':
      return base('alu', [x(rs1)], x(rd));

    // ---- OP (R-type) ----
    case 'add':
    case 'sub':
    case 'sll':
    case 'slt':
    case 'sltu':
    case 'xor':
    case 'srl':
    case 'sra':
    case 'or':
    case 'and':
      return base('alu', [x(rs1), x(rs2)], x(rd));

    // ---- M extension ----
    case 'mul':
    case 'mulh':
    case 'mulhu':
    case 'mulhsu':
      return base('mul', [x(rs1), x(rs2)], x(rd));
    case 'div':
    case 'divu':
    case 'rem':
    case 'remu':
      return base('div', [x(rs1), x(rs2)], x(rd));

    // ---- Zb (bit manipulation) ----
    // Carry-less multiply is a multi-cycle EX op (it shares the multiplier port); the rest are
    // single-cycle ALU ops. The single-operand forms read only rs1.
    case 'clmul':
    case 'clmulh':
    case 'clmulr':
      return base('mul', [x(rs1), x(rs2)], x(rd));
    case 'sh1add':
    case 'sh2add':
    case 'sh3add':
    case 'andn':
    case 'orn':
    case 'xnor':
    case 'min':
    case 'minu':
    case 'max':
    case 'maxu':
    case 'rol':
    case 'ror':
    case 'bclr':
    case 'bset':
    case 'binv':
    case 'bext':
      return base('alu', [x(rs1), x(rs2)], x(rd));
    case 'clz':
    case 'ctz':
    case 'cpop':
    case 'sext.b':
    case 'sext.h':
    case 'zext.h':
    case 'orc.b':
    case 'rev8':
    case 'rori':
    case 'bclri':
    case 'bseti':
    case 'binvi':
    case 'bexti':
      return base('alu', [x(rs1)], x(rd));

    // ---- A extension (treated as a load (lr) or store (sc / amo) for the cache) ----
    case 'lr.w':
      return base('load', [x(rs1)], x(rd));
    case 'sc.w':
      return base('store', [x(rs1), x(rs2)], x(rd));
    case 'amoswap.w':
    case 'amoadd.w':
    case 'amoxor.w':
    case 'amoand.w':
    case 'amoor.w':
    case 'amomin.w':
    case 'amomax.w':
    case 'amominu.w':
    case 'amomaxu.w':
      return base('store', [x(rs1), x(rs2)], x(rd));

    // ---- F extension ----
    case 'flw':
      return base('load', [x(rs1)], f(rd));
    case 'fsw':
      return base('store', [x(rs1), f(rs2)], null);
    case 'fmul.s':
      return base('fpmul', [f(rs1), f(rs2)], f(rd));
    case 'fdiv.s':
      return base('fpdiv', [f(rs1), f(rs2)], f(rd));
    case 'fsqrt.s':
      return base('fpdiv', [f(rs1)], f(rd));
    case 'fmadd.s':
    case 'fmsub.s':
    case 'fnmadd.s':
    case 'fnmsub.s':
      return base('fpmul', [f(rs1), f(rs2), f(rs3)], f(rd));
    case 'feq.s':
    case 'flt.s':
    case 'fle.s':
      return base('fpadd', [f(rs1), f(rs2)], x(rd)); // writes an integer register
    case 'fcvt.w.s':
    case 'fcvt.wu.s':
    case 'fmv.x.w':
    case 'fclass.s':
      return base('fpadd', [f(rs1)], x(rd));
    case 'fcvt.s.w':
    case 'fcvt.s.wu':
    case 'fmv.w.x':
      return base('fpadd', [x(rs1)], f(rd));
    case 'fadd.s':
    case 'fsub.s':
    case 'fmin.s':
    case 'fmax.s':
    case 'fsgnj.s':
    case 'fsgnjn.s':
    case 'fsgnjx.s':
      return base('fpadd', [f(rs1), f(rs2)], f(rd));

    // ---- Zicsr ----
    case 'csrrw':
    case 'csrrs':
    case 'csrrc':
      return base('alu', [x(rs1)], x(rd));
    case 'csrrwi':
    case 'csrrsi':
    case 'csrrci':
      return base('alu', [], x(rd));

    // ---- system / privileged: no modelled register hazards ----
    case 'ecall':
    case 'ebreak':
    case 'fence':
    case 'sfence.vma':
    case 'mret':
    case 'sret':
    case 'wfi':
      return base('system', [], null);

    default:
      // Unknown / unmodelled encoding: be conservative — a generic ALU op with the decoded
      // register fields, so it still participates sanely in hazard tracking.
      if (FP_RR_FLOAT_SRC.has(mnemonic)) return base('fpadd', [f(rs1), f(rs2)], f(rd));
      if (format === 'R') return base('alu', [x(rs1), x(rs2)], x(rd));
      if (format === 'I') return base('alu', [x(rs1)], x(rd));
      return base('alu', [], null);
  }
}
