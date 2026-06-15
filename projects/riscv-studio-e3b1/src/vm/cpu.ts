// The RV32IM interpreter.
//
// A `Cpu` owns 32 integer registers, a program counter, and a paged memory. `step()` runs
// exactly one instruction (fetch → decode → execute) and is the single primitive the
// debugger drives; `run()` batches steps with a budget and breakpoint set.

import { Memory } from './memory';
import { decode } from './decode';
import type { DecodedInstruction } from './decode';
import { isCompressed, expandCompressed } from './rvc';
import { handleEcall } from './syscalls';
import { signExtend } from './format';
import {
  GLOBAL_POINTER,
  STACK_TOP,
  DEFAULT_MAX_STEPS,
  CLINT_MSIP,
  CLINT_MTIMECMP,
  CLINT_MTIME,
  CLINT_BASE,
  CLINT_END,
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
  /** Snapshot of the machine-mode trap + CLINT state (changes most steps via mtime). */
  priv: number[];
  reg?: { i: number; prev: number };
  freg?: { i: number; prev: number };
  mem?: { addr: number; prev: number[] };
}

const SP = 2;
const GP = 3;

// mstatus / mie / mip bit positions (machine mode).
const MSTATUS_MIE = 1 << 3;
const MSTATUS_MPIE = 1 << 7;
const MSTATUS_MPP = 3 << 11; // M-mode previous privilege (always 0b11 here)
const IRQ_MSI = 1 << 3; // machine software interrupt
const IRQ_MTI = 1 << 7; // machine timer interrupt
const IRQ_MEI = 1 << 11; // machine external interrupt
const MSTATUS_WMASK = MSTATUS_MIE | MSTATUS_MPIE | MSTATUS_MPP;
const MIE_WMASK = IRQ_MSI | IRQ_MTI | IRQ_MEI;

// Synchronous exception causes.
const EXC_ILLEGAL = 2;
const EXC_BREAKPOINT = 3;

// RV32IMAFC misa: MXL=1 (bits 31:30) + extension bits A,C,F,I,M.
const MISA_RV32IMAFC = 0x4000_0000 | (1 << 0) | (1 << 2) | (1 << 5) | (1 << 8) | (1 << 12);

