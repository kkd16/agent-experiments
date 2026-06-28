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
  f64FromBits,
  bitsFromF64,
  fclass,
  fclass64,
  toI32,
  toU32,
  fminBits,
  fmaxBits,
  fminBits64,
  fmaxBits64,
  fmaD,
  isNanBoxed,
  NANBOX_HI,
  CANONICAL_NAN,
  FFLAG,
} from './fp';
import {
  ACCESS_FETCH,
  ACCESS_LOAD,
  ACCESS_STORE,
  PAGE_FAULT_CAUSE,
  PAGE_SIZE,
  PRIV_M,
  PRIV_S,
  PRIV_U,
  PTE_A,
  PTE_D,
  PTE_FLAGS_MASK,
  PTE_R,
  PTE_U,
  PTE_V,
  PTE_W,
  PTE_X,
  PageFault,
  SATP_MODE_SV32,
  satpMode,
  satpRootPpn,
  vpn,
} from './mmu';
import type { Access, TlbEntry, TranslationStep, TranslationTrace } from './mmu';
import {
  VLENB,
  VREG_COUNT,
  VCSR,
  VTYPE_VILL,
  decodeVtype,
  vlmaxOf,
  vmemSpec,
  VEC_SPECS,
} from './vector';
import type { VType } from './vector';

export type RunStatus = 'idle' | 'paused' | 'halted' | 'error' | 'ebreak';

/**
 * One retired instruction, as seen by an optional performance tracer. This is the *only* seam
 * the microarchitecture timing model (`src/perf/`) uses: the functional interpreter stays the
 * single source of truth, and the timing layer is a pure function of this real dynamic stream.
 * The hook is null on the live debugging/run path (zero cost) and is attached only by the
 * analyzer's throwaway CPU.
 */
export interface RetireEvent {
  /** Address of the retired instruction. */
  pc: number;
  /** Encoded length in bytes (2 for a compressed op, 4 otherwise). */
  size: number;
  raw: number;
  mnemonic: string;
  format: import('./decode').DecodedFormat;
  rd: number;
  rs1: number;
  rs2: number;
  rs3: number;
  /** `regs[rs1]` captured *before* execution — the base for an effective address. */
  base: number;
  imm: number;
  /** The pc after this instruction retires (its target when it is a taken transfer). */
  nextPc: number;
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
  /** Snapshot of the privileged trap + CLINT + paging state (changes most steps via mtime). */
  priv: number[];
  reg?: { i: number; prev: number };
  freg?: { i: number; prevLo: number; prevHi: number };
  /**
   * Bytes overwritten this step, oldest first. A single instruction can now touch memory more
   * than once — a paged store updates the datum *and* the PTE's A/D bits — so this is a list.
   */
  mem: { addr: number; prev: number[] }[];
  /**
   * Vector-register bytes overwritten this step, oldest first. A vector op can write a whole
   * register group, so this records the exact `vregs` byte ranges it touched for time-travel.
   */
  vmem: { off: number; prev: number[] }[];
}

const SP = 2;
const GP = 3;

// mstatus field bit positions (the privileged interrupt-enable / paging-control register).
const MSTATUS_SIE = 1 << 1; // supervisor interrupt-enable
const MSTATUS_MIE = 1 << 3; // machine interrupt-enable
const MSTATUS_SPIE = 1 << 5; // prior SIE, stacked on an S-mode trap
const MSTATUS_MPIE = 1 << 7; // prior MIE, stacked on an M-mode trap
const MSTATUS_SPP = 1 << 8; // S-mode previous privilege (0 = U, 1 = S)
const MSTATUS_MPP = 3 << 11; // M-mode previous privilege (2 bits: 0=U, 1=S, 3=M)
const MSTATUS_MPP_SHIFT = 11;
const MSTATUS_MPRV = 1 << 17; // modify-privilege: M-mode loads/stores use MPP's translation
const MSTATUS_SUM = 1 << 18; // permit S-mode access to U-marked pages
const MSTATUS_MXR = 1 << 19; // make eXecutable pages Readable

// mie/mip interrupt bit positions (S- and M-level software / timer / external).
const IRQ_SSI = 1 << 1; // supervisor software interrupt
const IRQ_MSI = 1 << 3; // machine software interrupt
const IRQ_STI = 1 << 5; // supervisor timer interrupt
const IRQ_MTI = 1 << 7; // machine timer interrupt
const IRQ_SEI = 1 << 9; // supervisor external interrupt
const IRQ_MEI = 1 << 11; // machine external interrupt
/** The S-level interrupt bits — the slice visible through `sie`/`sip` and delegatable. */
const S_INTS = IRQ_SSI | IRQ_STI | IRQ_SEI;

// Which mstatus bits each privilege level may write.
const MSTATUS_WMASK =
  MSTATUS_SIE | MSTATUS_MIE | MSTATUS_SPIE | MSTATUS_MPIE | MSTATUS_SPP | MSTATUS_MPP |
  MSTATUS_MPRV | MSTATUS_SUM | MSTATUS_MXR;
/** The subset of mstatus that is also visible/writable as `sstatus`. */
const SSTATUS_MASK = MSTATUS_SIE | MSTATUS_SPIE | MSTATUS_SPP | MSTATUS_SUM | MSTATUS_MXR;
const MIE_WMASK = IRQ_SSI | IRQ_MSI | IRQ_STI | IRQ_MTI | IRQ_SEI | IRQ_MEI;
/** Software-writable mip bits (the S-level pendings; M timer/soft are owned by the CLINT). */
const MIP_SWMASK = IRQ_SSI | IRQ_STI | IRQ_SEI;
/** medeleg/mideleg are WARL; allow delegating any of the 16 standard causes / S-interrupts. */
const MEDELEG_WMASK = 0x0000_ffff;
const MIDELEG_WMASK = S_INTS;

// Synchronous exception causes.
const EXC_ILLEGAL = 2;
const EXC_BREAKPOINT = 3;

// RV32IMAFDC + S + U misa: MXL=1 (bits 31:30) + extension bits A,C,D,F,I,M,S,U.
const MISA_RV32 =
  0x4000_0000 |
  (1 << 0) | // A
  (1 << 2) | // C
  (1 << 3) | // D (double-precision float)
  (1 << 5) | // F
  (1 << 8) | // I
  (1 << 12) | // M
  (1 << 18) | // S (supervisor mode)
  (1 << 20); // U (user mode)

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

// ---------------------------------------------------------------------------
// Bit-manipulation (Zb*) primitives — pure 32-bit functions used by the executor.
// ---------------------------------------------------------------------------

/** Population count of a 32-bit word (the classic SWAR popcount). */
function popcount32(v: number): number {
  let x = v >>> 0;
  x = x - ((x >>> 1) & 0x5555_5555);
  x = (x & 0x3333_3333) + ((x >>> 2) & 0x3333_3333);
  x = (x + (x >>> 4)) & 0x0f0f_0f0f;
  return (Math.imul(x, 0x0101_0101) >>> 24) & 0x3f;
}

/** Rotate left / right by `s` (0..31); a zero shift is the identity (avoids the `>>>32` trap). */
function rotl32(a: number, s: number): number {
  return s === 0 ? a | 0 : ((a << s) | (a >>> (32 - s))) | 0;
}
function rotr32(a: number, s: number): number {
  return s === 0 ? a | 0 : ((a >>> s) | (a << (32 - s))) | 0;
}

/** orc.b — each output byte is 0xFF if the matching input byte is non-zero, else 0x00. */
function orcb(a: number): number {
  let r = 0;
  for (let i = 0; i < 4; i++) {
    if (((a >>> (i * 8)) & 0xff) !== 0) r |= 0xff << (i * 8);
  }
  return r | 0;
}

/** rev8 — reverse the byte order of a 32-bit word (an endianness swap). */
function byteReverse(a: number): number {
  return (
    (((a >>> 24) & 0xff) | (((a >>> 16) & 0xff) << 8) | (((a >>> 8) & 0xff) << 16) | ((a & 0xff) << 24)) | 0
  );
}

/** Carry-less product low word (clmul): XOR-accumulate rs1<<i for every set bit i of rs2. */
function clmul(a: number, b: number): number {
  const A = a >>> 0;
  let lo = 0;
  for (let i = 0; i < 32; i++) {
    if ((b >>> i) & 1) lo ^= A << i;
  }
  return lo | 0;
}
/** Carry-less product high word (clmulh): the bits that fall past bit 31. */
function clmulh(a: number, b: number): number {
  const A = a >>> 0;
  let hi = 0;
  for (let i = 1; i < 32; i++) {
    if ((b >>> i) & 1) hi ^= A >>> (32 - i);
  }
  return hi | 0;
}
/** Reversed carry-less product (clmulr): output bit i ^= rs1 >> (31 - i) for each set bit of rs2. */
function clmulr(a: number, b: number): number {
  const A = a >>> 0;
  let r = 0;
  for (let i = 0; i < 32; i++) {
    if ((b >>> i) & 1) r ^= A >>> (31 - i);
  }
  return r | 0;
}

