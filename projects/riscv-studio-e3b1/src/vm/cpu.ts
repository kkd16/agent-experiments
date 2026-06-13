// The RV32IM interpreter.
//
// A `Cpu` owns 32 integer registers, a program counter, and a paged memory. `step()` runs
// exactly one instruction (fetch → decode → execute) and is the single primitive the
// debugger drives; `run()` batches steps with a budget and breakpoint set.

import { Memory } from './memory';
import { decode } from './decode';
import type { DecodedInstruction } from './decode';
import { handleEcall } from './syscalls';
import { signExtend } from './format';
import {
  GLOBAL_POINTER,
  STACK_TOP,
  DEFAULT_MAX_STEPS,
} from './constants';
import type { AssembleResult } from './assembler';

export type RunStatus = 'idle' | 'paused' | 'halted' | 'error' | 'ebreak';

const SP = 2;
const GP = 3;

/** 64-bit-correct high words of a 32×32 multiply, via BigInt. */
function mulhss(a: number, b: number): number {
  return Number((BigInt(a | 0) * BigInt(b | 0)) >> 32n) | 0;
}
function mulhuu(a: number, b: number): number {
  return Number((BigInt(a >>> 0) * BigInt(b >>> 0)) >> 32n) | 0;
}
function mulhsu(a: number, b: number): number {
  return Number((BigInt(a | 0) * BigInt(b >>> 0)) >> 32n) | 0;
}

export class Cpu {
  readonly regs = new Int32Array(32);
  pc = 0;
  entry = 0;
  readonly mem = new Memory();
  cycles = 0;
  status: RunStatus = 'idle';
  error = '';
  exitCode = 0;
  output = '';

  /** Reset registers + memory and load an assembled program image. */
  load(result: AssembleResult): void {
    this.regs.fill(0);
    this.mem.reset();
    for (const w of result.writes) {
      for (let i = 0; i < w.bytes.length; i++) this.mem.writeByte(w.addr + i, w.bytes[i]);
    }
    this.entry = result.entry;
    this.resetState();
  }

  /** Reset execution state (registers + pc) without touching loaded code/data. */
  resetState(): void {
    this.regs.fill(0);
    this.regs[SP] = STACK_TOP | 0;
    this.regs[GP] = GLOBAL_POINTER | 0;
    this.pc = this.entry >>> 0;
    this.cycles = 0;
    this.status = 'idle';
    this.error = '';
    this.exitCode = 0;
    this.output = '';
  }

  /** Pause a running machine (used by the debugger's Stop button). */
  pause(): void {
    if (!this.isStopped()) this.status = 'paused';
  }

  print(text: string): void {
    this.output += text;
  }

  fail(message: string): void {
    this.status = 'error';
    this.error = `${message} (pc=0x${(this.pc >>> 0).toString(16)})`;
  }

  private get(i: number): number {
    return this.regs[i];
  }
  private set(i: number, v: number): void {
    if (i !== 0) this.regs[i] = v | 0;
  }

  /** Whether the machine has reached a state from which `step()` will not advance. */
  isStopped(): boolean {
    return this.status === 'halted' || this.status === 'error' || this.status === 'ebreak';
  }

  /** Execute one instruction. Returns false once the machine can no longer advance. */
  step(): boolean {
    if (this.status === 'halted' || this.status === 'error') return false;
    this.status = 'idle';
    const word = this.mem.readWord(this.pc);
    if (word === 0) {
      this.fail('illegal instruction 0x00000000 (ran off the end of the program?)');
      return false;
    }
    const d = decode(word);
    const advanced = this.execute(d);
    this.cycles++;
    if (this.isStopped()) return false;
    if (!advanced) this.pc = (this.pc + 4) >>> 0;
    return true;
  }

  /**
   * Run up to `budget` instructions, stopping early on halt/error/ebreak or when the pc
   * reaches an address in `breakpoints`. Returns the number of instructions executed.
   */
  run(budget = DEFAULT_MAX_STEPS, breakpoints?: ReadonlySet<number>): number {
    let n = 0;
    while (n < budget) {
      if (!this.step()) break;
      n++;
      if (breakpoints && breakpoints.has(this.pc >>> 0)) {
        this.status = 'paused';
        break;
      }
    }
    return n;
  }

