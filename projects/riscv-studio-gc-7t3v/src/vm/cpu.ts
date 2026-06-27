// The RV32IM interpreter.
//
// A `Cpu` owns 32 integer registers, a program counter, and a paged memory. `step()` runs
// exactly one instruction (fetch → decode → execute) and is the single primitive the
// debugger drives; `run()` batches steps with a budget and breakpoint set.

import { Memory } from './memory';
import { decode } from './decode';
import type { DecodedInstruction } from './decode';
import { decompress } from './compressed';
import { handleEcall } from './syscalls';
import { signExtend } from './format';
import {
  GLOBAL_POINTER,
  STACK_TOP,
  DEFAULT_MAX_STEPS,
  CLINT_BASE,
  CLINT_SIZE,
  MSIP_BASE,
  MTIMECMP_LO,
  MTIMECMP_HI,
  MTIME_LO,
  MTIME_HI,
} from './constants';
import type { AssembleResult } from './assembler';
import {
  f32FromBits,
  bitsFromF32,
  f64FromBits,
  bitsFromF64,
  fclass,
  fclassD,
  toI32,
  toU32,
  fminBits,
  fmaxBits,
  fminBitsD,
  fmaxBitsD,
  FFLAG,
  CANONICAL_NAN,
  FP_SPECS,
} from './fp';
import {
  PRIV_U,
  PRIV_S,
  PRIV_M,
  MSTATUS,
  MSTATUS_MASK,
  SSTATUS_MASK,
  S_INT_MASK,
  PAGESIZE,
  PTE,
  CAUSE,
  MIP,
  INT_PRIORITY,
  csrMinPriv,
  csrIsReadOnly,
  decodePte,
  decodeSatp,
  pageFaultCause,
  causeName,
  privName,
} from './mmu';
import type { Access, WalkTrace, WalkLevel } from './mmu';

export type RunStatus = 'idle' | 'paused' | 'halted' | 'error' | 'ebreak';

/** The mip bits software may set/clear by writing `mip` from M-mode. */
const MIP_M_WRITABLE = MIP.SSIP | MIP.STIP | MIP.SEIP;
/** The mip bits software may set/clear by writing `sip` from S-mode (just SSIP). */
const MIP_S_WRITABLE = MIP.SSIP;
/** The mie bits this machine models (all six standard interrupts). */
const MIE_MASK = MIP.SSIP | MIP.MSIP | MIP.STIP | MIP.MTIP | MIP.SEIP | MIP.MEIP;
/** misa: MXL=1 (RV32) + the extensions this machine implements (IMAFDCSU). */
const MISA =
  (1 << 30) | (1 << 0) | (1 << 2) | (1 << 3) | (1 << 5) | (1 << 8) | (1 << 12) | (1 << 18) | (1 << 20);

/** A leaf translation cached in the (incoherent) TLB: the resolved PTE word, its level, and the
 * physical address the PTE was read from (so A/D updates can be written back without re-walking). */