export class Cpu {
  readonly regs = new Int32Array(32);
  /**
   * Floating-point register file (FLEN = 64, RV32D). Each register is a raw 64-bit pattern split
   * across two parallel word arrays: `fregs` holds bits [31:0], `fregsHi` holds bits [63:32]. A
   * single-precision value is **NaN-boxed** — its 32 bits live in `fregs[i]` with `fregsHi[i]` set
   * to all-ones — so `fregs[i]` still reads a single's pattern for external consumers, while a
   * double occupies both words. Every write goes through `writeFreg` for time-travel.
   */
  readonly fregs = new Uint32Array(32);
  readonly fregsHi = new Uint32Array(32);
  /** Floating-point control & status register: frm = [7:5], fflags = [4:0]. */
  fcsr = 0;
  /** RV32V vector register file: 32 registers × VLENB bytes, stored as a flat little-endian heap. */
  readonly vregs = new Uint8Array(VREG_COUNT * VLENB);
  /** Vector type (SEW/LMUL/ta/ma/vill) set by the most recent `vset*`. */
  vtype = VTYPE_VILL; // reset state is "no valid configuration"
  /** Active vector length (elements) the next vector op will process. */
  vl = 0;
  /** Element index a vector op resumes from (always 0 in this deterministic core). */
  vstart = 0;
  /** Fixed-point saturation flag (vxsat) and rounding mode (vxrm) — tracked, mostly unused. */
  vxsat = 0;
  vxrm = 0;
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
  medeleg = 0; // exception delegation: causes routed to S-mode
  mideleg = 0; // interrupt delegation: interrupts routed to S-mode

  // --- supervisor-mode trap state + the Sv32 MMU ----------------------------
  /** Current privilege ring: U=0, S=1, M=3. Resets to machine mode. */
  priv = PRIV_M;
  stvec = 0; // S-mode trap-vector base (+ mode in the low 2 bits)
  sepc = 0; // pc saved on an S-mode trap
  scause = 0; // S-mode trap cause (top bit = interrupt)
  stval = 0; // S-mode faulting value
  sscratch = 0; // S-mode scratch word
  /** Supervisor address translation & protection: MODE | ASID | root-table PPN. */
  satp = 0;
  /** Translation-lookaside buffer: virtual-page-number → cached leaf translation. */
  private tlb = new Map<number, TlbEntry>();

  // --- CLINT (memory-mapped timer + software interrupt) ---------------------
  /** Monotonic time; ticks once per retired instruction so timers are deterministic. */
  mtime = 0;
  /** Timer compare; a timer interrupt is pending while mtime ≥ mtimecmp. */
  mtimecmp = MTIMECMP_NEVER;
  /** Software-interrupt pending bit (CLINT msip register). */
  msip = 0;

  // --- time-travel: a bounded, per-instruction undo journal -----------------
  /**
   * Optional performance tracer: invoked once per retired instruction. Null on the live path
   * (so there is no overhead and no behavioural change); the `src/perf/` analyzer attaches one
   * to a throwaway CPU to capture the dynamic instruction stream for its timing model.
   */
  tracer: ((e: RetireEvent) => void) | null = null;

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
    this.vregs.fill(0);
    this.vtype = VTYPE_VILL;
    this.vl = 0;
    this.vstart = 0;
    this.vxsat = 0;
    this.vxrm = 0;
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
    this.medeleg = 0;
    this.mideleg = 0;
    this.priv = PRIV_M;
    this.stvec = 0;
    this.sepc = 0;
    this.scause = 0;
    this.stval = 0;
    this.sscratch = 0;
    this.satp = 0;
    this.tlb.clear();
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

  /** Write a 64-bit float register (low + high word), logging the prior value for time-travel. */
  private writeFreg(i: number, lo: number, hi: number): void {
    if (this.rec) this.rec.freg = { i, prevLo: this.fregs[i], prevHi: this.fregsHi[i] };
    this.fregs[i] = lo >>> 0;
    this.fregsHi[i] = hi >>> 0;
  }

  // --- Typed f-register accessors. Single reads are NaN-box checked; single writes re-box. ---