  /** Execute a decoded instruction. Returns true if it set the pc itself (jump/branch). */
  private execute(d: DecodedInstruction): boolean {
    const { rd, rs1, rs2, imm } = d;
    const a = this.get(rs1);
    const b = this.get(rs2);

    switch (d.mnemonic) {
      // ---- U / AUIPC --------------------------------------------------
      case 'lui':
        this.set(rd, imm);
        return false;
      case 'auipc':
        this.set(rd, (this.pc + imm) | 0);
        return false;

      // ---- jumps ------------------------------------------------------
      case 'jal':
        this.set(rd, (this.pc + 4) | 0);
        this.pc = (this.pc + imm) >>> 0;
        return true;
      case 'jalr': {
        const target = ((a + imm) & ~1) >>> 0;
        this.set(rd, (this.pc + 4) | 0);
        this.pc = target;
        return true;
      }

      // ---- branches ---------------------------------------------------
      case 'beq':
        return this.branch(a === b, imm);
      case 'bne':
        return this.branch(a !== b, imm);
      case 'blt':
        return this.branch(a < b, imm);
      case 'bge':
        return this.branch(a >= b, imm);
      case 'bltu':
        return this.branch((a >>> 0) < (b >>> 0), imm);
      case 'bgeu':
        return this.branch((a >>> 0) >= (b >>> 0), imm);

      // ---- loads ------------------------------------------------------
      case 'lb':
        this.set(rd, signExtend(this.mem.readByte((a + imm) >>> 0), 8));
        return false;
      case 'lh':
        this.set(rd, signExtend(this.mem.readHalf((a + imm) >>> 0), 16));
        return false;
      case 'lw':
        this.set(rd, this.mem.readWord((a + imm) >>> 0) | 0);
        return false;
      case 'lbu':
        this.set(rd, this.mem.readByte((a + imm) >>> 0));
        return false;
      case 'lhu':
        this.set(rd, this.mem.readHalf((a + imm) >>> 0));
        return false;

      // ---- stores -----------------------------------------------------
      case 'sb':
        this.mem.writeByte((a + imm) >>> 0, b & 0xff);
        return false;
      case 'sh':
        this.mem.writeHalf((a + imm) >>> 0, b & 0xffff);
        return false;
      case 'sw':
        this.mem.writeWord((a + imm) >>> 0, b);
        return false;

      // ---- OP-IMM -----------------------------------------------------
      case 'addi':
        this.set(rd, (a + imm) | 0);
        return false;
      case 'slti':
        this.set(rd, a < imm ? 1 : 0);
        return false;
      case 'sltiu':
        this.set(rd, (a >>> 0) < (imm >>> 0) ? 1 : 0);
        return false;
      case 'xori':
        this.set(rd, a ^ imm);
        return false;
      case 'ori':
        this.set(rd, a | imm);
        return false;
      case 'andi':
        this.set(rd, a & imm);
        return false;
      case 'slli':
        this.set(rd, a << (rs2 & 31));
        return false;
      case 'srli':
        this.set(rd, a >>> (rs2 & 31));
        return false;
      case 'srai':
        this.set(rd, a >> (rs2 & 31));
        return false;

      // ---- OP (R-type) ------------------------------------------------
      case 'add':
        this.set(rd, (a + b) | 0);
        return false;
      case 'sub':
        this.set(rd, (a - b) | 0);
        return false;
      case 'sll':
        this.set(rd, a << (b & 31));
        return false;
      case 'slt':
        this.set(rd, a < b ? 1 : 0);
        return false;
      case 'sltu':
        this.set(rd, (a >>> 0) < (b >>> 0) ? 1 : 0);
        return false;
      case 'xor':
        this.set(rd, a ^ b);
        return false;
      case 'srl':
        this.set(rd, a >>> (b & 31));
        return false;
      case 'sra':
        this.set(rd, a >> (b & 31));
        return false;
      case 'or':
        this.set(rd, a | b);
        return false;
      case 'and':
        this.set(rd, a & b);
        return false;

      // ---- M extension ------------------------------------------------
      case 'mul':
        this.set(rd, Math.imul(a, b));
        return false;
      case 'mulh':
        this.set(rd, mulhss(a, b));
        return false;
      case 'mulhu':
        this.set(rd, mulhuu(a, b));
        return false;
      case 'mulhsu':
        this.set(rd, mulhsu(a, b));
        return false;
      case 'div':
        this.set(rd, this.idiv(a, b));
        return false;
      case 'divu':
        this.set(rd, this.udiv(a, b));
        return false;
      case 'rem':
        this.set(rd, this.irem(a, b));
        return false;
      case 'remu':
        this.set(rd, this.urem(a, b));
        return false;

      // ---- system -----------------------------------------------------
      case 'ecall': {
        const r = handleEcall(this);
        if (r === 'halt' && this.status !== 'error') this.status = 'halted';
        return false;
      }
      case 'ebreak':
        this.status = 'ebreak';
        return false;
      case 'fence':
        return false;

      default:
        this.fail(`illegal / unimplemented instruction (0x${d.raw.toString(16).padStart(8, '0')})`);
        return false;
    }
  }

  private branch(taken: boolean, imm: number): boolean {
    if (taken) {
      this.pc = (this.pc + imm) >>> 0;
      return true;
    }
    return false;
  }

  // RISC-V division semantics: defined results for divide-by-zero and signed overflow.
  private idiv(a: number, b: number): number {
    if (b === 0) return -1;
    if (a === -2147483648 && b === -1) return -2147483648;
    return (a / b) | 0;
  }
  private udiv(a: number, b: number): number {
    if (b === 0) return -1; // 0xffffffff
    return ((a >>> 0) / (b >>> 0)) >>> 0 | 0;
  }
  private irem(a: number, b: number): number {
    if (b === 0) return a;
    if (a === -2147483648 && b === -1) return 0;
    return (a % b) | 0;
  }
  private urem(a: number, b: number): number {
    if (b === 0) return a;
    return ((a >>> 0) % (b >>> 0)) | 0;
  }
}