interface TlbEntry {
  pte: number;
  level: number;
  pteAddr: number;
}

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
  // Privilege + trap state (snapshotted whole; cheap, and a trap touches several at once).
  priv: number;
  mstatus: number;
  mie: number;
  mip: number;
  mtvec: number;
  mepc: number;
  mcause: number;
  mtval: number;
  mscratch: number;
  medeleg: number;
  mideleg: number;
  // Supervisor trap CSRs + the satp translation register.
  stvec: number;
  sscratch: number;
  sepc: number;
  scause: number;
  stval: number;
  satp: number;
  mtimecmp: number;
  stimecmp: number;
  reg?: { i: number; prev: number };
  freg?: { i: number; prevLo: number; prevHi: number };
  /** Every memory region this step overwrote (data store + any page-table A/D writeback). */
  mems?: { addr: number; prev: number[] }[];
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
  /**
   * Float registers (FLEN = 64 with RV32D). Each register's raw 64-bit pattern is held as two
   * little-endian halves: `fregs[i]` is the low word, `fregsHi[i]` the high word. A single-
   * precision value is **NaN-boxed** — its 32 bits live in the low word with the high word all
   * ones; reading a register as single yields the canonical NaN unless it is properly boxed.
   */
  readonly fregs = new Uint32Array(32);
  readonly fregsHi = new Uint32Array(32);
  /** Floating-point control & status register: frm = [7:5], fflags = [4:0]. */
  fcsr = 0;

  // --- machine-mode trap CSRs (Zicsr, M-level) -------------------------------
  mstatus = 0;
  mie = 0;
  mip = 0;
  mtvec = 0;
  mepc = 0;
  mcause = 0;
  mtval = 0;
  mscratch = 0;
  /** Trap-delegation registers: which exceptions/interrupts are handled in S-mode. */
  medeleg = 0;
  mideleg = 0;
  /** 64-bit timer compare; the machine timer interrupt fires when `cycles ≥ mtimecmp`. */
  mtimecmp = Number.POSITIVE_INFINITY;
  /**
   * Sstc supervisor timer compare. When finite it *directly* drives `mip.STIP` from the timer
   * (a supervisor timer interrupt with no M-mode mediation); left at +∞ it is disabled and
   * `mip.STIP` stays software-controlled.
   */
  stimecmp = Number.POSITIVE_INFINITY;

  // --- supervisor-mode trap CSRs + virtual memory (Sv32) --------------------
  stvec = 0;
  sscratch = 0;
  sepc = 0;
  scause = 0;
  stval = 0;
  /** Supervisor address translation & protection: MODE[31] | ASID[30:22] | PPN[21:0]. */
  satp = 0;
  /** Current privilege: 3 = Machine, 1 = Supervisor, 0 = User. */
  priv = PRIV_M;
  /** Set when the instruction in flight raised a trap (page fault / ecall / illegal). */
  private faulted = false;

  /**
   * A small, *incoherent* translation cache (VPN → resolved leaf). Like real hardware it is
   * not kept consistent with page-table writes; software must `sfence.vma` (or write `satp`)
   * to flush it. It only ever accelerates an otherwise-pure walk, so it never changes results.
   */
  private tlb = new Map<number, TlbEntry>();
  tlbHits = 0;
  tlbMisses = 0;

  pc = 0;
  entry = 0;
  /** Byte length of the instruction executing this step (2 for RV32C, else 4). */
  private instLen = 4;
  /** When true the RV32D double-precision compressed loads/stores decode (set at load). */
  rvdEnabled = true;
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
    this.fregsHi.fill(0);
    this.fcsr = 0;
    this.mstatus = 0;
    this.mie = 0;
    this.mip = 0;
    this.mtvec = 0;
    this.mepc = 0;
    this.mcause = 0;
    this.mtval = 0;
    this.mscratch = 0;
    this.medeleg = 0;
    this.mideleg = 0;
    this.stvec = 0;
    this.sscratch = 0;
    this.sepc = 0;
    this.scause = 0;
    this.stval = 0;
    this.satp = 0;
    this.priv = PRIV_M;
    this.faulted = false;
    this.flushTlb();
    this.tlbHits = 0;
    this.tlbMisses = 0;
    this.mtimecmp = Number.POSITIVE_INFINITY;
    this.stimecmp = Number.POSITIVE_INFINITY;
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

  /** Snapshot a float register's prior 64-bit value for time-travel (once per step). */
  private recordFreg(i: number): void {
    if (this.rec && !this.rec.freg) this.rec.freg = { i, prevLo: this.fregs[i], prevHi: this.fregsHi[i] };
  }

  /** Write a single-precision result (NaN-boxed: low = bits, high = all ones). */
  private setF(i: number, bits: number): void {
    this.recordFreg(i);
    this.fregs[i] = bits >>> 0;
    this.fregsHi[i] = 0xffff_ffff;
  }

  /** Write a double-precision result from its raw 64-bit halves. */
  private setD(i: number, lo: number, hi: number): void {
    this.recordFreg(i);
    this.fregs[i] = lo >>> 0;
    this.fregsHi[i] = hi >>> 0;
  }

  /** Read a register as a single: the boxed 32-bit pattern, or canonical NaN if not boxed. */
  private singleBits(i: number): number {
    return this.fregsHi[i] === 0xffff_ffff ? this.fregs[i] : CANONICAL_NAN;
  }
  private singleVal(i: number): number {
    return f32FromBits(this.singleBits(i));
  }
  private doubleVal(i: number): number {
    return f64FromBits(this.fregs[i], this.fregsHi[i]);
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
    (this.rec.mems ??= []).push({ addr: addr >>> 0, prev });
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
    this.faulted = false;

    // Service the timer and take any pending, enabled interrupt *before* fetching — a trap
    // is its own step (no instruction retires) so the handler sees the interrupted pc in mepc.
    this.updateTimer();
    const irq = this.pendingInterruptCause();
    if (irq >= 0) {
      this.takeInterrupt(irq);
      if (this.rec) this.commitRecord();
      return true;
    }

    // Translate + fetch the first 16-bit parcel. Under Sv32 this can raise an instruction
    // page fault; the trap is its own step (pc already points at the handler).
    const fpa0 = this.translate(this.pc, 'fetch');
    if (this.faulted) {
      if (this.rec) this.commitRecord();
      return true;
    }
    // Variable-length fetch: a half-word whose low two bits are 0b11 is a 32-bit
    // instruction; anything else is a 16-bit RV32C instruction we decompress in place.
    const half = this.mem.readHalf(fpa0);
    let word: number;
    if ((half & 3) === 3) {
      this.instLen = 4;
      // The upper parcel of a 32-bit instruction may straddle the next page.
      const fpa1 = this.translate((this.pc + 2) >>> 0, 'fetch');
      if (this.faulted) {
        if (this.rec) this.commitRecord();
        return true;
      }
      word = ((half | (this.mem.readHalf(fpa1) << 16)) >>> 0);
      if (word === 0) {
        if (this.trapOrFail(word, 'illegal instruction 0x00000000 (ran off the end of the program?)')) {
          if (this.rec) this.commitRecord();
          return true;
        }
        if (this.rec) this.commitRecord();
        return false;
      }
    } else {
      this.instLen = 2;
      const dc = decompress(half, this.rvdEnabled);
      if (!dc) {
        if (this.trapOrFail(half, `illegal compressed instruction 0x${half.toString(16).padStart(4, '0')}`)) {
          if (this.rec) this.commitRecord();
          return true;
        }
        if (this.rec) this.commitRecord();
        return false;
      }
      word = dc.word;
    }

    const d = decode(word);
    const advanced = this.execute(d);
    this.cycles++;
    if (this.rec) this.commitRecord();
    if (this.isStopped()) return false;
    if (!advanced) this.pc = (this.pc + this.instLen) >>> 0;
    return true;
  }

  // --- traps & interrupts (machine mode) ------------------------------------

  /** Recompute the timer-driven interrupt-pending bits from the free-running timer. */
  private updateTimer(): void {
    if (this.cycles >= this.mtimecmp) this.mip |= MIP.MTIP;
    else this.mip &= ~MIP.MTIP;
    // Sstc: when stimecmp is armed (finite) it owns STIP; otherwise STIP stays software-set.
    if (Number.isFinite(this.stimecmp)) {
      if (this.cycles >= this.stimecmp) this.mip |= MIP.STIP;
      else this.mip &= ~MIP.STIP;
    }
  }

  /** Read the CLINT MMIO window (mtime / mtimecmp), or null if the address is elsewhere. */
  private clintRead(addr: number): number | null {
    if (addr < CLINT_BASE || addr >= CLINT_BASE + CLINT_SIZE) return null;
    const cmp = Number.isFinite(this.mtimecmp) ? this.mtimecmp : 0xffff_ffff_ffff;
    switch (addr) {
      case MSIP_BASE:
        return (this.mip & MIP.MSIP) !== 0 ? 1 : 0;
      case MTIME_LO:
        return this.cycles >>> 0;
      case MTIME_HI:
        return Math.floor(this.cycles / 0x1_0000_0000) >>> 0;
      case MTIMECMP_LO:
        return cmp >>> 0;
      case MTIMECMP_HI:
        return Math.floor(cmp / 0x1_0000_0000) >>> 0;
      default:
        return 0;
    }
  }

  /** Write the CLINT MMIO window (mtimecmp halves). Returns true when the address was the CLINT. */
  private clintWrite(addr: number, value: number): boolean {
    if (addr < CLINT_BASE || addr >= CLINT_BASE + CLINT_SIZE) return false;
    const v = value >>> 0;
    if (addr === MSIP_BASE) {
      // Only bit 0 is implemented; it is the machine software interrupt pending bit.
      if (v & 1) this.mip |= MIP.MSIP;
      else this.mip &= ~MIP.MSIP;
      return true;
    }
    if (addr === MTIMECMP_LO) {
      const hi = Number.isFinite(this.mtimecmp) ? Math.floor(this.mtimecmp / 0x1_0000_0000) : 0;
      this.mtimecmp = hi * 0x1_0000_0000 + v;
    } else if (addr === MTIMECMP_HI) {
      const lo = Number.isFinite(this.mtimecmp) ? this.mtimecmp >>> 0 : 0;
      this.mtimecmp = v * 0x1_0000_0000 + lo;
    }
    this.updateTimer();
    return true;
  }

  /**
   * The highest-priority interrupt that is pending, locally enabled, and globally takeable at the
   * current privilege — or −1 if none. An interrupt with cause `i` targets S-mode when it occurs
   * at privilege ≤ S and `mideleg[i]` is set, otherwise M-mode; it is taken when running *below*
   * the target mode, or *in* the target mode with that mode's global interrupt-enable set. Ties
   * are broken by the spec priority order (external > software > timer; machine > supervisor).
   * (Studio convenience preserved: we require the target's trap vector to be installed, so a plain
   * program that never opts into traps is never disturbed.)
   */
  private pendingInterruptCause(): number {
    const active = this.mip & this.mie;
    if (active === 0) return -1;
    for (const i of INT_PRIORITY) {
      if (((active >>> i) & 1) === 0) continue;
      const deleg = this.priv <= PRIV_S && ((this.mideleg >>> i) & 1) !== 0;
      const target = deleg ? PRIV_S : PRIV_M;
      const tvec = target === PRIV_M ? this.mtvec : this.stvec;
      if (tvec === 0) continue; // no handler installed in the target mode
      let takeable: boolean;
      if (this.priv < target) takeable = true;
      else if (this.priv === target)
        takeable = (this.mstatus & (target === PRIV_M ? MSTATUS.MIE : MSTATUS.SIE)) !== 0;
      else takeable = false; // an interrupt for a lower privilege is held while running higher
      if (takeable) return i;
    }
    return -1;
  }

  /** Take an interrupt, honouring `mideleg` (machine interrupts normally stay in M-mode). */
  private takeInterrupt(cause: number): void {
    const deleg = this.priv <= PRIV_S && ((this.mideleg >>> cause) & 1) !== 0;
    this.enterTrapTo(deleg ? PRIV_S : PRIV_M, true, cause, 0, this.pc);
  }

  /**
   * Raise a synchronous exception. The trap is delegated to S-mode when it occurs at privilege
   * ≤ S and its cause bit is set in `medeleg`; otherwise it goes to M-mode. With no handler
   * installed in the target mode the machine stops with a clear message (preserving the
   * behaviour of plain programs that never opt into traps). Sets `faulted` either way.
   */
  private raiseTrap(cause: number, tval: number, failMsg?: string): void {
    this.faulted = true;
    const deleg = this.priv <= PRIV_S && ((this.medeleg >>> cause) & 1) !== 0;
    const target = deleg ? PRIV_S : PRIV_M;
    const tvec = target === PRIV_S ? this.stvec : this.mtvec;
    if (tvec === 0) {
      this.fail(failMsg ?? `${causeName(cause)} with no ${privName(target)}-mode handler`);
      return;
    }
    this.enterTrapTo(target, false, cause, tval, this.pc);
  }

  /**
   * Enter a trap into the given privilege mode. Interrupts use vectored entry (base + 4·cause)
   * when the relevant tvec's low bits select it; exceptions always go to the base.
   */
  private enterTrapTo(target: number, isInterrupt: boolean, cause: number, tval: number, epc: number): void {
    const code = ((isInterrupt ? 0x8000_0000 : 0) | cause) | 0;
    if (target === PRIV_M) {
      this.mepc = epc >>> 0;
      this.mcause = code;
      this.mtval = tval | 0;
      const ie = this.mstatus & MSTATUS.MIE ? 1 : 0;
      // MPIE ← MIE, MIE ← 0, MPP ← (privilege we are trapping from).
      this.mstatus =
        (this.mstatus & ~(MSTATUS.MIE | MSTATUS.MPIE | MSTATUS.MPP)) | (ie << 7) | (this.priv << 11);
      const base = this.mtvec & ~3;
      this.pc = (isInterrupt && (this.mtvec & 3) === 1 ? base + 4 * cause : base) >>> 0;
      this.priv = PRIV_M;
    } else {
      this.sepc = epc >>> 0;
      this.scause = code;
      this.stval = tval | 0;
      const ie = this.mstatus & MSTATUS.SIE ? 1 : 0;
      // SPIE ← SIE, SIE ← 0, SPP ← (1 if trapping from S, else 0).
      this.mstatus =
        (this.mstatus & ~(MSTATUS.SIE | MSTATUS.SPIE | MSTATUS.SPP)) |
        (ie << 5) |
        (this.priv === PRIV_S ? MSTATUS.SPP : 0);
      const base = this.stvec & ~3;
      this.pc = (isInterrupt && (this.stvec & 3) === 1 ? base + 4 * cause : base) >>> 0;
      this.priv = PRIV_S;
    }
  }

  /** `mret`: restore the interrupt-enable from MPIE and drop to the privilege held in MPP. */
  private mret(): void {
    const mpp = (this.mstatus >>> 11) & 3;
    const mpie = this.mstatus & MSTATUS.MPIE ? 1 : 0;
    this.mstatus = (this.mstatus & ~MSTATUS.MIE) | (mpie << 3);
    this.mstatus = (this.mstatus | MSTATUS.MPIE) & ~MSTATUS.MPP; // MPIE ← 1, MPP ← U
    if (mpp !== PRIV_M) this.mstatus &= ~MSTATUS.MPRV; // returning below M clears MPRV
    this.priv = mpp;
    this.pc = this.mepc >>> 0;
  }

  /** `sret`: the supervisor analogue — restore SIE from SPIE and drop to the mode in SPP. */
  private sret(): void {
    const spp = this.mstatus & MSTATUS.SPP ? 1 : 0;
    const spie = this.mstatus & MSTATUS.SPIE ? 1 : 0;
    this.mstatus = (this.mstatus & ~MSTATUS.SIE) | (spie << 1);
    this.mstatus = (this.mstatus | MSTATUS.SPIE) & ~MSTATUS.SPP; // SPIE ← 1, SPP ← U
    // sret never returns to M-mode (it drops to S or U), so MPRV is always cleared.
    this.mstatus &= ~MSTATUS.MPRV;
    this.priv = spp ? PRIV_S : PRIV_U;
    this.pc = this.sepc >>> 0;
  }

  /**
   * Handle an illegal instruction: trap to a handler if one is installed (or delegated),
   * otherwise fail with `message`. Returns true when it became a trap (pc already set).
   */
  private trapOrFail(raw: number, message: string): boolean {
    this.raiseTrap(CAUSE.ILLEGAL, raw, message);
    return this.status !== 'error';
  }

  // --- Sv32 virtual memory ---------------------------------------------------

  /** Flush the whole TLB (on `sfence.vma`, a `satp` write, reset, or a time-travel step back). */
  flushTlb(): void {
    this.tlb.clear();
  }

  /**
   * Translate a virtual address for the given access kind, returning a physical address, or
   * −1 after raising the appropriate page fault (caller checks `this.faulted`). When paging is
   * inactive for the effective privilege the address is returned unchanged (identity).
   */
  private translate(va: number, access: Access): number {
    // Instruction fetch uses the current privilege; data accesses honour MPRV (M acting as MPP).
    const effPriv =
      access === 'fetch'
        ? this.priv
        : this.mstatus & MSTATUS.MPRV
          ? (this.mstatus >>> 11) & 3
          : this.priv;
    if (effPriv > PRIV_S || ((this.satp >>> 31) & 1) === 0) return va >>> 0; // Bare / M-mode

    const vpn = va >>> 12;
    let leaf = this.tlb.get(vpn);
    if (leaf === undefined) {
      const w = this.sv32Walk(va, this.satp & 0x3f_ffff, false);
      if (w.fault || !w.leaf) {
        this.tlbMisses++;
        this.raiseTrap(pageFaultCause(access), va);
        return -1;
      }
      leaf = { pte: w.leaf.pte.raw, level: w.leaf.level, pteAddr: w.leaf.pteAddr };
      this.tlb.set(vpn, leaf);
      this.tlbMisses++;
    } else {
      this.tlbHits++;
    }

    const pa = this.composePa(leaf.pte, leaf.level, va, access, effPriv);
    if (pa < 0) {
      this.raiseTrap(pageFaultCause(access), va);
      return -1;
    }
    this.updateAccessedDirty(leaf, access);
    return pa;
  }

  /**
   * Svadu-style hardware management of the **Accessed** and **Dirty** PTE bits: set A on any
   * access and D on a store, writing the updated PTE word back to physical memory. The bits are
   * sticky, so this costs exactly one memory write the first time a page is touched (and is then
   * free), and the cached TLB entry is updated so a later store on the same page doesn't re-walk.
   * The writeback is recorded in the undo journal alongside any data store this same step.
   */
  private updateAccessedDirty(leaf: TlbEntry, access: Access): void {
    let np = leaf.pte | PTE.A;
    if (access === 'store') np |= PTE.D;
    if (np === leaf.pte) return; // already set — nothing to do (the common, steady-state case)
    this.recordMem(leaf.pteAddr, 4);
    this.mem.writeWord(leaf.pteAddr, np);
    leaf.pte = np >>> 0; // keep the TLB copy current so we don't rewrite it next time
  }

  /**
   * Permission-check a resolved leaf PTE for `access` at `effPriv`, and compose the physical
   * address (handling 4 MiB superpages). Returns −1 on any permission / alignment violation.
   */
  private composePa(pteRaw: number, level: number, va: number, access: Access, effPriv: number): number {
    const p = decodePte(pteRaw);
    // R/W/X permission (MXR lets a load read an execute-only page).
    if (access === 'fetch' && !p.x) return -1;
    if (access === 'load' && !(p.r || (p.x && (this.mstatus & MSTATUS.MXR) !== 0))) return -1;
    if (access === 'store' && !p.w) return -1;
    // U/S access rules.
    if (effPriv === PRIV_U && !p.u) return -1;
    if (effPriv === PRIV_S && p.u) {
      if (access === 'fetch') return -1; // S may never execute a user page
      if ((this.mstatus & MSTATUS.SUM) === 0) return -1; // S touches user data only with SUM
    }
    // A level-1 leaf is a 4 MiB superpage; its low PPN field must be zero (aligned).
    if (level === 1 && (p.ppn & 0x3ff) !== 0) return -1;
    const ppn = level === 1 ? ((p.ppn & ~0x3ff) | ((va >>> 12) & 0x3ff)) >>> 0 : p.ppn;
    return ((ppn * PAGESIZE) + (va & 0xfff)) >>> 0;
  }

  /** A pure two-level Sv32 walk over physical memory. Reads only; never mutates or traps. */
  private sv32Walk(
    va: number,
    rootPpn: number,
    record: boolean,
  ): {
    levels: WalkLevel[];
    leaf?: { pte: ReturnType<typeof decodePte>; level: number; pteAddr: number };
    fault?: boolean;
  } {
    const levels: WalkLevel[] = [];
    let a = (rootPpn * PAGESIZE) >>> 0;
    for (let i = 1; i >= 0; i--) {
      const vpn = (va >>> (12 + 10 * i)) & 0x3ff;
      const pteAddr = (a + vpn * 4) >>> 0;
      const pte = decodePte(this.mem.readWord(pteAddr));
      if (record) levels.push({ level: i, vpn, pteAddr, pte });
      if (!pte.v || (!pte.r && pte.w)) return { levels, fault: true }; // invalid, or W without R
      if (pte.leaf) return { levels, leaf: { pte, level: i, pteAddr } };
      a = (pte.ppn * PAGESIZE) >>> 0; // a pointer to the next level
    }
    return { levels, fault: true }; // four-byte leaf never found
  }

  /**
   * Probe a virtual address through the page tables without any side effects, returning a full
   * trace for the MMU inspector. Uses the current privilege (and MPRV for data accesses).
   */
  probeTranslate(va: number, access: Access): WalkTrace {
    const sf = decodeSatp(this.satp);
    const effPriv =
      access === 'fetch'
        ? this.priv
        : this.mstatus & MSTATUS.MPRV
          ? (this.mstatus >>> 11) & 3
          : this.priv;
    const trace: WalkTrace = {
      va: va >>> 0,
      access,
      active: effPriv <= PRIV_S && sf.mode === 1,
      vpn1: (va >>> 22) & 0x3ff,
      vpn0: (va >>> 12) & 0x3ff,
      offset: va & 0xfff,
      levels: [],
    };
    if (!trace.active) {
      trace.pa = va >>> 0;
      trace.reason = sf.mode === 0 ? 'Bare mode — virtual address = physical address' : `effective privilege is ${privName(effPriv)} — translation is bypassed`;
      return trace;
    }
    const w = this.sv32Walk(va, sf.ppn, true);
    trace.levels = w.levels;
    if (w.fault || !w.leaf) {
      trace.fault = pageFaultCause(access);
      trace.reason = 'invalid PTE encountered during the walk';
      return trace;
    }
    const pa = this.composePa(w.leaf.pte.raw, w.leaf.level, va, access, effPriv);
    if (pa < 0) {
      trace.fault = pageFaultCause(access);
      trace.reason = `the leaf PTE denies a ${access} at privilege ${privName(effPriv)}`;
      return trace;
    }
    trace.pa = pa;
    trace.reason = w.leaf.level === 1 ? 'resolved via a 4 MiB superpage (level-1 leaf)' : 'resolved via a 4 KiB page';
    return trace;
  }

  /** Snapshot of the current TLB contents, for the inspector. */
  tlbEntries(): { vpn: number; pte: number; level: number }[] {
    return [...this.tlb.entries()]
      .map(([vpn, e]) => ({ vpn, pte: e.pte, level: e.level }))
      .sort((a, b) => a.vpn - b.vpn);
  }

  // --- translating data memory accesses -------------------------------------

  private physLoadWord(pa: number): number {
    const c = this.clintRead(pa);
    return c !== null ? c >>> 0 : this.mem.readWord(pa);
  }
  private physStoreWord(pa: number, value: number): void {
    if (!this.clintWrite(pa, value)) this.storeWord(pa, value);
  }

  /** Load a word from a virtual address (translating, CLINT-aware, page-crossing-safe). */
  private loadW(va: number): number {
    if (((va & 0xfff) + 4) <= 0x1000) {
      const pa = this.translate(va, 'load');
      return pa < 0 ? 0 : this.physLoadWord(pa);
    }
    let r = 0;
    for (let i = 0; i < 4; i++) {
      const b = this.loadB((va + i) >>> 0);
      if (this.faulted) return 0;
      r |= b << (8 * i);
    }
    return r >>> 0;
  }
  private loadH(va: number): number {
    if ((va & 0xfff) <= 0xffe) {
      const pa = this.translate(va, 'load');
      return pa < 0 ? 0 : this.mem.readHalf(pa);
    }
    const lo = this.loadB(va);
    if (this.faulted) return 0;
    const hi = this.loadB((va + 1) >>> 0);
    return this.faulted ? 0 : (lo | (hi << 8)) >>> 0;
  }
  private loadB(va: number): number {
    const pa = this.translate(va, 'load');
    return pa < 0 ? 0 : this.mem.readByte(pa);
  }
  private storeW(va: number, value: number): void {
    if (((va & 0xfff) + 4) <= 0x1000) {
      const pa = this.translate(va, 'store');
      if (pa < 0) return;
      this.physStoreWord(pa, value);
      return;
    }
    for (let i = 0; i < 4; i++) {
      this.storeB((va + i) >>> 0, (value >>> (8 * i)) & 0xff);
      if (this.faulted) return;
    }
  }
  private storeH(va: number, value: number): void {
    if ((va & 0xfff) <= 0xffe) {
      const pa = this.translate(va, 'store');
      if (pa < 0) return;
      this.recordMem(pa, 2);
      this.mem.writeHalf(pa, value & 0xffff);
      return;
    }
    this.storeB(va, value & 0xff);
    if (this.faulted) return;
    this.storeB((va + 1) >>> 0, (value >>> 8) & 0xff);
  }
  private storeB(va: number, value: number): void {
    const pa = this.translate(va, 'store');
    if (pa < 0) return;
    this.recordMem(pa, 1);
    this.mem.writeByte(pa, value & 0xff);
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
      priv: this.priv,
      mstatus: this.mstatus,
      mie: this.mie,
      mip: this.mip,
      mtvec: this.mtvec,
      mepc: this.mepc,
      mcause: this.mcause,
      mtval: this.mtval,
      mscratch: this.mscratch,
      medeleg: this.medeleg,
      mideleg: this.mideleg,
      stvec: this.stvec,
      sscratch: this.sscratch,
      sepc: this.sepc,
      scause: this.scause,
      stval: this.stval,
      satp: this.satp,
      mtimecmp: this.mtimecmp,
      stimecmp: this.stimecmp,
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
    if (u.freg) {
      this.fregs[u.freg.i] = u.freg.prevLo >>> 0;
      this.fregsHi[u.freg.i] = u.freg.prevHi >>> 0;
    }
    // Restore memory writes newest-first, so overlapping regions revert to their true prior bytes.
    if (u.mems)
      for (let m = u.mems.length - 1; m >= 0; m--) {
        const w = u.mems[m];
        for (let i = 0; i < w.prev.length; i++) this.mem.writeByte(w.addr + i, w.prev[i]);
      }
    this.pc = u.pc >>> 0;
    this.cycles = u.cycles;
    this.status = u.status;
    this.error = u.error;
    this.exitCode = u.exitCode;
    this.reservation = u.reservation;
    this.heapPtr = u.heapPtr;
    this.fcsr = u.fcsr;
    this.priv = u.priv;
    this.mstatus = u.mstatus;
    this.mie = u.mie;
    this.mip = u.mip;
    this.mtvec = u.mtvec;
    this.mepc = u.mepc;
    this.mcause = u.mcause;
    this.mtval = u.mtval;
    this.mscratch = u.mscratch;
    this.medeleg = u.medeleg;
    this.mideleg = u.mideleg;
    this.stvec = u.stvec;
    this.sscratch = u.sscratch;
    this.sepc = u.sepc;
    this.scause = u.scause;
    this.stval = u.stval;
    this.satp = u.satp;
    this.mtimecmp = u.mtimecmp;
    this.stimecmp = u.stimecmp;
    // The TLB is just a cache of the (now-restored) page tables; drop it and let it re-fill.
    this.flushTlb();
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
        this.set(rd, (this.pc + this.instLen) | 0);
        this.pc = (this.pc + imm) >>> 0;
        return true;
      case 'jalr': {
        const target = ((a + imm) & ~1) >>> 0;
        this.set(rd, (this.pc + this.instLen) | 0);
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
      case 'lb': {
        const v = this.loadB((a + imm) >>> 0);
        if (this.faulted) return true;
        this.set(rd, signExtend(v, 8));
        return false;
      }
      case 'lh': {
        const v = this.loadH((a + imm) >>> 0);
        if (this.faulted) return true;
        this.set(rd, signExtend(v, 16));
        return false;
      }
      case 'lw': {
        const v = this.loadW((a + imm) >>> 0);
        if (this.faulted) return true;
        this.set(rd, v | 0);
        return false;
      }
      case 'lbu': {
        const v = this.loadB((a + imm) >>> 0);
        if (this.faulted) return true;
        this.set(rd, v);
        return false;
      }
      case 'lhu': {
        const v = this.loadH((a + imm) >>> 0);
        if (this.faulted) return true;
        this.set(rd, v);
        return false;
      }

      // ---- stores -----------------------------------------------------
      case 'sb':
        this.storeB((a + imm) >>> 0, b & 0xff);
        return this.faulted;
      case 'sh':
        this.storeH((a + imm) >>> 0, b & 0xffff);
        return this.faulted;
      case 'sw':
        this.storeW((a + imm) >>> 0, b);
        return this.faulted;

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
        // From M-mode the "environment" is the studio runtime itself, so an ecall is a host
        // syscall (the RARS ABI). From S/U it is a real environment-call *exception*, letting an
        // operating system implement its own syscall layer via the trap handler.
        if (this.priv === PRIV_M) {
          const r = handleEcall(this);
          if (r === 'halt' && this.status !== 'error') this.status = 'halted';
          return false;
        }
        this.raiseTrap(this.priv === PRIV_S ? CAUSE.ECALL_S : CAUSE.ECALL_U, 0);
        return true;
      }
      case 'ebreak':
        this.status = 'ebreak';
        return false;
      case 'mret':
        if (this.priv < PRIV_M) return this.trapOrFail(d.raw, 'mret executed outside machine mode');
        this.mret();
        return true;
      case 'sret':
        if (this.priv < PRIV_S) return this.trapOrFail(d.raw, 'sret executed outside supervisor mode');
        if (this.priv === PRIV_S && this.mstatus & MSTATUS.TSR)
          return this.trapOrFail(d.raw, 'sret trapped by mstatus.TSR');
        this.sret();
        return true;
      case 'sfence.vma':
        if (this.priv < PRIV_S) return this.trapOrFail(d.raw, 'sfence.vma executed outside supervisor mode');
        if (this.priv === PRIV_S && this.mstatus & MSTATUS.TVM)
          return this.trapOrFail(d.raw, 'sfence.vma trapped by mstatus.TVM');
        this.flushTlb();
        return false;
      case 'wfi':
        // Single-hart: a no-op (the timer keeps ticking). mstatus.TW traps it below M-mode.
        if (this.priv < PRIV_M && this.mstatus & MSTATUS.TW)
          return this.trapOrFail(d.raw, 'wfi trapped by mstatus.TW');
        return false;
      case 'fence':
        return false;

      default:
        return this.trapOrFail(
          d.raw,
          `illegal / unimplemented instruction (0x${d.raw.toString(16).padStart(8, '0')})`,
        );
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
    // Double-precision (RV32D) forms — and the two cross-precision conversions — get their
    // own path; everything else is single-precision (RV32F) with NaN-boxing-aware reads.
    const m = d.mnemonic;
    const spec = FP_SPECS[m];
    if (spec?.dbl || m === 'fcvt.s.d') {
      return this.executeFpDouble(d);
    }

    const fa = this.singleBits(d.rs1);
    const fb = this.singleBits(d.rs2);
    const a = f32FromBits(fa);
    const b = f32FromBits(fb);

    switch (m) {
      case 'flw': {
        const v = this.loadW((this.get(d.rs1) + d.imm) >>> 0);
        if (this.faulted) return true;
        this.setF(d.rd, v);
        return false;
      }
      case 'fsw':
        this.storeW((this.get(d.rs1) + d.imm) >>> 0, this.fregs[d.rs2]);
        return this.faulted;

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
        this.set(d.rd, this.fregs[d.rs1] | 0); // raw low 32 bits, no boxing check
        return false;
      case 'fmv.w.x':
        this.setF(d.rd, this.get(d.rs1) >>> 0);
        return false;
      case 'fclass.s':
        this.set(d.rd, fclass(fa));
        return false;

      case 'fmadd.s':
        this.setF(d.rd, bitsFromF32(a * b + this.singleVal(d.rs3)));
        return false;
      case 'fmsub.s':
        this.setF(d.rd, bitsFromF32(a * b - this.singleVal(d.rs3)));
        return false;
      case 'fnmsub.s':
        this.setF(d.rd, bitsFromF32(-(a * b) + this.singleVal(d.rs3)));
        return false;
      case 'fnmadd.s':
        this.setF(d.rd, bitsFromF32(-(a * b) - this.singleVal(d.rs3)));
        return false;

      default:
        return this.trapOrFail(
          d.raw,
          `illegal / unimplemented FP instruction (0x${d.raw.toString(16).padStart(8, '0')})`,
        );
    }
  }

  // ---- RV32D: double-precision floating point (NaN-boxed FLEN = 64) ---------

  private setDfromF64(i: number, x: number): void {
    const { lo, hi } = bitsFromF64(x);
    this.setD(i, lo, hi);
  }

  private executeFpDouble(d: DecodedInstruction): boolean {
    const a = this.doubleVal(d.rs1);
    const b = this.doubleVal(d.rs2);
    const aLo = this.fregs[d.rs1];
    const aHi = this.fregsHi[d.rs1];
    const bHi = this.fregsHi[d.rs2];

    switch (d.mnemonic) {
      case 'fld': {
        const addr = (this.get(d.rs1) + d.imm) >>> 0;
        const lo = this.loadW(addr);
        if (this.faulted) return true;
        const hi = this.loadW((addr + 4) >>> 0);
        if (this.faulted) return true;
        this.setD(d.rd, lo, hi);
        return false;
      }
      case 'fsd': {
        const addr = (this.get(d.rs1) + d.imm) >>> 0;
        this.storeW(addr, this.fregs[d.rs2]);
        if (this.faulted) return true;
        this.storeW((addr + 4) >>> 0, this.fregsHi[d.rs2]);
        return this.faulted;
      }

      case 'fadd.d':
        this.setDfromF64(d.rd, a + b);
        return false;
      case 'fsub.d':
        this.setDfromF64(d.rd, a - b);
        return false;
      case 'fmul.d':
        this.setDfromF64(d.rd, a * b);
        return false;
      case 'fdiv.d':
        if (b === 0 && !Number.isNaN(a)) this.flag(FFLAG.DZ);
        this.setDfromF64(d.rd, a / b);
        return false;
      case 'fsqrt.d':
        if (a < 0) this.flag(FFLAG.NV);
        this.setDfromF64(d.rd, Math.sqrt(a));
        return false;

      case 'fsgnj.d':
        this.setD(d.rd, aLo, (aHi & 0x7fff_ffff) | (bHi & 0x8000_0000));
        return false;
      case 'fsgnjn.d':
        this.setD(d.rd, aLo, (aHi & 0x7fff_ffff) | (~bHi & 0x8000_0000));
        return false;
      case 'fsgnjx.d':
        this.setD(d.rd, aLo, aHi ^ (bHi & 0x8000_0000));
        return false;

      case 'fmin.d': {
        const r = fminBitsD(aLo, aHi, this.fregs[d.rs2], bHi);
        if (r.invalid) this.flag(FFLAG.NV);
        this.setD(d.rd, r.lo, r.hi);
        return false;
      }
      case 'fmax.d': {
        const r = fmaxBitsD(aLo, aHi, this.fregs[d.rs2], bHi);
        if (r.invalid) this.flag(FFLAG.NV);
        this.setD(d.rd, r.lo, r.hi);
        return false;
      }

      case 'feq.d':
        this.set(d.rd, a === b ? 1 : 0);
        return false;
      case 'flt.d':
        if (Number.isNaN(a) || Number.isNaN(b)) this.flag(FFLAG.NV);
        this.set(d.rd, a < b ? 1 : 0);
        return false;
      case 'fle.d':
        if (Number.isNaN(a) || Number.isNaN(b)) this.flag(FFLAG.NV);
        this.set(d.rd, a <= b ? 1 : 0);
        return false;

      case 'fcvt.w.d': {
        const r = toI32(a, this.rmOf(d));
        if (r.invalid) this.flag(FFLAG.NV);
        this.set(d.rd, r.value);
        return false;
      }
      case 'fcvt.wu.d': {
        const r = toU32(a, this.rmOf(d));
        if (r.invalid) this.flag(FFLAG.NV);
        this.set(d.rd, r.value);
        return false;
      }
      case 'fcvt.d.w':
        this.setDfromF64(d.rd, this.get(d.rs1) | 0);
        return false;
      case 'fcvt.d.wu':
        this.setDfromF64(d.rd, this.get(d.rs1) >>> 0);
        return false;

      case 'fcvt.s.d':
        // Narrow double → single (NaN-boxed result).
        this.setF(d.rd, bitsFromF32(a));
        return false;
      case 'fcvt.d.s':
        // Widen single → double (read rs1 as a single, exact).
        this.setDfromF64(d.rd, this.singleVal(d.rs1));
        return false;

      case 'fclass.d':
        this.set(d.rd, fclassD(aLo, aHi));
        return false;

      case 'fmadd.d':
        this.setDfromF64(d.rd, a * b + this.doubleVal(d.rs3));
        return false;
      case 'fmsub.d':
        this.setDfromF64(d.rd, a * b - this.doubleVal(d.rs3));
        return false;
      case 'fnmsub.d':
        this.setDfromF64(d.rd, -(a * b) + this.doubleVal(d.rs3));
        return false;
      case 'fnmadd.d':
        this.setDfromF64(d.rd, -(a * b) - this.doubleVal(d.rs3));
        return false;

      default:
        return this.trapOrFail(
          d.raw,
          `illegal / unimplemented FP instruction (0x${d.raw.toString(16).padStart(8, '0')})`,
        );
    }
  }

  // ---- RV32A: atomic memory operations (single-hart, so trivially atomic) ---

  private executeAmo(d: DecodedInstruction): boolean {
    const va = this.get(d.rs1) >>> 0;
    if (va & 3) {
      this.fail(`misaligned atomic access at 0x${va.toString(16)}`);
      return false;
    }
    // Atomics translate through the MMU like any other access (LR is a load; the rest write).
    const addr = this.translate(va, d.mnemonic === 'lr.w' ? 'load' : 'store');
    if (this.faulted) return true;
    if (d.mnemonic === 'lr.w') {
      this.set(d.rd, this.physLoadWord(addr) | 0);
      this.reservation = addr;
      return false;
    }
    if (d.mnemonic === 'sc.w') {
      // Success only if the reservation is still held for this exact address.
      if (this.reservation === addr) {
        this.physStoreWord(addr, this.get(d.rs2));
        this.set(d.rd, 0); // 0 = success
      } else {
        this.set(d.rd, 1); // 1 = failure
      }
      this.reservation = -1;
      return false;
    }

    // amo*: atomically load, combine with rs2, store back, return the old value in rd.
    const old = this.physLoadWord(addr) | 0;
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
    this.physStoreWord(addr, result);
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
      // --- supervisor-mode trap CSRs (aliases project onto the machine state) ---
      case 0x100:
        return this.mstatus & SSTATUS_MASK; // sstatus
      case 0x104:
        return this.mie & S_INT_MASK; // sie
      case 0x105:
        return this.stvec | 0;
      case 0x140:
        return this.sscratch | 0;
      case 0x141:
        return this.sepc | 0;
      case 0x142:
        return this.scause | 0;
      case 0x143:
        return this.stval | 0;
      case 0x144:
        this.updateTimer();
        return this.mip & S_INT_MASK; // sip
      case 0x14d: // stimecmp (Sstc) — low word
        return Number.isFinite(this.stimecmp) ? this.stimecmp >>> 0 : 0xffff_ffff;
      case 0x15d: // stimecmph (Sstc) — high word
        return Number.isFinite(this.stimecmp) ? Math.floor(this.stimecmp / 0x1_0000_0000) >>> 0 : 0xffff_ffff;
      case 0x180:
        return this.satp | 0;
      // --- machine-mode trap CSRs ---
      case 0x300:
        return this.mstatus | 0;
      case 0x301:
        return MISA | 0;
      case 0x302:
        return this.medeleg | 0;
      case 0x303:
        return this.mideleg | 0;
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
        this.updateTimer();
        return this.mip | 0;
      case 0xf14:
        return 0; // mhartid
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
      // --- supervisor-mode trap CSRs ---
      case 0x100: // sstatus — only the S-visible bits change; the rest of mstatus is preserved
        this.mstatus = (this.mstatus & ~SSTATUS_MASK) | (v & SSTATUS_MASK);
        break;
      case 0x104: // sie — the supervisor-visible interrupt-enable bits of mie
        this.mie = (this.mie & ~S_INT_MASK) | (v & S_INT_MASK);
        break;
      case 0x105:
        this.stvec = v | 0;
        break;
      case 0x140:
        this.sscratch = v | 0;
        break;
      case 0x141:
        this.sepc = v & ~1;
        break;
      case 0x142:
        this.scause = v | 0;
        break;
      case 0x143:
        this.stval = v | 0;
        break;
      case 0x144: // sip — S-mode may set/clear only its own software-interrupt pending bit
        this.mip = (this.mip & ~MIP_S_WRITABLE) | (v & MIP_S_WRITABLE);
        break;
      case 0x14d: {
        // stimecmp (Sstc) low word — arming a finite compare puts STIP under the timer's control.
        const hi = Number.isFinite(this.stimecmp) ? Math.floor(this.stimecmp / 0x1_0000_0000) : 0;
        this.stimecmp = hi * 0x1_0000_0000 + v;
        this.updateTimer();
        break;
      }
      case 0x15d: {
        const lo = Number.isFinite(this.stimecmp) ? this.stimecmp >>> 0 : 0;
        this.stimecmp = v * 0x1_0000_0000 + lo;
        this.updateTimer();
        break;
      }
      case 0x180:
        this.satp = v | 0; // changing the address space invalidates cached translations
        this.flushTlb();
        break;
      // --- machine-mode trap CSRs ---
      case 0x300:
        this.mstatus = v & MSTATUS_MASK;
        break;
      case 0x302:
        this.medeleg = v | 0;
        break;
      case 0x303:
        this.mideleg = v | 0;
        break;
      case 0x304:
        this.mie = v & MIE_MASK;
        break;
      case 0x305:
        this.mtvec = v | 0;
        break;
      case 0x340:
        this.mscratch = v | 0;
        break;
      case 0x341:
        this.mepc = v & ~1; // IALIGN: instruction addresses are 2-byte aligned
        break;
      case 0x342:
        this.mcause = v | 0;
        break;
      case 0x343:
        this.mtval = v | 0;
        break;
      case 0x344:
        // mip — the hardware-driven bits (MSIP/MTIP/MEIP) are read-only; software may set the
        // supervisor-injected pending bits (SSIP/STIP/SEIP).
        this.mip = (this.mip & ~MIP_M_WRITABLE) | (v & MIP_M_WRITABLE);
        break;
      default:
        break; // counters / read-only / unknown CSRs ignore writes
    }
  }

  private executeCsr(d: DecodedInstruction): boolean {
    const addr = d.imm & 0xfff;
    const m = d.mnemonic;
    // Does this access actually write the CSR? csrrw/csrrwi always do; the set/clear forms write
    // only with a nonzero source operand (so `csrr` = `csrrs rd, csr, x0` is a pure read).
    const writes =
      m === 'csrrw' || m === 'csrrwi' || ((m === 'csrrs' || m === 'csrrc') && d.rs1 !== 0) ||
      ((m === 'csrrsi' || m === 'csrrci') && (d.rs1 & 0x1f) !== 0);
    // --- CSR access protection (privilege, writability, trap-virtualization) ---
    if (this.priv < csrMinPriv(addr))
      return this.trapOrFail(d.raw, `CSR access at ${privName(this.priv)}-mode below required ${privName(csrMinPriv(addr))}-mode`);
    if (writes && csrIsReadOnly(addr))
      return this.trapOrFail(d.raw, `write to read-only CSR 0x${addr.toString(16)}`);
    if (addr === 0x180 && this.priv === PRIV_S && this.mstatus & MSTATUS.TVM)
      return this.trapOrFail(d.raw, 'satp access trapped by mstatus.TVM');

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
