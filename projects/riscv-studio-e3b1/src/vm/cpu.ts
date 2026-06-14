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
import {
  f32FromBits,
  bitsFromF32,
  fclass,
  toI32,
  toU32,
  fminBits,
  fmaxBits,
  FFLAG,
} from './fp';

export type RunStatus = 'idle' | 'paused' | 'halted' | 'error' | 'ebreak';

/** Everything needed to revert exactly one executed instruction. */
interface UndoStep {
  pc: number;
  cycles: number;
  status: RunStatus;
  error: string;
  exitCode: number;
  reservation: number;
  heapPtr: number;
  fcsr: number;
  outLen: number;
  reg?: { i: number; prev: number };
  freg?: { i: number; prev: number };
  mem?: { addr: number; prev: number[] };
}

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
  /** RV32F float registers, stored as raw 32-bit patterns (FLEN = 32, no NaN-boxing). */
  readonly fregs = new Uint32Array(32);
  /** Floating-point control & status register: frm = [7:5], fflags = [4:0]. */
  fcsr = 0;
  pc = 0;
  entry = 0;
  readonly mem = new Memory();
  cycles = 0;
  status: RunStatus = 'idle';
  error = '';
  exitCode = 0;
  output = '';

  /** Active LR/SC reservation address (RV32A), or -1 when none is held. */
  private reservation = -1;
  /** Bump pointer for the `sbrk` syscall heap, lazily initialised above .data. */
  heapPtr = 0;

  // --- time-travel: a bounded, per-instruction undo journal -----------------
  /** When true, every `step()` records a compact record so it can be reverted. */
  recordHistory = true;
  private static readonly UNDO_CAP = 4096;
  private undoBuf: (UndoStep | undefined)[] = new Array(Cpu.UNDO_CAP);
  private undoHead = 0; // index of the next slot to write
  private undoCount = 0; // how many valid records are buffered
  private rec: UndoStep | null = null; // the record being filled this step

  /** Reset registers + memory and load an assembled program image. */
  load(result: AssembleResult): void {
    this.regs.fill(0);
    this.mem.reset();
    for (const w of result.writes) {
      for (let i = 0; i < w.bytes.length; i++) this.mem.writeByte(w.addr + i, w.bytes[i]);
    }
    this.entry = result.entry;
    // The heap starts just above the end of .data, page-aligned.
    this.heapBase = (result.dataRange[1] + 0xfff) & ~0xfff;
    this.resetState();
  }

  /** Base of the sbrk heap (just above .data), captured at load time. */
  private heapBase = 0;

  /** Reset execution state (registers + pc) without touching loaded code/data. */
  resetState(): void {
    this.regs.fill(0);
    this.fregs.fill(0);
    this.fcsr = 0;
    this.regs[SP] = STACK_TOP | 0;
    this.regs[GP] = GLOBAL_POINTER | 0;
    this.pc = this.entry >>> 0;
    this.cycles = 0;
    this.reservation = -1;
    this.heapPtr = this.heapBase >>> 0;
    this.rngState = 0x9e37_79b9;
    this.status = 'idle';
    this.error = '';
    this.exitCode = 0;
    this.output = '';
    this.clearHistory();
  }

  /** Pause a running machine (used by the debugger's Stop button). */
  pause(): void {
    if (!this.isStopped()) this.status = 'paused';
  }

  print(text: string): void {
    this.output += text;
  }

  /** A small xorshift32 PRNG backing the rand syscalls (re-seeded on every reset). */
  private rngState = 0x9e37_79b9;
  nextRandom(): number {
    let x = this.rngState | 0;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rngState = x | 0;
    return x >>> 0;
  }

  fail(message: string): void {
    this.status = 'error';
    this.error = `${message} (pc=0x${(this.pc >>> 0).toString(16)})`;
  }

  private get(i: number): number {
    return this.regs[i];
  }
  private set(i: number, v: number): void {
    if (i === 0) return;
    if (this.rec) this.rec.reg = { i, prev: this.regs[i] };
    this.regs[i] = v | 0;
  }

  /** Write a float register (by raw bits), logging the prior value for time-travel. */
  private setF(i: number, bits: number): void {
    if (this.rec) this.rec.freg = { i, prev: this.fregs[i] };
    this.fregs[i] = bits >>> 0;
  }

  /** Snapshot the bytes a store is about to overwrite, then write the word/half/byte. */
  private storeWord(addr: number, value: number): void {
    this.recordMem(addr, 4);
    this.mem.writeWord(addr, value);
  }
  private recordMem(addr: number, size: number): void {
    if (!this.rec) return;
    const prev: number[] = [];
    for (let i = 0; i < size; i++) prev.push(this.mem.readByte(addr + i));
    this.rec.mem = { addr: addr >>> 0, prev };
  }

  /** OR accrued exception flags into fcsr[4:0]. */
  private flag(mask: number): void {
    this.fcsr |= mask & 0x1f;
  }

  /** Whether the machine has reached a state from which `step()` will not advance. */
  isStopped(): boolean {
    return this.status === 'halted' || this.status === 'error' || this.status === 'ebreak';
  }

  /** Execute one instruction. Returns false once the machine can no longer advance. */
  step(): boolean {
    if (this.status === 'halted' || this.status === 'error') return false;
    if (this.recordHistory) this.beginRecord();
    this.status = 'idle';
    const word = this.mem.readWord(this.pc);
    if (word === 0) {
      this.fail('illegal instruction 0x00000000 (ran off the end of the program?)');
      if (this.rec) this.commitRecord();
      return false;
    }
    const d = decode(word);
    const advanced = this.execute(d);
    this.cycles++;
    if (this.rec) this.commitRecord();
    if (this.isStopped()) return false;
    if (!advanced) this.pc = (this.pc + 4) >>> 0;
    return true;
  }

  // --- undo journal ---------------------------------------------------------

  private beginRecord(): void {
    this.rec = {
      pc: this.pc,
      cycles: this.cycles,
      status: this.status,
      error: this.error,
      exitCode: this.exitCode,
      reservation: this.reservation,
      heapPtr: this.heapPtr,
      fcsr: this.fcsr,
      outLen: this.output.length,
    };
  }

  private commitRecord(): void {
    const rec = this.rec;
    this.rec = null;
    if (!rec) return;
    this.undoBuf[this.undoHead] = rec;
    this.undoHead = (this.undoHead + 1) % Cpu.UNDO_CAP;
    if (this.undoCount < Cpu.UNDO_CAP) this.undoCount++;
  }

  /** How many instructions can currently be reverted with `stepBack()`. */
  historyDepth(): number {
    return this.undoCount;
  }

  clearHistory(): void {
    this.undoBuf = new Array(Cpu.UNDO_CAP);
    this.undoHead = 0;
    this.undoCount = 0;
    this.rec = null;
  }

  /** Revert exactly one instruction. Returns false when there is nothing to undo. */
  stepBack(): boolean {
    if (this.undoCount === 0) return false;
    this.undoHead = (this.undoHead - 1 + Cpu.UNDO_CAP) % Cpu.UNDO_CAP;
    const u = this.undoBuf[this.undoHead]!;
    this.undoBuf[this.undoHead] = undefined;
    this.undoCount--;

    if (u.reg) this.regs[u.reg.i] = u.reg.prev | 0;
    if (u.freg) this.fregs[u.freg.i] = u.freg.prev >>> 0;
    if (u.mem) for (let i = 0; i < u.mem.prev.length; i++) this.mem.writeByte(u.mem.addr + i, u.mem.prev[i]);
    this.pc = u.pc >>> 0;
    this.cycles = u.cycles;
    this.status = u.status;
    this.error = u.error;
    this.exitCode = u.exitCode;
    this.reservation = u.reservation;
    this.heapPtr = u.heapPtr;
    this.fcsr = u.fcsr;
    if (u.outLen < this.output.length) this.output = this.output.slice(0, u.outLen);
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
    if (d.format === 'FP') return this.executeFp(d);
    if (d.format === 'AMO') return this.executeAmo(d);
    if (d.format === 'CSR') return this.executeCsr(d);

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
      case 'sb': {
        const addr = (a + imm) >>> 0;
        this.recordMem(addr, 1);
        this.mem.writeByte(addr, b & 0xff);
        return false;
      }
      case 'sh': {
        const addr = (a + imm) >>> 0;
        this.recordMem(addr, 2);
        this.mem.writeHalf(addr, b & 0xffff);
        return false;
      }
      case 'sw':
        this.storeWord((a + imm) >>> 0, b);
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

  // ---- RV32F: single-precision floating point -----------------------------

  /** Resolve a static rounding mode (funct3); 7 = dynamic → read frm from fcsr. */
  private rmOf(d: DecodedInstruction): number {
    return d.funct3 === 7 ? (this.fcsr >>> 5) & 7 : d.funct3;
  }

  private executeFp(d: DecodedInstruction): boolean {
    const fa = this.fregs[d.rs1];
    const fb = this.fregs[d.rs2];
    const a = f32FromBits(fa);
    const b = f32FromBits(fb);

    switch (d.mnemonic) {
      case 'flw':
        this.setF(d.rd, this.mem.readWord((this.get(d.rs1) + d.imm) >>> 0));
        return false;
      case 'fsw':
        this.storeWord((this.get(d.rs1) + d.imm) >>> 0, this.fregs[d.rs2]);
        return false;

      case 'fadd.s':
        this.setF(d.rd, bitsFromF32(a + b));
        return false;
      case 'fsub.s':
        this.setF(d.rd, bitsFromF32(a - b));
        return false;
      case 'fmul.s':
        this.setF(d.rd, bitsFromF32(a * b));
        return false;
      case 'fdiv.s':
        if (b === 0 && !Number.isNaN(a)) this.flag(FFLAG.DZ);
        this.setF(d.rd, bitsFromF32(a / b));
        return false;
      case 'fsqrt.s':
        if (a < 0) this.flag(FFLAG.NV);
        this.setF(d.rd, bitsFromF32(Math.sqrt(a)));
        return false;

      case 'fsgnj.s':
        this.setF(d.rd, (fa & 0x7fff_ffff) | (fb & 0x8000_0000));
        return false;
      case 'fsgnjn.s':
        this.setF(d.rd, (fa & 0x7fff_ffff) | (~fb & 0x8000_0000));
        return false;
      case 'fsgnjx.s':
        this.setF(d.rd, fa ^ (fb & 0x8000_0000));
        return false;

      case 'fmin.s': {
        const r = fminBits(fa, fb);
        if (r.invalid) this.flag(FFLAG.NV);
        this.setF(d.rd, r.bits);
        return false;
      }
      case 'fmax.s': {
        const r = fmaxBits(fa, fb);
        if (r.invalid) this.flag(FFLAG.NV);
        this.setF(d.rd, r.bits);
        return false;
      }

      case 'feq.s':
        this.set(d.rd, a === b ? 1 : 0);
        return false;
      case 'flt.s':
        if (Number.isNaN(a) || Number.isNaN(b)) this.flag(FFLAG.NV);
        this.set(d.rd, a < b ? 1 : 0);
        return false;
      case 'fle.s':
        if (Number.isNaN(a) || Number.isNaN(b)) this.flag(FFLAG.NV);
        this.set(d.rd, a <= b ? 1 : 0);
        return false;

      case 'fcvt.w.s': {
        const r = toI32(a, this.rmOf(d));
        if (r.invalid) this.flag(FFLAG.NV);
        this.set(d.rd, r.value);
        return false;
      }
      case 'fcvt.wu.s': {
        const r = toU32(a, this.rmOf(d));
        if (r.invalid) this.flag(FFLAG.NV);
        this.set(d.rd, r.value);
        return false;
      }
      case 'fcvt.s.w':
        this.setF(d.rd, bitsFromF32(this.get(d.rs1) | 0));
        return false;
      case 'fcvt.s.wu':
        this.setF(d.rd, bitsFromF32(this.get(d.rs1) >>> 0));
        return false;

      case 'fmv.x.w':
        this.set(d.rd, fa | 0);
        return false;
      case 'fmv.w.x':
        this.setF(d.rd, this.get(d.rs1) >>> 0);
        return false;
      case 'fclass.s':
        this.set(d.rd, fclass(fa));
        return false;

      case 'fmadd.s':
        this.setF(d.rd, bitsFromF32(a * b + f32FromBits(this.fregs[d.rs3])));
        return false;
      case 'fmsub.s':
        this.setF(d.rd, bitsFromF32(a * b - f32FromBits(this.fregs[d.rs3])));
        return false;
      case 'fnmsub.s':
        this.setF(d.rd, bitsFromF32(-(a * b) + f32FromBits(this.fregs[d.rs3])));
        return false;
      case 'fnmadd.s':
        this.setF(d.rd, bitsFromF32(-(a * b) - f32FromBits(this.fregs[d.rs3])));
        return false;

      default:
        this.fail(`illegal / unimplemented FP instruction (0x${d.raw.toString(16).padStart(8, '0')})`);
        return false;
    }
  }

  // ---- RV32A: atomic memory operations (single-hart, so trivially atomic) ---

  private executeAmo(d: DecodedInstruction): boolean {
    const addr = this.get(d.rs1) >>> 0;
    if (addr & 3) {
      this.fail(`misaligned atomic access at 0x${addr.toString(16)}`);
      return false;
    }
    if (d.mnemonic === 'lr.w') {
      this.set(d.rd, this.mem.readWord(addr) | 0);
      this.reservation = addr;
      return false;
    }
    if (d.mnemonic === 'sc.w') {
      // Success only if the reservation is still held for this exact address.
      if (this.reservation === addr) {
        this.storeWord(addr, this.get(d.rs2));
        this.set(d.rd, 0); // 0 = success
      } else {
        this.set(d.rd, 1); // 1 = failure
      }
      this.reservation = -1;
      return false;
    }

    // amo*: atomically load, combine with rs2, store back, return the old value in rd.
    const old = this.mem.readWord(addr) | 0;
    const src = this.get(d.rs2) | 0;
    let result: number;
    switch (d.mnemonic) {
      case 'amoswap.w':
        result = src;
        break;
      case 'amoadd.w':
        result = (old + src) | 0;
        break;
      case 'amoxor.w':
        result = old ^ src;
        break;
      case 'amoand.w':
        result = old & src;
        break;
      case 'amoor.w':
        result = old | src;
        break;
      case 'amomin.w':
        result = old < src ? old : src;
        break;
      case 'amomax.w':
        result = old > src ? old : src;
        break;
      case 'amominu.w':
        result = (old >>> 0) < (src >>> 0) ? old : src;
        break;
      case 'amomaxu.w':
        result = (old >>> 0) > (src >>> 0) ? old : src;
        break;
      default:
        this.fail(`illegal / unimplemented atomic (0x${d.raw.toString(16).padStart(8, '0')})`);
        return false;
    }
    this.storeWord(addr, result);
    this.set(d.rd, old);
    this.reservation = -1;
    return false;
  }

  // ---- Zicsr: control & status registers + hardware counters ---------------

  private readCsr(addr: number): number {
    switch (addr) {
      case 0x001:
        return this.fcsr & 0x1f; // fflags
      case 0x002:
        return (this.fcsr >>> 5) & 7; // frm
      case 0x003:
        return this.fcsr & 0xff; // fcsr
      case 0xc00: // cycle
      case 0xc01: // time (mirrors cycle here — deterministic)
      case 0xc02: // instret (one retired per cycle)
        return this.cycles >>> 0;
      case 0xc80:
      case 0xc81:
      case 0xc82:
        return Math.floor(this.cycles / 0x1_0000_0000) >>> 0;
      default:
        return 0; // unimplemented CSRs read as zero
    }
  }

  private writeCsr(addr: number, value: number): void {
    const v = value >>> 0;
    switch (addr) {
      case 0x001:
        this.fcsr = (this.fcsr & ~0x1f) | (v & 0x1f);
        break;
      case 0x002:
        this.fcsr = (this.fcsr & ~0xe0) | ((v & 7) << 5);
        break;
      case 0x003:
        this.fcsr = v & 0xff;
        break;
      default:
        break; // counters / unknown CSRs ignore writes
    }
  }

  private executeCsr(d: DecodedInstruction): boolean {
    const addr = d.imm & 0xfff;
    const old = this.readCsr(addr);
    // For the immediate variants the 5-bit zimm rides in the rs1 field.
    const imm = d.rs1 & 0x1f;
    switch (d.mnemonic) {
      case 'csrrw':
        this.writeCsr(addr, this.get(d.rs1));
        this.set(d.rd, old | 0);
        break;
      case 'csrrs':
        if (d.rs1 !== 0) this.writeCsr(addr, old | this.get(d.rs1));
        this.set(d.rd, old | 0);
        break;
      case 'csrrc':
        if (d.rs1 !== 0) this.writeCsr(addr, old & ~this.get(d.rs1));
        this.set(d.rd, old | 0);
        break;
      case 'csrrwi':
        this.writeCsr(addr, imm);
        this.set(d.rd, old | 0);
        break;
      case 'csrrsi':
        if (imm !== 0) this.writeCsr(addr, old | imm);
        this.set(d.rd, old | 0);
        break;
      case 'csrrci':
        if (imm !== 0) this.writeCsr(addr, old & ~imm);
        this.set(d.rd, old | 0);
        break;
      default:
        this.fail(`illegal / unimplemented CSR op (0x${d.raw.toString(16).padStart(8, '0')})`);
        break;
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