  /** Raw single-precision bits of `f[i]`, or the canonical NaN when the value isn't NaN-boxed. */
  private singleBits(i: number): number {
    return isNanBoxed(this.fregsHi[i]) ? this.fregs[i] >>> 0 : CANONICAL_NAN;
  }
  /** `f[i]` as a single-precision JS number (NaN when improperly boxed). */
  private singleVal(i: number): number {
    return f32FromBits(this.singleBits(i));
  }
  /** `f[i]` as a double-precision JS number. */
  private doubleVal(i: number): number {
    return f64FromBits(this.fregs[i], this.fregsHi[i]);
  }
  /** Write a NaN-boxed single (raw bits). */
  private setSingleBits(i: number, bits: number): void {
    this.writeFreg(i, bits >>> 0, NANBOX_HI);
  }
  /** Write a single from a JS number (rounds to single, then NaN-boxes). */
  private setSingle(i: number, x: number): void {
    this.setSingleBits(i, bitsFromF32(x));
  }
  /** Write a raw 64-bit double pattern. */
  private setDoubleBits(i: number, lo: number, hi: number): void {
    this.writeFreg(i, lo, hi);
  }
  /** Write a double from a JS number. */
  private setDouble(i: number, x: number): void {
    const { lo, hi } = bitsFromF64(x);
    this.writeFreg(i, lo, hi);
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
    this.rec.mem.push({ addr: addr >>> 0, prev });
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

    // Fetch + decode + execute, all under a page-fault guard: any MMU fault during the
    // instruction's address translation unwinds here and is turned into a synchronous trap.
    try {
      const pc0 = this.pc >>> 0;
      // Variable-length fetch: the low 2 bits of the first half-word select 16- vs 32-bit.
      const half = this.fetchHalf(this.pc) & 0xffff;
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
        const word = this.fetchWord(this.pc);
        if (word === 0) {
          return this.fetchFault(0, 'illegal instruction 0x00000000 (ran off the end of the program?)');
        }
        d = decode(word);
        size = 4;
      }

      // Capture the address base before execution (a writeback to rd could clobber rs1).
      const base = this.tracer ? this.regs[d.rs1] : 0;
      const advanced = this.execute(d, size);
      this.cycles++;
      if (this.rec) this.commitRecord();
      if (this.tracer) {
        const nextPc = advanced ? this.pc >>> 0 : (pc0 + size) >>> 0;
        this.tracer({
          pc: pc0, size, raw: d.raw, mnemonic: d.mnemonic, format: d.format,
          rd: d.rd, rs1: d.rs1, rs2: d.rs2, rs3: d.rs3, base, imm: d.imm, nextPc,
        });
      }
      if (this.isStopped()) return false;
      if (!advanced) this.pc = (this.pc + size) >>> 0;
      return true;
    } catch (err) {
      if (err instanceof PageFault) {
        const taken = this.trapException(err.cause, err.vaddr, this.pageFaultMessage(err));
        this.cycles++;
        if (this.rec) this.commitRecord();
        return taken;
      }
      throw err;
    }
  }

  private pageFaultMessage(f: PageFault): string {
    const kind = f.cause === 12 ? 'instruction' : f.cause === 13 ? 'load' : 'store/AMO';
    return `${kind} page fault at virtual 0x${(f.vaddr >>> 0).toString(16).padStart(8, '0')}`;
  }

  /** An un-decodable fetch: vector to the trap handler if one is armed, else fail. */
  private fetchFault(badBits: number, message: string): boolean {
    const trapped = this.trapException(EXC_ILLEGAL, badBits, message);
    this.cycles++;
    if (this.rec) this.commitRecord();
    return trapped;
  }

  // --- Sv32 virtual memory --------------------------------------------------

  /** Drop every cached translation (sfence.vma, satp writes, time-travel rewinds). */
  flushTlb(): void {
    this.tlb.clear();
  }

  /** Effective privilege for a data access: MPRV redirects M-mode loads/stores through MPP. */
  private effPriv(access: Access): number {
    if (access !== ACCESS_FETCH && this.priv === PRIV_M && this.mstatus & MSTATUS_MPRV) {
      return (this.mstatus & MSTATUS_MPP) >>> MSTATUS_MPP_SHIFT;
    }
    return this.priv;
  }

  /** Is paging active for `access` right now? (Bare satp or M-effective-priv ⇒ identity.) */
  private pagingOn(access: Access): boolean {
    return satpMode(this.satp) === SATP_MODE_SV32 && this.effPriv(access) !== PRIV_M;
  }

  /**
   * Translate a virtual address to physical for `access`, walking the Sv32 page table (cached
   * by the TLB), enforcing permissions and updating the A/D bits. Throws `PageFault` on a fault.
   * Identity when paging is off, so Bare-mode programs pay only a single branch per access.
   */
  translate(vaddr: number, access: Access): number {
    vaddr = vaddr >>> 0;
    if (!this.pagingOn(access)) return vaddr;
    const key = vaddr >>> 12;
    let e = this.tlb.get(key);
    if (!e) {
      e = this.walk(vaddr, access);
      this.tlb.set(key, e);
    }
    this.checkPerms(e, access, this.effPriv(access), vaddr);
    this.updateAD(e, access);
    if (e.level === 1) {
      // 4 MiB megapage: frame = ppn1, the low 22 bits pass through from the virtual address.
      return (e.ppn1 * 0x40_0000 + (vaddr & 0x3f_ffff)) >>> 0;
    }
    return (e.ppn * PAGE_SIZE + (vaddr & 0xfff)) >>> 0;
  }

  /** The two-level Sv32 page-table walk. Returns the leaf; throws on a structurally bad walk. */
  private walk(vaddr: number, access: Access): TlbEntry {
    let a = satpRootPpn(this.satp) * PAGE_SIZE;
    for (let level = 1; level >= 0; level--) {
      const pteAddr = (a + vpn(vaddr, level) * 4) >>> 0;
      const pte = this.mem.readWord(pteAddr) >>> 0;
      // Not valid, or the reserved write-without-read encoding (R=0, W=1) → fault.
      if (!(pte & PTE_V) || (!(pte & PTE_R) && pte & PTE_W)) this.pageFault(access, vaddr);
      const ppn0 = (pte >>> 10) & 0x3ff;
      const ppn1 = (pte >>> 20) & 0xfff;
      if (pte & (PTE_R | PTE_X)) {
        // A leaf. A megapage (found at level 1) must have a zero low PPN or it is misaligned.
        if (level === 1 && ppn0 !== 0) this.pageFault(access, vaddr);
        return { ppn: ppn1 * 0x400 + ppn0, ppn1, level, flags: pte & PTE_FLAGS_MASK, pteAddr };
      }
      // A pointer to the next level: descend.
      a = (ppn1 * 0x400 + ppn0) * PAGE_SIZE;
    }
    return this.pageFault(access, vaddr);
  }

  private pageFault(access: Access, vaddr: number): never {
    throw new PageFault(PAGE_FAULT_CAUSE[access], vaddr >>> 0);
  }

  /** Per-access permission check against the cached PTE flags + live priv / SUM / MXR. */
  private checkPerms(e: TlbEntry, access: Access, priv: number, vaddr: number): void {
    const f = e.flags;
    // MXR lets a load read an execute-only page.
    const readable = f & PTE_R || (this.mstatus & MSTATUS_MXR && f & PTE_X);
    if (access === ACCESS_FETCH && !(f & PTE_X)) this.pageFault(access, vaddr);
    if (access === ACCESS_LOAD && !readable) this.pageFault(access, vaddr);
    if (access === ACCESS_STORE && !(f & PTE_W)) this.pageFault(access, vaddr);
    const user = (f & PTE_U) !== 0;
    if (priv === PRIV_U && !user) this.pageFault(access, vaddr);
    if (priv === PRIV_S && user) {
      // S-mode may touch U pages only as data, and only when SUM is set; never as instructions.
      if (access === ACCESS_FETCH || !(this.mstatus & MSTATUS_SUM)) this.pageFault(access, vaddr);
    }
  }

  /** Hardware page-table A/D management: set Accessed on any touch, Dirty on a store. */
  private updateAD(e: TlbEntry, access: Access): void {
    const pte = this.mem.readWord(e.pteAddr) >>> 0;
    let nf = pte | PTE_A;
    if (access === ACCESS_STORE) nf |= PTE_D;
    if (nf !== pte) {
      this.recordMem(e.pteAddr, 4);
      this.mem.writeWord(e.pteAddr, nf);
      e.flags = nf & PTE_FLAGS_MASK;
    }
  }

  /**
   * A read-only Sv32 walk for the inspector: visits the same PTEs as `translate` but never sets
   * A/D, never throws, and never consults the TLB — purely for visualising what an address maps
   * to right now. `access` only affects the reported fault cause and the effective privilege.
   */
  explainTranslation(vaddr: number, access: Access = ACCESS_LOAD): TranslationTrace {
    vaddr = vaddr >>> 0;
    const effPriv = this.effPriv(access);
    const steps: TranslationStep[] = [];
    if (!this.pagingOn(access)) {
      return { vaddr, paging: false, effPriv, steps, physical: vaddr, fault: null };
    }
    const fault = (): TranslationTrace => ({
      vaddr,
      paging: true,
      effPriv,
      steps,
      physical: null,
      fault: PAGE_FAULT_CAUSE[access],
    });
    let a = satpRootPpn(this.satp) * PAGE_SIZE;
    for (let level = 1; level >= 0; level--) {
      const pteAddr = (a + vpn(vaddr, level) * 4) >>> 0;
      const pte = this.mem.readWord(pteAddr) >>> 0;
      const valid = !!(pte & PTE_V) && !(!(pte & PTE_R) && pte & PTE_W);
      const leaf = !!(pte & (PTE_R | PTE_X));
      steps.push({ level, pteAddr, pte, kind: !valid ? 'invalid' : leaf ? 'leaf' : 'pointer' });
      if (!valid) return fault();
      const ppn0 = (pte >>> 10) & 0x3ff;
      const ppn1 = (pte >>> 20) & 0xfff;
      if (leaf) {
        if (level === 1 && ppn0 !== 0) return fault();
        const physical =
          level === 1
            ? (ppn1 * 0x40_0000 + (vaddr & 0x3f_ffff)) >>> 0
            : ((ppn1 * 0x400 + ppn0) * PAGE_SIZE + (vaddr & 0xfff)) >>> 0;
        return { vaddr, paging: true, effPriv, steps, physical, fault: null };
      }
      a = (ppn1 * 0x400 + ppn0) * PAGE_SIZE;
    }
    return fault();
  }

  // ---- translated memory access (the load/store path goes through these) ----

  /** Virtual load of `size` bytes (1/2/4) → little-endian value, via translation + CLINT. */
  private vmLoad(vaddr: number, size: number, access: Access = ACCESS_LOAD): number {
    vaddr = vaddr >>> 0;
    // Fast path: the whole access lies in one page (always true when paging is off).
    if ((vaddr & 0xfff) + size <= PAGE_SIZE) {
      return this.physLoad(this.translate(vaddr, access), size);
    }
    // Rare page-crossing unaligned access: translate + read byte by byte.
    let v = 0;
    for (let i = 0; i < size; i++) {
      v |= this.mem.readByte(this.translate((vaddr + i) >>> 0, access)) << (8 * i);
    }
    return v >>> 0;
  }

  /** Virtual store of `size` bytes; records overwritten bytes for time-travel. */
  private vmStore(vaddr: number, size: number, value: number): void {
    vaddr = vaddr >>> 0;
    if ((vaddr & 0xfff) + size <= PAGE_SIZE) {
      this.physStore(this.translate(vaddr, ACCESS_STORE), size, value);
      return;
    }
    // Page-crossing: translate every byte first so a fault on any of them writes nothing.
    const pas: number[] = [];
    for (let i = 0; i < size; i++) pas.push(this.translate((vaddr + i) >>> 0, ACCESS_STORE));
    for (let i = 0; i < size; i++) {
      this.recordMem(pas[i], 1);
      this.mem.writeByte(pas[i], (value >>> (8 * i)) & 0xff);
    }
  }

  private physLoad(pa: number, size: number): number {
    if (size === 4) return this.readWordIO(pa) >>> 0;
    if (size === 2) return this.mem.readHalf(pa);
    return this.mem.readByte(pa);
  }

  private physStore(pa: number, size: number, value: number): void {
    if (size === 4) {
      if (!this.writeWordIO(pa, value)) this.storeWord(pa, value);
      return;
    }
    this.recordMem(pa, size);
    if (size === 2) this.mem.writeHalf(pa, value & 0xffff);
    else this.mem.writeByte(pa, value & 0xff);
  }

  /** Translate + read a 16-bit instruction parcel (pc is 2-byte aligned ⇒ never page-crosses). */
  private fetchHalf(vaddr: number): number {
    return this.vmLoad(vaddr, 2, ACCESS_FETCH);
  }

  /** Translate + read a 32-bit instruction as two parcels, so a page-straddling op faults right. */
  private fetchWord(vaddr: number): number {
    const lo = this.vmLoad(vaddr, 2, ACCESS_FETCH);
    const hi = this.vmLoad((vaddr + 2) >>> 0, 2, ACCESS_FETCH);
    return (lo | (hi << 16)) >>> 0;
  }

  // --- traps & interrupts (M / S, with delegation) --------------------------

  /** Advance mtime and recompute the timer/software interrupt-pending bits. */
  private tickClint(): void {
    this.mtime += 1;
    if (this.mtime >= this.mtimecmp) this.mip |= IRQ_MTI;
    else this.mip &= ~IRQ_MTI;
    if (this.msip & 1) this.mip |= IRQ_MSI;
    else this.mip &= ~IRQ_MSI;
  }

  /** Which ring handles this trap, honouring delegation (and never below the current ring). */
  private trapTarget(cause: number, isInterrupt: boolean): number {
    const deleg = isInterrupt ? this.mideleg : this.medeleg;
    if (this.priv <= PRIV_S && (deleg & (1 << cause)) !== 0) return PRIV_S;
    return PRIV_M;
  }

  /** Take the highest-priority enabled+pending interrupt, if any. Returns true if taken. */
  private takeInterruptIfPending(): boolean {
    const pending = this.mip & this.mie;
    if (pending === 0) return false;
    // Standard fixed priority: external > software > timer, machine level over supervisor.
    const order: readonly [number, number][] = [
      [IRQ_MEI, 11], [IRQ_MSI, 3], [IRQ_MTI, 7], [IRQ_SEI, 9], [IRQ_SSI, 1], [IRQ_STI, 5],
    ];
    for (const [bit, cause] of order) {
      if (!(pending & bit)) continue;
      const target = this.trapTarget(cause, true);
      // Globally enabled when targeting a higher ring than current, or the same ring with its
      // interrupt-enable set. A trap is never delivered to a lower ring than the current one.
      const enabled =
        target === PRIV_M
          ? this.priv < PRIV_M || (this.priv === PRIV_M && (this.mstatus & MSTATUS_MIE) !== 0)
          : this.priv < PRIV_S || (this.priv === PRIV_S && (this.mstatus & MSTATUS_SIE) !== 0);
      if (!enabled) continue;
      const armed = target === PRIV_M ? this.mtvec >>> 0 : this.stvec >>> 0;
      if (armed === 0) continue;
      this.enterTrap(cause, 0, true, this.pc, target);
      return true;
    }
    return false;
  }

  /** Save state and vector to the chosen ring's trap handler. */
  private enterTrap(cause: number, tval: number, isInterrupt: boolean, epc: number, target: number): void {
    const causeWord = ((isInterrupt ? 0x8000_0000 : 0) | (cause & 0x7fff_ffff)) | 0;
    if (target === PRIV_S) {
      this.sepc = epc >>> 0;
      this.scause = causeWord;
      this.stval = tval | 0;
      // Stack the supervisor interrupt-enable: SPIE ← SIE, SIE ← 0, SPP ← (was S ? S : U).
      const sie = this.mstatus & MSTATUS_SIE ? MSTATUS_SPIE : 0;
      this.mstatus = (this.mstatus & ~(MSTATUS_SPIE | MSTATUS_SIE | MSTATUS_SPP)) | sie;
      if (this.priv === PRIV_S) this.mstatus |= MSTATUS_SPP;
      this.priv = PRIV_S;
      const base = this.stvec & ~0x3;
      const vectored = (this.stvec & 0x3) === 1;
      this.pc = (isInterrupt && vectored ? base + 4 * cause : base) >>> 0;
    } else {
      this.mepc = epc >>> 0;
      this.mcause = causeWord;
      this.mtval = tval | 0;
      // Stack the machine interrupt-enable: MPIE ← MIE, MIE ← 0, MPP ← current privilege.
      const mie = this.mstatus & MSTATUS_MIE ? MSTATUS_MPIE : 0;
      this.mstatus = (this.mstatus & ~(MSTATUS_MPIE | MSTATUS_MIE | MSTATUS_MPP)) | mie;
      this.mstatus |= (this.priv << MSTATUS_MPP_SHIFT) & MSTATUS_MPP;
      this.priv = PRIV_M;
      const base = this.mtvec & ~0x3;
      const vectored = (this.mtvec & 0x3) === 1;
      this.pc = (isInterrupt && vectored ? base + 4 * cause : base) >>> 0;
    }
  }

  /** Take a synchronous exception: vector to the right ring's handler, or fail if none armed. */
  private trapException(cause: number, tval: number, message: string): boolean {
    const target = this.trapTarget(cause, false);
    const armed = target === PRIV_M ? this.mtvec >>> 0 : this.stvec >>> 0;
    if (armed === 0) {
      this.fail(message);
      return false;
    }
    this.enterTrap(cause, tval, false, this.pc, target);
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
      priv: this.snapshotPriv(),
      mem: [],
      vmem: [],
    };
  }

  /** Snapshot the bytes a vector write is about to overwrite, then write them. */
  private vWriteByte(off: number, value: number): void {
    if (this.rec) {
      this.rec.vmem.push({ off, prev: [this.vregs[off]] });
    }
    this.vregs[off] = value & 0xff;
  }

  /** Bundle the privileged trap + CLINT + paging registers for the undo journal. */
  private snapshotPriv(): number[] {
    return [
      this.mstatus, this.mie, this.mip, this.mtvec, this.mepc, this.mcause,
      this.mtval, this.mscratch, this.mtime, this.mtimecmp, this.msip,
      this.medeleg, this.mideleg, this.priv, this.stvec, this.sepc, this.scause,
      this.stval, this.sscratch, this.satp,
      this.vtype, this.vl, this.vstart, this.vxsat, this.vxrm,
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
    this.medeleg = p[11];
    this.mideleg = p[12];
    this.priv = p[13];
    this.stvec = p[14];
    this.sepc = p[15];
    this.scause = p[16];
    this.stval = p[17];
    this.sscratch = p[18];
    this.satp = p[19];
    this.vtype = p[20] >>> 0;
    this.vl = p[21];
    this.vstart = p[22];
    this.vxsat = p[23];
    this.vxrm = p[24];
    // Translations may have changed under us; drop the cache so a re-step re-walks.
    this.tlb.clear();
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
    // Undo writes newest-first so overlapping ranges restore to the exact prior bytes.
    for (let m = u.mem.length - 1; m >= 0; m--) {
      const w = u.mem[m];
      for (let i = 0; i < w.prev.length; i++) this.mem.writeByte(w.addr + i, w.prev[i]);
    }
    // Vector-register bytes, likewise newest-first.
    for (let m = u.vmem.length - 1; m >= 0; m--) {
      const w = u.vmem[m];
      for (let i = 0; i < w.prev.length; i++) this.vregs[w.off + i] = w.prev[i];
    }
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
    if (d.format === 'V') return this.executeVector(d);
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

      // ---- loads (all go through the MMU; identity-mapped when paging is off) ----
      case 'lb':
        this.set(rd, signExtend(this.vmLoad((a + imm) >>> 0, 1), 8));
        return false;
      case 'lh':
        this.set(rd, signExtend(this.vmLoad((a + imm) >>> 0, 2), 16));
        return false;
      case 'lw':
        this.set(rd, this.vmLoad((a + imm) >>> 0, 4) | 0);
        return false;
      case 'lbu':
        this.set(rd, this.vmLoad((a + imm) >>> 0, 1));
        return false;
      case 'lhu':
        this.set(rd, this.vmLoad((a + imm) >>> 0, 2));
        return false;

      // ---- stores -----------------------------------------------------
      case 'sb':
        this.vmStore((a + imm) >>> 0, 1, b);
        return false;
      case 'sh':
        this.vmStore((a + imm) >>> 0, 2, b);
        return false;
      case 'sw':
        this.vmStore((a + imm) >>> 0, 4, b);
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

      // ---- Zba: shift-and-add address generation ----------------------
      case 'sh1add':
        this.set(rd, ((a << 1) + b) | 0);
        return false;
      case 'sh2add':
        this.set(rd, ((a << 2) + b) | 0);
        return false;
      case 'sh3add':
        this.set(rd, ((a << 3) + b) | 0);
        return false;

      // ---- Zbb: logical with negate -----------------------------------
      case 'andn':
        this.set(rd, a & ~b);
        return false;
      case 'orn':
        this.set(rd, a | ~b);
        return false;
      case 'xnor':
        this.set(rd, ~(a ^ b));
        return false;

      // ---- Zbb: integer min / max -------------------------------------
      case 'min':
        this.set(rd, a < b ? a : b);
        return false;
      case 'max':
        this.set(rd, a > b ? a : b);
        return false;
      case 'minu':
        this.set(rd, (a >>> 0) < (b >>> 0) ? a : b);
        return false;
      case 'maxu':
        this.set(rd, (a >>> 0) > (b >>> 0) ? a : b);
        return false;

      // ---- Zbb: bit counting + sign/zero extension --------------------
      case 'clz':
        this.set(rd, Math.clz32(a));
        return false;
      case 'ctz':
        this.set(rd, a === 0 ? 32 : 31 - Math.clz32(a & -a));
        return false;
      case 'cpop':
        this.set(rd, popcount32(a));
        return false;
      case 'sext.b':
        this.set(rd, signExtend(a & 0xff, 8));
        return false;
      case 'sext.h':
        this.set(rd, signExtend(a & 0xffff, 16));
        return false;
      case 'zext.h':
        this.set(rd, a & 0xffff);
        return false;

      // ---- Zbb: rotate ------------------------------------------------
      case 'rol':
        this.set(rd, rotl32(a, b & 31));
        return false;
      case 'ror':
        this.set(rd, rotr32(a, b & 31));
        return false;
      case 'rori':
        // The rotate amount sits in the shift-immediate (rs2) field, like slli/srli.
        this.set(rd, rotr32(a, rs2 & 31));
        return false;

      // ---- Zbb: byte combine / reverse --------------------------------
      case 'orc.b':
        this.set(rd, orcb(a));
        return false;
      case 'rev8':
        this.set(rd, byteReverse(a));
        return false;

      // ---- Zbc: carry-less multiply -----------------------------------
      case 'clmul':
        this.set(rd, clmul(a, b));
        return false;
      case 'clmulh':
        this.set(rd, clmulh(a, b));
        return false;
      case 'clmulr':
        this.set(rd, clmulr(a, b));
        return false;

      // ---- Zbs: single-bit set / clear / invert / extract -------------
      case 'bset':
        this.set(rd, a | (1 << (b & 31)));
        return false;
      case 'bseti':
        this.set(rd, a | (1 << (rs2 & 31)));
        return false;
      case 'bclr':
        this.set(rd, a & ~(1 << (b & 31)));
        return false;
      case 'bclri':
        this.set(rd, a & ~(1 << (rs2 & 31)));
        return false;
      case 'binv':
        this.set(rd, a ^ (1 << (b & 31)));
        return false;
      case 'binvi':
        this.set(rd, a ^ (1 << (rs2 & 31)));
        return false;
      case 'bext':
        this.set(rd, (a >>> (b & 31)) & 1);
        return false;
      case 'bexti':
        this.set(rd, (a >>> (rs2 & 31)) & 1);
        return false;

      // ---- system -----------------------------------------------------
      case 'ecall': {
        // ecall cause depends on the calling ring (U=8, S=9, M=11). When a U/S program runs
        // under an armed handler, ecall is a real environment-call trap the OS intercepts;
        // otherwise it is the studio's RARS-style syscall ABI (used by M-mode programs).
        const cause = this.priv === PRIV_U ? 8 : this.priv === PRIV_S ? 9 : 11;
        const target = this.trapTarget(cause, false);
        const armed = target === PRIV_M ? this.mtvec >>> 0 : this.stvec >>> 0;
        if (this.priv !== PRIV_M && armed !== 0) {
          this.enterTrap(cause, 0, false, this.pc, target);
          return true;
        }
        const r = handleEcall(this);
        if (r === 'halt' && this.status !== 'error') this.status = 'halted';
        return false;
      }
      case 'ebreak': {
        // With a handler armed, ebreak is a synchronous breakpoint trap; otherwise it pauses.
        const target = this.trapTarget(EXC_BREAKPOINT, false);
        const armed = target === PRIV_M ? this.mtvec >>> 0 : this.stvec >>> 0;
        if (armed !== 0) {
          this.enterTrap(EXC_BREAKPOINT, this.pc, false, this.pc, target);
          return true;
        }
        this.status = 'ebreak';
        return false;
      }
      case 'fence':
        return false;
      case 'sfence.vma':
        // Fence the address-translation cache. (Operands are accepted but we flush wholesale —
        // a correct over-approximation.) Illegal below supervisor mode.
        if (this.priv < PRIV_S) return this.trapException(EXC_ILLEGAL, d.raw, 'sfence.vma requires S-mode');
        this.flushTlb();
        return false;

      // ---- privileged trap return / hint ------------------------------
      case 'mret': {
        if (this.priv < PRIV_M) return this.trapException(EXC_ILLEGAL, d.raw, 'mret requires M-mode');
        // Pop the machine interrupt-enable stack and restore the saved privilege.
        const mpp = (this.mstatus & MSTATUS_MPP) >>> MSTATUS_MPP_SHIFT;
        const mpie = this.mstatus & MSTATUS_MPIE ? MSTATUS_MIE : 0;
        this.mstatus = ((this.mstatus & ~MSTATUS_MIE) | mpie) | MSTATUS_MPIE;
        this.mstatus &= ~MSTATUS_MPP; // MPP ← U (the least-privileged ring we support)
        if (mpp !== PRIV_M) this.mstatus &= ~MSTATUS_MPRV; // returning below M clears MPRV
        this.priv = mpp;
        this.pc = this.mepc >>> 0;
        return true;
      }
      case 'sret': {
        if (this.priv < PRIV_S) return this.trapException(EXC_ILLEGAL, d.raw, 'sret requires S-mode');
        // Pop the supervisor interrupt-enable stack and restore the saved privilege.
        const spp = this.mstatus & MSTATUS_SPP ? PRIV_S : PRIV_U;
        const spie = this.mstatus & MSTATUS_SPIE ? MSTATUS_SIE : 0;
        this.mstatus = ((this.mstatus & ~MSTATUS_SIE) | spie) | MSTATUS_SPIE;
        this.mstatus &= ~MSTATUS_SPP; // SPP ← U
        if (spp !== PRIV_M) this.mstatus &= ~MSTATUS_MPRV;
        this.priv = spp;
        this.pc = this.sepc >>> 0;
        return true;
      }
      case 'wfi':
        // Deterministic model: just retire; the timer keeps ticking, so any armed interrupt
        // arrives on a subsequent step.
        return false;

      default:
        return this.trapException(
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
    // Single-precision operands are NaN-box checked; an improperly-boxed register reads as NaN.
    const fa = this.singleBits(d.rs1);
    const fb = this.singleBits(d.rs2);
    const a = f32FromBits(fa);
    const b = f32FromBits(fb);

    switch (d.mnemonic) {
      // ---- loads / stores --------------------------------------------------
      case 'flw':
        this.setSingleBits(d.rd, this.vmLoad((this.get(d.rs1) + d.imm) >>> 0, 4));
        return false;
      case 'fsw':
        this.vmStore((this.get(d.rs1) + d.imm) >>> 0, 4, this.fregs[d.rs2]);
        return false;
      case 'fld': {
        // A 64-bit load is an aligned pair of word loads (low word first, little-endian).
        const addr = (this.get(d.rs1) + d.imm) >>> 0;
        const lo = this.vmLoad(addr, 4);
        const hi = this.vmLoad((addr + 4) >>> 0, 4);
        this.setDoubleBits(d.rd, lo, hi);
        return false;
      }
      case 'fsd': {
        const addr = (this.get(d.rs1) + d.imm) >>> 0;
        this.vmStore(addr, 4, this.fregs[d.rs2]);
        this.vmStore((addr + 4) >>> 0, 4, this.fregsHi[d.rs2]);
        return false;
      }

      // ---- single-precision arithmetic ------------------------------------
      case 'fadd.s':
        this.setSingle(d.rd, a + b);
        return false;
      case 'fsub.s':
        this.setSingle(d.rd, a - b);
        return false;
      case 'fmul.s':
        this.setSingle(d.rd, a * b);
        return false;
      case 'fdiv.s':
        if (b === 0 && !Number.isNaN(a)) this.flag(FFLAG.DZ);
        this.setSingle(d.rd, a / b);
        return false;
      case 'fsqrt.s':
        if (a < 0) this.flag(FFLAG.NV);
        this.setSingle(d.rd, Math.sqrt(a));
        return false;

      case 'fsgnj.s':
        this.setSingleBits(d.rd, (fa & 0x7fff_ffff) | (fb & 0x8000_0000));
        return false;
      case 'fsgnjn.s':
        this.setSingleBits(d.rd, (fa & 0x7fff_ffff) | (~fb & 0x8000_0000));
        return false;
      case 'fsgnjx.s':
        this.setSingleBits(d.rd, fa ^ (fb & 0x8000_0000));
        return false;

      case 'fmin.s': {
        const r = fminBits(fa, fb);
        if (r.invalid) this.flag(FFLAG.NV);
        this.setSingleBits(d.rd, r.bits);
        return false;
      }
      case 'fmax.s': {
        const r = fmaxBits(fa, fb);
        if (r.invalid) this.flag(FFLAG.NV);
        this.setSingleBits(d.rd, r.bits);
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
        this.setSingle(d.rd, this.get(d.rs1) | 0);
        return false;
      case 'fcvt.s.wu':
        this.setSingle(d.rd, this.get(d.rs1) >>> 0);
        return false;

      case 'fmv.x.w':
        // Moves the low 32 bits verbatim — no NaN-box interpretation.
        this.set(d.rd, this.fregs[d.rs1] | 0);
        return false;
      case 'fmv.w.x':
        this.setSingleBits(d.rd, this.get(d.rs1) >>> 0);
        return false;
      case 'fclass.s':
        this.set(d.rd, fclass(fa));
        return false;

      case 'fmadd.s':
        this.setSingle(d.rd, a * b + this.singleVal(d.rs3));
        return false;
      case 'fmsub.s':
        this.setSingle(d.rd, a * b - this.singleVal(d.rs3));
        return false;
      case 'fnmsub.s':
        this.setSingle(d.rd, -(a * b) + this.singleVal(d.rs3));
        return false;
      case 'fnmadd.s':
        this.setSingle(d.rd, -(a * b) - this.singleVal(d.rs3));
        return false;

      // ---- RV32D: double-precision ----------------------------------------
      default:
        return this.executeFpD(d);
    }
  }

  /** The double-precision (RV32D) opcode set. Split out to keep `executeFp` readable. */
  private executeFpD(d: DecodedInstruction): boolean {
    const da = this.doubleVal(d.rs1);
    const db = this.doubleVal(d.rs2);

    switch (d.mnemonic) {
      case 'fadd.d':
        this.setDouble(d.rd, da + db);
        return false;
      case 'fsub.d':
        this.setDouble(d.rd, da - db);
        return false;
      case 'fmul.d':
        this.setDouble(d.rd, da * db);
        return false;
      case 'fdiv.d':
        if (db === 0 && !Number.isNaN(da)) this.flag(FFLAG.DZ);
        this.setDouble(d.rd, da / db);
        return false;
      case 'fsqrt.d':
        if (da < 0) this.flag(FFLAG.NV);
        this.setDouble(d.rd, Math.sqrt(da));
        return false;

      case 'fsgnj.d':
        this.setDoubleBits(d.rd, this.fregs[d.rs1], (this.fregsHi[d.rs1] & 0x7fff_ffff) | (this.fregsHi[d.rs2] & 0x8000_0000));
        return false;
      case 'fsgnjn.d':
        this.setDoubleBits(d.rd, this.fregs[d.rs1], (this.fregsHi[d.rs1] & 0x7fff_ffff) | (~this.fregsHi[d.rs2] & 0x8000_0000));
        return false;
      case 'fsgnjx.d':
        this.setDoubleBits(d.rd, this.fregs[d.rs1], this.fregsHi[d.rs1] ^ (this.fregsHi[d.rs2] & 0x8000_0000));
        return false;

      case 'fmin.d': {
        const r = fminBits64({ lo: this.fregs[d.rs1], hi: this.fregsHi[d.rs1] }, { lo: this.fregs[d.rs2], hi: this.fregsHi[d.rs2] });
        if (r.invalid) this.flag(FFLAG.NV);
        this.setDoubleBits(d.rd, r.bits.lo, r.bits.hi);
        return false;
      }
      case 'fmax.d': {
        const r = fmaxBits64({ lo: this.fregs[d.rs1], hi: this.fregsHi[d.rs1] }, { lo: this.fregs[d.rs2], hi: this.fregsHi[d.rs2] });
        if (r.invalid) this.flag(FFLAG.NV);
        this.setDoubleBits(d.rd, r.bits.lo, r.bits.hi);
        return false;
      }

      case 'feq.d':
        this.set(d.rd, da === db ? 1 : 0);
        return false;
      case 'flt.d':
        if (Number.isNaN(da) || Number.isNaN(db)) this.flag(FFLAG.NV);
        this.set(d.rd, da < db ? 1 : 0);
        return false;
      case 'fle.d':
        if (Number.isNaN(da) || Number.isNaN(db)) this.flag(FFLAG.NV);
        this.set(d.rd, da <= db ? 1 : 0);
        return false;

      case 'fcvt.w.d': {
        const r = toI32(da, this.rmOf(d));
        if (r.invalid) this.flag(FFLAG.NV);
        this.set(d.rd, r.value);
        return false;
      }
      case 'fcvt.wu.d': {
        const r = toU32(da, this.rmOf(d));
        if (r.invalid) this.flag(FFLAG.NV);
        this.set(d.rd, r.value);
        return false;
      }
      case 'fcvt.d.w':
        this.setDouble(d.rd, this.get(d.rs1) | 0);
        return false;
      case 'fcvt.d.wu':
        this.setDouble(d.rd, this.get(d.rs1) >>> 0);
        return false;

      case 'fcvt.s.d':
        // Narrow double → single (rounds), then NaN-box the single result.
        this.setSingle(d.rd, da);
        return false;
      case 'fcvt.d.s':
        // Widen single → double (exact); reads rs1 with NaN-box checking.
        this.setDouble(d.rd, this.singleVal(d.rs1));
        return false;

      case 'fclass.d':
        this.set(d.rd, fclass64(this.fregs[d.rs1], this.fregsHi[d.rs1]));
        return false;

      case 'fmadd.d':
        this.setDouble(d.rd, fmaD(da, db, this.doubleVal(d.rs3)));
        return false;
      case 'fmsub.d':
        this.setDouble(d.rd, fmaD(da, db, -this.doubleVal(d.rs3)));
        return false;
      case 'fnmsub.d':
        this.setDouble(d.rd, fmaD(-da, db, this.doubleVal(d.rs3)));
        return false;
      case 'fnmadd.d':
        this.setDouble(d.rd, fmaD(-da, db, -this.doubleVal(d.rs3)));
        return false;

      default:
        this.fail(`illegal / unimplemented FP instruction (0x${d.raw.toString(16).padStart(8, '0')})`);
        return false;
    }
  }

  // ---- RV32A: atomic memory operations (single-hart, so trivially atomic) ---

  private executeAmo(d: DecodedInstruction): boolean {
    const va = this.get(d.rs1) >>> 0;
    if (va & 3) {
      this.fail(`misaligned atomic access at 0x${va.toString(16)}`);
      return false;
    }
    // Atomics translate like loads (lr) or stores (sc / amo); the page fault propagates to step().
    if (d.mnemonic === 'lr.w') {
      const pa = this.translate(va, ACCESS_LOAD);
      this.set(d.rd, this.mem.readWord(pa) | 0);
      this.reservation = pa;
      return false;
    }
    if (d.mnemonic === 'sc.w') {
      const pa = this.translate(va, ACCESS_STORE);
      // Success only if the reservation is still held for this exact (physical) address.
      if (this.reservation === pa) {
        this.storeWord(pa, this.get(d.rs2));
        this.set(d.rd, 0); // 0 = success
      } else {
        this.set(d.rd, 1); // 1 = failure
      }
      this.reservation = -1;
      return false;
    }

    // amo*: atomically load, combine with rs2, store back, return the old value in rd.
    const pa = this.translate(va, ACCESS_STORE);
    const old = this.mem.readWord(pa) | 0;
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
    this.storeWord(pa, result);
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
      // Vector CSRs
      case VCSR.vstart:
        return this.vstart | 0;
      case VCSR.vxsat:
        return this.vxsat & 1;
      case VCSR.vxrm:
        return this.vxrm & 3;
      case VCSR.vcsr:
        return ((this.vxrm & 3) << 1) | (this.vxsat & 1); // vcsr = {vxrm[2:1], vxsat[0]}
      case VCSR.vl:
        return this.vl | 0;
      case VCSR.vtype:
        return this.vtype | 0;
      case VCSR.vlenb:
        return VLENB;
      case 0xc00: // cycle
      case 0xc01: // time (mirrors cycle here — deterministic)
      case 0xc02: // instret (one retired per cycle)
        return this.cycles >>> 0;
      case 0xc80:
      case 0xc81:
      case 0xc82:
        return Math.floor(this.cycles / 0x1_0000_0000) >>> 0;
      // Supervisor-mode trap CSRs (sstatus/sie/sip are restricted views of the m-registers)
      case 0x100:
        return this.mstatus & SSTATUS_MASK;
      case 0x104:
        return this.mie & S_INTS;
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
        return this.mip & S_INTS;
      case 0x180:
        return this.satp | 0;
      // Machine-mode trap CSRs
      case 0x300:
        return this.mstatus | 0;
      case 0x301:
        return MISA_RV32 | 0;
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
      // Vector CSRs — vl/vtype/vlenb are read-only (owned by vset*); vstart/vxsat/vxrm/vcsr write.
      case VCSR.vstart:
        this.vstart = v;
        break;
      case VCSR.vxsat:
        this.vxsat = v & 1;
        break;
      case VCSR.vxrm:
        this.vxrm = v & 3;
        break;
      case VCSR.vcsr:
        this.vxsat = v & 1;
        this.vxrm = (v >>> 1) & 3;
        break;
      // Supervisor-mode trap CSRs
      case 0x100: // sstatus — writes only the supervisor-visible bits of mstatus
        this.mstatus = (this.mstatus & ~SSTATUS_MASK) | (v & SSTATUS_MASK);
        break;
      case 0x104: // sie — writes only the supervisor-interrupt bits of mie
        this.mie = (this.mie & ~S_INTS) | (v & S_INTS & MIE_WMASK);
        break;
      case 0x105:
        this.stvec = v;
        break;
      case 0x140:
        this.sscratch = v;
        break;
      case 0x141:
        this.sepc = v & ~1;
        break;
      case 0x142:
        this.scause = v;
        break;
      case 0x143:
        this.stval = v;
        break;
      case 0x144: // sip — only the supervisor software-interrupt pending bit is writable
        this.mip = (this.mip & ~IRQ_SSI) | (v & IRQ_SSI);
        break;
      case 0x180: // satp — changing the translation regime fences the TLB
        this.satp = v;
        this.flushTlb();
        break;
      // Machine-mode trap CSRs
      case 0x300: // mstatus
        this.mstatus = v & MSTATUS_WMASK;
        break;
      case 0x302: // medeleg
        this.medeleg = v & MEDELEG_WMASK;
        break;
      case 0x303: // mideleg
        this.mideleg = v & MIDELEG_WMASK;
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
      case 0x344: // mip — the S-level software/timer/external pendings are software-writable
        this.mip = (this.mip & ~MIP_SWMASK) | (v & MIP_SWMASK);
        break;
      // misa/mhartid are read-only; M timer/soft pendings are owned by the CLINT: ignore writes.
      default:
        break; // counters / unknown CSRs ignore writes
    }
  }

  private executeCsr(d: DecodedInstruction): boolean {
    const addr = d.imm & 0xfff;
    // CSR-address bits [9:8] encode the least-privileged ring allowed to access it.
    const minPriv = (addr >> 8) & 3;
    if (this.priv < minPriv) {
      return this.trapException(
        EXC_ILLEGAL,
        d.raw,
        `CSR 0x${addr.toString(16)} is not accessible from privilege ${this.priv}`,
      );
    }
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

  // ---- RV32V: the vector extension ----------------------------------------
  // The functional vector engine. `vset*` configures `vtype`/`vl`; every other vector op reads
  // those and processes `vl` elements of width SEW, leaving tail + masked-off elements undisturbed
  // (a legal realization of ta/ma "agnostic"). Vector-register writes go through `vWriteByte`, so
  // time-travel reverses a vector instruction exactly.

  /** Read an unsigned `eb`-byte element `idx` of vector register `vreg` (little-endian). */
  private vElemU(vreg: number, idx: number, eb: number): number {
    const off = vreg * VLENB + idx * eb;
    let v = 0;
    for (let k = 0; k < eb; k++) v |= this.vregs[off + k] << (8 * k);
    return v >>> 0;
  }
  /** Read a sign-extended `eb`-byte element. */
  private vElemS(vreg: number, idx: number, eb: number): number {
    return signExtend(this.vElemU(vreg, idx, eb), eb * 8);
  }
  /** Write the low `eb` bytes of `value` into element `idx` of `vreg`. */
  private vSetElem(vreg: number, idx: number, eb: number, value: number): void {
    const off = vreg * VLENB + idx * eb;
    for (let k = 0; k < eb; k++) this.vWriteByte(off + k, (value >>> (8 * k)) & 0xff);
  }
  /** Mask bit `idx` (bit `idx` of register v0). */
  private vMaskBit(idx: number): number {
    return (this.vregs[idx >> 3] >> (idx & 7)) & 1;
  }
  /** Set/clear mask bit `idx` of register `vreg`. */
  private vSetMaskBit(vreg: number, idx: number, bit: number): void {
    const off = vreg * VLENB + (idx >> 3);
    let byte = this.vregs[off];
    if (bit) byte |= 1 << (idx & 7);
    else byte &= ~(1 << (idx & 7));
    this.vWriteByte(off, byte & 0xff);
  }
  /** Snapshot `n` unsigned elements of `vreg` into a JS array (so in-place ops are hazard-free). */
  private readVec(vreg: number, n: number, eb: number): number[] {
    const out = new Array<number>(n);
    for (let i = 0; i < n; i++) out[i] = this.vElemU(vreg, i, eb);
    return out;
  }

  private executeVector(d: DecodedInstruction): boolean {
    const m = d.mnemonic;
    if (m === 'vsetvli' || m === 'vsetivli' || m === 'vsetvl') return this.doVset(d);

    const vt = decodeVtype(this.vtype);
    if (vt.vill) {
      return this.trapException(EXC_ILLEGAL, d.raw, 'vector op with an illegal vtype (run vsetvli first)');
    }

    const mem = vmemSpec(m);
    if (mem) return this.execVMem(d, vt, mem);

    const spec = VEC_SPECS[m];
    if (!spec) return this.trapException(EXC_ILLEGAL, d.raw, `unknown vector instruction '${m}'`);
    this.execVecArith(d, vt, m, spec);
    this.vstart = 0;
    return false;
  }

  private doVset(d: DecodedInstruction): boolean {
    const raw = d.raw;
    let newVtype: number;
    let avl: number;
    let avlIsImm = false;
    let rs1IsZero = false;
    if (d.mnemonic === 'vsetvli') {
      newVtype = (raw >>> 20) & 0x7ff;
      rs1IsZero = d.rs1 === 0;
      avl = this.regs[d.rs1] >>> 0;
    } else if (d.mnemonic === 'vsetivli') {
      newVtype = (raw >>> 20) & 0x3ff;
      avl = d.rs1 & 0x1f;
      avlIsImm = true;
    } else {
      newVtype = this.regs[d.rs2] >>> 0;
      rs1IsZero = d.rs1 === 0;
      avl = this.regs[d.rs1] >>> 0;
    }
    const vt = decodeVtype(newVtype);
    if (vt.vill) {
      this.vtype = VTYPE_VILL;
      this.vl = 0;
      this.set(d.rd, 0);
      this.vstart = 0;
      return false;
    }
    const vlmax = vlmaxOf(vt);
    let newVl: number;
    if (avlIsImm || !rs1IsZero) newVl = Math.min(avl, vlmax);
    else if (d.rd !== 0) newVl = vlmax; // rs1 = x0, rd ≠ x0  → set vl = VLMAX
    else newVl = Math.min(this.vl, vlmax); // rs1 = x0, rd = x0  → keep vl (clamped)
    this.vtype = newVtype;
    this.vl = newVl;
    this.set(d.rd, newVl);
    this.vstart = 0;
    return false;
  }

  private execVMem(d: DecodedInstruction, vt: VType, mem: ReturnType<typeof vmemSpec>): boolean {
    const s = mem!;
    const raw = d.raw;
    const vd = d.rd;
    const vm = (raw >>> 25) & 1;
    const base = this.regs[d.rs1] >>> 0;
    const vl = this.vl;
    const sb = vt.sew / 8;

    if (s.kind === 'mask') {
      const nbytes = Math.ceil(vl / 8); // evl = vl bits, rounded up to whole bytes
      for (let k = 0; k < nbytes; k++) {
        const off = vd * VLENB + k;
        if (s.store) this.vmStore((base + k) >>> 0, 1, this.vregs[off]);
        else this.vWriteByte(off, this.vmLoad((base + k) >>> 0, 1) & 0xff);
      }
      this.vstart = 0;
      return false;
    }

    const eb = s.kind === 'indexed' ? sb : s.eew; // data EEW (= SEW for indexed)
    for (let i = 0; i < vl; i++) {
      if (vm === 0 && this.vMaskBit(i) === 0) continue; // inactive: undisturbed
      let addr: number;
      if (s.kind === 'unit') addr = (base + i * eb) >>> 0;
      else if (s.kind === 'strided') addr = (base + i * (this.regs[d.rs2] | 0)) >>> 0;
      else addr = (base + this.vElemU(d.rs2, i, s.eew)) >>> 0; // indexed: index EEW from mnemonic
      if (s.store) this.vmStore(addr, eb, this.vElemU(vd, i, eb));
      else this.vSetElem(vd, i, eb, this.vmLoad(addr, eb) >>> 0);
    }
    this.vstart = 0;
    return false;
  }

  private execVecArith(d: DecodedInstruction, vt: VType, m: string, spec: typeof VEC_SPECS[string]): void {
    const { form, cat } = spec;
    const sew = vt.sew;
    const sb = sew / 8;
    const vl = this.vl;
    const vd = d.rd;
    const vs2 = d.rs2;
    const vm = (d.raw >>> 25) & 1;
    const maskU = sew === 32 ? 0xffffffff : ((1 << sew) >>> 0) - 1;
    const vlmax = vlmaxOf(vt);
    const OPV_IVV = 0, OPV_MVV = 2; // categories whose 2nd operand is a vector
    const isVec = cat === OPV_IVV || cat === OPV_MVV;

    // Scalar / immediate operands (the second source for the .vx / .vi forms).
    const xRaw = this.regs[d.rs1] | 0; // full XLEN scalar (for x-forms)
    const scalarU = (xRaw >>> 0) & maskU;
    const scalarS = signExtend(scalarU, sew);
    const uimm5 = d.rs1 & 0x1f;
    const simm5 = signExtend(uimm5, 5);
    const isUimmForm = form === 'vviu';
    const immU = (isUimmForm ? uimm5 : simm5 >>> 0) & maskU;
    const immS = isUimmForm ? uimm5 : simm5;

    const bU = (i: number): number =>
      isVec ? this.vElemU(d.rs1, i, sb) : cat === 4 || cat === 6 ? scalarU : immU;
    const bS = (i: number): number =>
      isVec ? this.vElemS(d.rs1, i, sb) : cat === 4 || cat === 6 ? scalarS : immS;
    const active = (i: number): boolean => vm === 1 || this.vMaskBit(i) === 1;
    const lowmul = (x: number, y: number): number => (Math.imul(x, y) >>> 0) & maskU;
    const writeElem = (i: number, v: number): void => this.vSetElem(vd, i, sb, v >>> 0);

    const base = m.slice(0, m.indexOf('.') === -1 ? m.length : m.indexOf('.'));

    // ---- whole-register-domain ops handled before the elementwise loop -----
    switch (m) {
      case 'vmv.x.s':
        this.set(d.rd, this.vElemS(vs2, 0, sb)); // rd ← sign-extended element 0
        return;
      case 'vmv.s.x':
        if (vl > 0) this.vSetElem(vd, 0, sb, scalarU); // element 0 ← x[rs1]
        return;
      case 'vcpop.m': {
        let c = 0;
        for (let i = 0; i < vl; i++) if (active(i) && this.vMaskBit2(vs2, i)) c++;
        this.set(d.rd, c);
        return;
      }
      case 'vfirst.m': {
        let idx = -1;
        for (let i = 0; i < vl; i++) if (active(i) && this.vMaskBit2(vs2, i)) { idx = i; break; }
        this.set(d.rd, idx | 0);
        return;
      }
      case 'vid.v':
        for (let i = 0; i < vl; i++) if (active(i)) writeElem(i, i & maskU);
        return;
      case 'viota.m': {
        let sum = 0;
        for (let i = 0; i < vl; i++) {
          if (active(i)) {
            writeElem(i, sum & maskU);
            if (this.vMaskBit2(vs2, i)) sum++;
          }
        }
        return;
      }
      case 'vmsbf.m':
      case 'vmsif.m':
      case 'vmsof.m': {
        let seen = false;
        for (let i = 0; i < vl; i++) {
          if (!active(i)) continue;
          const src = this.vMaskBit2(vs2, i) === 1;
          let out: number;
          if (m === 'vmsbf.m') out = seen || src ? 0 : 1;
          else if (m === 'vmsif.m') out = seen ? 0 : 1;
          else out = !seen && src ? 1 : 0; // vmsof.m
          this.vSetMaskBit(vd, i, out);
          seen = seen || src;
        }
        return;
      }
    }

    if (form === 'mm') {
      // Mask-register logical: unmasked, one bit per element over [0, vl).
      for (let i = 0; i < vl; i++) {
        const a = this.vMaskBit2(vs2, i);
        const b = this.vMaskBit2(d.rs1, i);
        let r: number;
        switch (m) {
          case 'vmand.mm': r = a & b; break;
          case 'vmnand.mm': r = (a & b) ^ 1; break;
          case 'vmandn.mm': r = a & (b ^ 1); break;
          case 'vmor.mm': r = a | b; break;
          case 'vmnor.mm': r = (a | b) ^ 1; break;
          case 'vmorn.mm': r = a | (b ^ 1); break;
          case 'vmxor.mm': r = a ^ b; break;
          default: r = (a ^ b) ^ 1; break; // vmxnor.mm
        }
        this.vSetMaskBit(vd, i, r & 1);
      }
      return;
    }

    if (form === 'vs') {
      // Reduction: vd[0] = vs1[0] (op) over active vs2 elements. No update when vl = 0.
      if (vl === 0) return;
      const src = this.readVec(vs2, vl, sb);
      const initU = this.vElemU(d.rs1, 0, sb);
      const initS = this.vElemS(d.rs1, 0, sb);
      let accU = initU;
      let accS = initS;
      for (let i = 0; i < vl; i++) {
        if (!active(i)) continue;
        const eU = src[i] >>> 0;
        const eS = signExtend(eU, sew);
        switch (m) {
          case 'vredsum.vs': accU = (accU + eU) & maskU; break;
          case 'vredand.vs': accU = accU & eU; break;
          case 'vredor.vs': accU = accU | eU; break;
          case 'vredxor.vs': accU = accU ^ eU; break;
          case 'vredminu.vs': accU = Math.min(accU >>> 0, eU >>> 0); break;
          case 'vredmaxu.vs': accU = Math.max(accU >>> 0, eU >>> 0); break;
          case 'vredmin.vs': accS = Math.min(accS, eS); break;
          case 'vredmax.vs': accS = Math.max(accS, eS); break;
        }
      }
      const res = m === 'vredmin.vs' || m === 'vredmax.vs' ? accS : accU;
      this.vSetElem(vd, 0, sb, res & maskU);
      return;
    }

    if (base === 'vmerge' || form === 'movv' || form === 'movx' || form === 'movi') {
      // vmerge selects per-mask between vs2 and op2; vmv.v.* copies op2 to every element.
      const isMv = form === 'movv' || form === 'movx' || form === 'movi';
      for (let i = 0; i < vl; i++) {
        let op2: number;
        if (cat === OPV_IVV) op2 = this.vElemU(d.rs1, i, sb);
        else if (cat === 4) op2 = scalarU;
        else op2 = immU;
        const useOp2 = isMv || this.vMaskBit(i) === 1;
        writeElem(i, (useOp2 ? op2 : this.vElemU(vs2, i, sb)) & maskU);
      }
      return;
    }

    if (base === 'vslideup' || base === 'vslidedown' || base === 'vslide1up' || base === 'vslide1down') {
      const src = this.readVec(vs2, vlmax, sb);
      const off = cat === 3 ? uimm5 : this.regs[d.rs1] >>> 0; // .vi offset is the uimm
      for (let i = 0; i < vl; i++) {
        if (!active(i)) continue;
        if (base === 'vslideup') {
          if (i >= off) writeElem(i, src[i - off] & maskU);
        } else if (base === 'vslidedown') {
          const j = i + off;
          writeElem(i, (j < vlmax ? src[j] : 0) & maskU);
        } else if (base === 'vslide1up') {
          writeElem(i, (i === 0 ? scalarU : src[i - 1]) & maskU);
        } else {
          writeElem(i, (i === vl - 1 ? scalarU : src[i + 1]) & maskU);
        }
      }
      return;
    }

    if (base === 'vrgather') {
      const src = this.readVec(vs2, vlmax, sb);
      for (let i = 0; i < vl; i++) {
        if (!active(i)) continue;
        const idx = cat === OPV_IVV ? this.vElemU(d.rs1, i, sb) : cat === 4 ? scalarU : uimm5;
        writeElem(i, (idx < vlmax ? src[idx] : 0) & maskU);
      }
      return;
    }

    // ---- elementwise arithmetic / compares / multiply-accumulate ----------
    const isCompare = base.startsWith('vms') && base !== 'vmsbf' && base !== 'vmsif' && base !== 'vmsof';
    // For mac forms the multiplier source is the s1 field (d.rs1) for .vv, the scalar for .vx.
    const macMul = (i: number): number => (cat === 6 ? scalarU : this.vElemU(d.rs1, i, sb));

    for (let i = 0; i < vl; i++) {
      if (!active(i)) continue;
      const aU = this.vElemU(vs2, i, sb);
      const aS = signExtend(aU, sew);
      const sh = (isVec ? this.vElemU(d.rs1, i, sb) : cat === 4 ? scalarU : uimm5) & (sew - 1);

      if (isCompare) {
        const x = bU(i);
        const xs = bS(i);
        let c = 0;
        switch (base) {
          case 'vmseq': c = aU === x ? 1 : 0; break;
          case 'vmsne': c = aU !== x ? 1 : 0; break;
          case 'vmsltu': c = (aU >>> 0) < (x >>> 0) ? 1 : 0; break;
          case 'vmslt': c = aS < xs ? 1 : 0; break;
          case 'vmsleu': c = (aU >>> 0) <= (x >>> 0) ? 1 : 0; break;
          case 'vmsle': c = aS <= xs ? 1 : 0; break;
          case 'vmsgtu': c = (aU >>> 0) > (x >>> 0) ? 1 : 0; break;
          case 'vmsgt': c = aS > xs ? 1 : 0; break;
        }
        this.vSetMaskBit(vd, i, c);
        continue;
      }

      let r: number;
      switch (base) {
        case 'vadd': r = aU + bU(i); break;
        case 'vsub': r = aU - bU(i); break;
        case 'vrsub': r = bU(i) - aU; break;
        case 'vand': r = aU & bU(i); break;
        case 'vor': r = aU | bU(i); break;
        case 'vxor': r = aU ^ bU(i); break;
        case 'vsll': r = aU << sh; break;
        case 'vsrl': r = aU >>> sh; break;
        case 'vsra': r = aS >> sh; break;
        case 'vminu': r = (aU >>> 0) < (bU(i) >>> 0) ? aU : bU(i); break;
        case 'vmin': r = aS < bS(i) ? aS : bS(i); break;
        case 'vmaxu': r = (aU >>> 0) > (bU(i) >>> 0) ? aU : bU(i); break;
        case 'vmax': r = aS > bS(i) ? aS : bS(i); break;
        case 'vmul': r = lowmul(aU, bU(i)); break;
        case 'vmulhu': r = Number((BigInt(aU >>> 0) * BigInt(bU(i) >>> 0)) >> BigInt(sew)) & maskU; break;
        case 'vmulh': r = Number((BigInt(aS) * BigInt(bS(i))) >> BigInt(sew)) & maskU; break;
        case 'vmulhsu': r = Number((BigInt(aS) * BigInt(bU(i) >>> 0)) >> BigInt(sew)) & maskU; break;
        case 'vdivu': r = (bU(i) >>> 0) === 0 ? maskU : Math.floor((aU >>> 0) / (bU(i) >>> 0)); break;
        case 'vremu': r = (bU(i) >>> 0) === 0 ? aU : (aU >>> 0) % (bU(i) >>> 0); break;
        case 'vdiv':
          r = bS(i) === 0 ? -1 : aS === -(2 ** (sew - 1)) && bS(i) === -1 ? aS : Math.trunc(aS / bS(i));
          break;
        case 'vrem':
          r = bS(i) === 0 ? aS : aS === -(2 ** (sew - 1)) && bS(i) === -1 ? 0 : aS % bS(i);
          break;
        case 'vmacc': r = this.vElemU(vd, i, sb) + lowmul(macMul(i), aU); break;
        case 'vnmsac': r = this.vElemU(vd, i, sb) - lowmul(macMul(i), aU); break;
        case 'vmadd': r = lowmul(macMul(i), this.vElemU(vd, i, sb)) + aU; break;
        case 'vnmsub': r = aU - lowmul(macMul(i), this.vElemU(vd, i, sb)); break;
        default:
          this.trapException(EXC_ILLEGAL, d.raw, `unhandled vector op '${m}'`);
          return;
      }
      writeElem(i, r & maskU);
    }
  }

  /** Mask bit `idx` of an arbitrary mask register `vreg`. */
  private vMaskBit2(vreg: number, idx: number): number {
    return (this.vregs[vreg * VLENB + (idx >> 3)] >> (idx & 7)) & 1;
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