// Reset value for mtimecmp. Its high word is zero, so the common "write only the low word"
// idiom yields a usable compare; until a program sets it, the timer won't fire within any
// realistic instruction budget (it would take ~4 billion ticks).
const MTIMECMP_NEVER = 0xffff_ffff;

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

  // --- machine-mode trap state (Zicsr privileged subset) --------------------
  mstatus = 0; // global interrupt-enable stack (MIE / MPIE / MPP)
  mie = 0; // per-source interrupt enables
  mip = 0; // per-source interrupt pending
  mtvec = 0; // trap-vector base (+ mode in the low 2 bits)
  mepc = 0; // pc saved on a trap
  mcause = 0; // trap cause (top bit = interrupt)
  mtval = 0; // faulting value (bad address / instruction bits)
  mscratch = 0; // a scratch word for trap handlers

  // --- CLINT (memory-mapped timer + software interrupt) ---------------------
  /** Monotonic time; ticks once per retired instruction so timers are deterministic. */
  mtime = 0;
  /** Timer compare; a timer interrupt is pending while mtime ≥ mtimecmp. */
  mtimecmp = MTIMECMP_NEVER;
  /** Software-interrupt pending bit (CLINT msip register). */
  msip = 0;

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
    this.mstatus = 0;
    this.mie = 0;
    this.mip = 0;
    this.mtvec = 0;
    this.mepc = 0;
    this.mcause = 0;
    this.mtval = 0;
    this.mscratch = 0;
    this.mtime = 0;
    this.mtimecmp = MTIMECMP_NEVER;
    this.msip = 0;
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

    // Advance the timer one tick and refresh the CLINT-driven pending bits, then take an
    // asynchronous interrupt at this instruction boundary if one is enabled + pending.
    this.tickClint();
    if (this.takeInterruptIfPending()) {
      this.cycles++;
      if (this.rec) this.commitRecord();
      return true;
    }

    // Variable-length fetch: the low 2 bits of the first half-word select 16- vs 32-bit.
    const half = this.mem.readHalf(this.pc) & 0xffff;
    let d: DecodedInstruction;
    let size: number;
    if (isCompressed(half)) {
      const expanded = expandCompressed(half);
      if (expanded === null) {
        return this.fetchFault(half, `illegal compressed instruction 0x${half.toString(16).padStart(4, '0')}`);
      }
      d = decode(expanded);
      size = 2;
    } else {
      const word = this.mem.readWord(this.pc);
      if (word === 0) {
        return this.fetchFault(0, 'illegal instruction 0x00000000 (ran off the end of the program?)');
      }
      d = decode(word);
      size = 4;
    }

    const advanced = this.execute(d, size);
    this.cycles++;
    if (this.rec) this.commitRecord();
    if (this.isStopped()) return false;
    if (!advanced) this.pc = (this.pc + size) >>> 0;
    return true;
  }

  /** An un-decodable fetch: vector to the trap handler if one is armed, else fail. */
  private fetchFault(badBits: number, message: string): boolean {
    const trapped = this.trapOrFail(EXC_ILLEGAL, badBits, message);
    this.cycles++;
    if (this.rec) this.commitRecord();
    return trapped;
  }

  // --- machine-mode traps & interrupts --------------------------------------

  /** True once a handler base has been installed in mtvec. */
  private trapsArmed(): boolean {
    return (this.mtvec >>> 0) !== 0;
  }

  /** Advance mtime and recompute the timer/software interrupt-pending bits. */
  private tickClint(): void {
    this.mtime += 1;
    if (this.mtime >= this.mtimecmp) this.mip |= IRQ_MTI;
    else this.mip &= ~IRQ_MTI;
    if (this.msip & 1) this.mip |= IRQ_MSI;
    else this.mip &= ~IRQ_MSI;
  }

  /** Take the highest-priority enabled+pending interrupt, if any. Returns true if taken. */
  private takeInterruptIfPending(): boolean {
    if (!this.trapsArmed() || (this.mstatus & MSTATUS_MIE) === 0) return false;
    const pending = this.mip & this.mie;
    if (pending === 0) return false;
    let cause: number;
    if (pending & IRQ_MEI) cause = 11;
    else if (pending & IRQ_MSI) cause = 3;
    else if (pending & IRQ_MTI) cause = 7;
    else return false;
    this.takeTrap(cause, 0, true, this.pc);
    return true;
  }

  /** Enter machine-mode trap handling: save state and vector to mtvec. */
  private takeTrap(cause: number, tval: number, isInterrupt: boolean, epc: number): void {
    this.mepc = epc >>> 0;
    this.mcause = ((isInterrupt ? 0x8000_0000 : 0) | (cause & 0x7fff_ffff)) | 0;
    this.mtval = tval | 0;
    // Push the interrupt-enable stack: MPIE ← MIE, MIE ← 0, MPP ← M.
    const mie = this.mstatus & MSTATUS_MIE ? MSTATUS_MPIE : 0;
    this.mstatus = ((this.mstatus & ~MSTATUS_MPIE) | mie) & ~MSTATUS_MIE;
    this.mstatus |= MSTATUS_MPP;
    const base = this.mtvec & ~0x3;
    const vectored = (this.mtvec & 0x3) === 1;
    this.pc = (isInterrupt && vectored ? base + 4 * cause : base) >>> 0;
  }

  /** Synchronous fault: vector to mtvec if armed (returns true), else fail (returns false). */
  private trapOrFail(cause: number, tval: number, message: string): boolean {
    if (this.trapsArmed()) {
      this.takeTrap(cause, tval, false, this.pc);
      return true;
    }
    this.fail(message);
    return false;
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
      priv: this.snapshotPriv(),
    };
  }

  /** Bundle the privileged trap + CLINT registers for the undo journal. */
  private snapshotPriv(): number[] {
    return [
      this.mstatus, this.mie, this.mip, this.mtvec, this.mepc, this.mcause,
      this.mtval, this.mscratch, this.mtime, this.mtimecmp, this.msip,
    ];
  }

  private restorePriv(p: number[]): void {
    this.mstatus = p[0];
    this.mie = p[1];
    this.mip = p[2];
    this.mtvec = p[3];
    this.mepc = p[4];
    this.mcause = p[5];
    this.mtval = p[6];
    this.mscratch = p[7];
    this.mtime = p[8];
    this.mtimecmp = p[9];
    this.msip = p[10];
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
    this.restorePriv(u.priv);
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

  /**
   * Execute a decoded instruction. Returns true if it set the pc itself (jump/branch).
   * `size` is the encoded length (2 for a compressed instruction, 4 otherwise) so that
   * link instructions record the correct return address.
   */
  private execute(d: DecodedInstruction, size = 4): boolean {
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
        this.set(rd, (this.pc + size) | 0);
        this.pc = (this.pc + imm) >>> 0;
        return true;
      case 'jalr': {
        const target = ((a + imm) & ~1) >>> 0;
        this.set(rd, (this.pc + size) | 0);
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
        this.set(rd, this.readWordIO((a + imm) >>> 0) | 0);
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
      case 'sw': {
        const addr = (a + imm) >>> 0;
        if (!this.writeWordIO(addr, b)) this.storeWord(addr, b);
        return false;
      }

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
        // With a handler armed, ebreak is a synchronous breakpoint trap; otherwise it pauses.
        if (this.trapsArmed()) {
          this.takeTrap(EXC_BREAKPOINT, this.pc, false, this.pc);
          return true;
        }
        this.status = 'ebreak';
        return false;
      case 'fence':
        return false;

      // ---- privileged trap return / hint ------------------------------
      case 'mret': {
        // Pop the interrupt-enable stack: MIE ← MPIE, MPIE ← 1, MPP ← least-privileged.
        const mpie = this.mstatus & MSTATUS_MPIE ? MSTATUS_MIE : 0;
        this.mstatus = ((this.mstatus & ~MSTATUS_MIE) | mpie) | MSTATUS_MPIE;
        this.mstatus &= ~MSTATUS_MPP;
        this.pc = this.mepc >>> 0;
        return true;
      }
      case 'wfi':
        // Deterministic model: just retire; the timer keeps ticking, so any armed interrupt
        // arrives on a subsequent step.
        return false;

      default:
        return this.trapOrFail(
          EXC_ILLEGAL,
          d.raw,
          `illegal / unimplemented instruction (0x${d.raw.toString(16).padStart(8, '0')})`,
        );
    }
  }

  // ---- CLINT memory-mapped I/O (timer + software interrupt) ----------------

  /** A word load with CLINT register interception (mtime/mtimecmp/msip). */
  private readWordIO(addr: number): number {
    addr = addr >>> 0;
    if (addr < CLINT_BASE || addr >= CLINT_END) return this.mem.readWord(addr);
    switch (addr) {
      case CLINT_MSIP:
        return this.msip & 1;
      case CLINT_MTIMECMP:
        return this.mtimecmp >>> 0;
      case CLINT_MTIMECMP + 4:
        return Math.floor(this.mtimecmp / 0x1_0000_0000) >>> 0;
      case CLINT_MTIME:
        return this.mtime >>> 0;
      case CLINT_MTIME + 4:
        return Math.floor(this.mtime / 0x1_0000_0000) >>> 0;
      default:
        return this.mem.readWord(addr);
    }
  }

  /** A word store with CLINT register interception. Returns true if the address was a CLINT reg. */
  private writeWordIO(addr: number, value: number): boolean {
    addr = addr >>> 0;
    if (addr < CLINT_BASE || addr >= CLINT_END) return false;
    const v = value >>> 0;
    const HI = 0x1_0000_0000;
    switch (addr) {
      case CLINT_MSIP:
        this.msip = v & 1;
        return true;
      case CLINT_MTIMECMP:
        this.mtimecmp = Math.floor(this.mtimecmp / HI) * HI + v;
        return true;
      case CLINT_MTIMECMP + 4:
        this.mtimecmp = v * HI + (this.mtimecmp >>> 0);
        return true;
      case CLINT_MTIME:
        this.mtime = Math.floor(this.mtime / HI) * HI + v;
        return true;
      case CLINT_MTIME + 4:
        this.mtime = v * HI + (this.mtime >>> 0);
        return true;
      default:
        // Unmapped CLINT word: ignore the write (reads return 0 via the paged memory).
        return true;
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
      // Machine-mode trap CSRs
      case 0x300:
        return this.mstatus | 0;
      case 0x301:
        return MISA_RV32IMAFC | 0;
      case 0x304:
        return this.mie | 0;
      case 0x305:
        return this.mtvec | 0;
      case 0x340:
        return this.mscratch | 0;
      case 0x341:
        return this.mepc | 0;
      case 0x342:
        return this.mcause | 0;
      case 0x343:
        return this.mtval | 0;
      case 0x344:
        return this.mip | 0;
      case 0xf11: // mvendorid
      case 0xf12: // marchid
      case 0xf13: // mimpid
      case 0xf14: // mhartid (single hart → 0)
        return 0;
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
      // Machine-mode trap CSRs
      case 0x300: // mstatus — only MIE / MPIE / MPP are writable here
        this.mstatus = v & MSTATUS_WMASK;
        break;
      case 0x304: // mie
        this.mie = v & MIE_WMASK;
        break;
      case 0x305: // mtvec (base + mode in low 2 bits)
        this.mtvec = v;
        break;
      case 0x340:
        this.mscratch = v;
        break;
      case 0x341: // mepc is 2-byte aligned (IALIGN = 16 with C)
        this.mepc = v & ~1;
        break;
      case 0x342:
        this.mcause = v;
        break;
      case 0x343:
        this.mtval = v;
        break;
      // mip.MSIP/MTIP are owned by the CLINT, and misa/mhartid are read-only: ignore writes.
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
